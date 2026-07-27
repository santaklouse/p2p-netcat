#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import wrtc from '@roamhq/wrtc'
import {
  connectNativeWebRtc,
  signWebRtcAuthResponse,
  startNativeWebRtcListener,
  verifyWebRtcAuthResponse
} from 'p2p-netcat-core'

const SERVICE = 31337
const CONNECTION_TIMEOUT_MS = 15_000
const RECONNECT_TIMEOUT_MS = 15_000
const SIGNALING_TOPIC = 'p2p-netcat-webrtc-soak-v1'
const SERVER_SIGNALING_ID = 'SOAKSERVER0000000001'
const CLIENT_SIGNALING_ID = 'SOAKCLIENT0000000001'
const CHUNK_BYTES = 64 * 1024

const PROFILES = Object.freeze({
  smoke: Object.freeze({ iterations: 1, payloadBytes: 64 * 1024 }),
  ci: Object.freeze({ iterations: 2, payloadBytes: 512 * 1024 }),
  soak: Object.freeze({ iterations: 12, payloadBytes: 8 * 1024 * 1024 })
})

const SCENARIOS = Object.freeze([
  Object.freeze({
    name: 'nostr-trickle',
    adapters: [
      {
        id: 'nostr',
        name: 'Native Nostr',
        trickleIce: true,
        latencyMs: 2,
        jitterMs: 14,
        offerDelayMs: 20
      }
    ]
  }),
  Object.freeze({
    name: 'torrent-full-sdp',
    adapters: [
      {
        id: 'torrent',
        name: 'Native BitTorrent',
        trickleIce: false,
        latencyMs: 3,
        jitterMs: 6
      }
    ]
  }),
  Object.freeze({
    name: 'parallel-race',
    adapters: [
      {
        id: 'nostr',
        name: 'Native Nostr',
        trickleIce: true,
        latencyMs: 2,
        jitterMs: 18,
        offerDelayMs: 16,
        duplicateRate: 1,
        duplicateTypes: ['offer']
      },
      {
        id: 'torrent',
        name: 'Native BitTorrent',
        trickleIce: false,
        latencyMs: 6,
        jitterMs: 8,
        duplicateRate: 1,
        duplicateTypes: ['offer']
      }
    ]
  }),
  Object.freeze({
    name: 'adapter-outage',
    adapters: [
      {
        id: 'nostr-offline',
        name: 'Native Nostr offline',
        trickleIce: true,
        available: false
      },
      {
        id: 'torrent',
        name: 'Native BitTorrent',
        trickleIce: false,
        latencyMs: 4,
        jitterMs: 5
      }
    ]
  }),
  Object.freeze({
    name: 'reconnect-same-stream',
    reconnect: true,
    adapters: [
      {
        id: 'nostr',
        name: 'Native Nostr',
        trickleIce: true,
        latencyMs: 2,
        jitterMs: 12,
        offerDelayMs: 14
      }
    ]
  })
])

class SignalingBus {
  #sessions = new Set()
  #timers = new Set()
  #random

  constructor (seed) {
    this.#random = seededRandom(seed)
    this.stats = {
      published: 0,
      candidates: 0,
      duplicates: 0,
      publishFailures: 0
    }
  }

  createSession (adapter, peerId) {
    const bus = this
    const listeners = new Set()
    let closed = false
    const session = {
      name: adapter.name,
      peerId,
      topic: SIGNALING_TOPIC,
      trickleIce: adapter.trickleIce,
      ready: Promise.resolve(),
      adapterId: adapter.id,
      subscribe (listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async publish (message) {
        if (closed) throw new Error(`${adapter.name} signaling session is closed`)
        if (adapter.available === false) {
          bus.stats.publishFailures += 1
          throw new Error(`${adapter.name} is unavailable in this soak scenario`)
        }
        bus.stats.published += 1
        if (message.type === 'candidate') bus.stats.candidates += 1
        const signal = Object.freeze({
          version: 2,
          room: SIGNALING_TOPIC,
          from: peerId,
          createdAt: Date.now(),
          ...message
        })
        for (const target of bus.#sessions) {
          if (
            target === session ||
            target.adapterId !== adapter.id ||
            target.topic !== SIGNALING_TOPIC
          ) continue
          bus.#scheduleDelivery(target, signal, adapter)
          if (
            adapter.duplicateTypes?.includes(message.type) &&
            adapter.duplicateRate > 0 &&
            bus.#random() < adapter.duplicateRate
          ) {
            bus.stats.duplicates += 1
            bus.#scheduleDelivery(target, signal, adapter, 1)
          }
        }
      },
      status () {
        const open = !closed && adapter.available !== false ? 1 : 0
        return { name: adapter.name, open, connecting: 0, total: 1 }
      },
      async close () {
        if (closed) return
        closed = true
        listeners.clear()
        bus.#sessions.delete(session)
      },
      emit (message) {
        if (closed || (message.to != null && message.to !== peerId)) return
        for (const listener of listeners) listener(message)
      }
    }
    this.#sessions.add(session)
    return session
  }

  close () {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    this.#sessions.clear()
  }

  #scheduleDelivery (target, signal, adapter, extraDelayMs = 0) {
    const jitter = Math.floor(this.#random() * (adapter.jitterMs ?? 0))
    const offerDelay = signal.type === 'offer' ? adapter.offerDelayMs ?? 0 : 0
    const delayMs = (adapter.latencyMs ?? 0) + jitter + offerDelay + extraDelayMs
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      target.emit(signal)
    }, delayMs)
    this.#timers.add(timer)
  }
}

function seededRandom (seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

function parseArguments (values) {
  const options = {
    profile: 'smoke',
    iterations: undefined,
    payloadBytes: undefined,
    report: undefined,
    scenarios: undefined
  }
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]
    if (argument === '--help' || argument === '-h') {
      printHelp()
      process.exit(0)
    }
    const value = values[index + 1]
    if (value == null || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    index += 1
    if (argument === '--profile') options.profile = value
    else if (argument === '--iterations') options.iterations = positiveInteger(value, argument)
    else if (argument === '--payload-bytes') options.payloadBytes = positiveInteger(value, argument)
    else if (argument === '--report') options.report = value
    else if (argument === '--scenarios') options.scenarios = value.split(',').map(item => item.trim()).filter(Boolean)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (PROFILES[options.profile] == null) {
    throw new Error(`Unknown profile: ${options.profile}. Expected smoke, ci, or soak`)
  }
  return options
}

function positiveInteger (value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function printHelp () {
  process.stdout.write(
    'Usage: npm run soak:webrtc -- [options]\n\n' +
    'Options:\n' +
    '  --profile <smoke|ci|soak>  Workload profile (default: smoke)\n' +
    '  --iterations <count>       Override iterations per scenario\n' +
    '  --payload-bytes <bytes>    Override payload size per direction\n' +
    '  --scenarios <a,b>          Run only named scenarios\n' +
    '  --report <file>            Write a JSON report\n'
  )
}

async function runScenarioIteration (scenario, iteration, payloadBytes) {
  const startedAt = performance.now()
  const bus = new SignalingBus(hashSeed(`${scenario.name}:${iteration}`))
  const privateKey = await generateKeyPair('Ed25519')
  const serverPeerId = peerIdFromPrivateKey(privateKey).toString()
  const serverConnections = []
  const clientConnections = []
  const serverSessions = scenario.adapters.map(adapter => bus.createSession(adapter, SERVER_SIGNALING_ID))
  const clientSessions = scenario.adapters.map(adapter => bus.createSession(adapter, CLIENT_SIGNALING_ID))
  const serverStreamReady = deferred()
  const clientReconnected = deferred()
  const serverReconnected = deferred()
  const listener = startNativeWebRtcListener({
    signalingSessions: serverSessions,
    RTCPeerConnection: trackingPeerConnection(serverConnections),
    rtcConfig: { iceServers: [] },
    reconnectGraceMs: RECONNECT_TIMEOUT_MS,
    createAuthResponse: challenge => signWebRtcAuthResponse(privateKey, SERVICE, challenge),
    onStream: stream => serverStreamReady.resolve(stream),
    onPeerReconnected: (_remoteId, stream) => serverReconnected.resolve(stream)
  })
  const connection = connectNativeWebRtc({
    signalingSessions: clientSessions,
    RTCPeerConnection: trackingPeerConnection(clientConnections),
    rtcConfig: { iceServers: [] },
    timeoutMs: CONNECTION_TIMEOUT_MS,
    reconnectGraceMs: RECONNECT_TIMEOUT_MS,
    verifyAuthResponse: (response, challenge) => (
      verifyWebRtcAuthResponse(response, serverPeerId, SERVICE, challenge)
    ),
    onReconnected: stream => clientReconnected.resolve(stream)
  })

  let clientStream
  let serverStream
  let clientReader
  let serverReader
  let transferredBytes = 0
  try {
    const streams = await withTimeout(
      Promise.all([connection.promise, serverStreamReady.promise]),
      CONNECTION_TIMEOUT_MS,
      `${scenario.name} connection`
    )
    clientStream = streams[0]
    serverStream = streams[1]
    clientReader = clientStream[Symbol.asyncIterator]()
    serverReader = serverStream[Symbol.asyncIterator]()

    await runBidirectionalTransfer({
      clientStream,
      serverStream,
      clientReader,
      serverReader,
      payloadBytes,
      seed: hashSeed(`${scenario.name}:${iteration}:initial`)
    })
    transferredBytes += payloadBytes * 2

    if (scenario.reconnect) {
      for (const peerConnection of clientConnections) {
        if (peerConnection.connectionState !== 'closed') peerConnection.close()
      }
      const [resumedClient, resumedServer] = await withTimeout(
        Promise.all([clientReconnected.promise, serverReconnected.promise]),
        RECONNECT_TIMEOUT_MS,
        `${scenario.name} reconnect`
      )
      if (resumedClient !== clientStream || resumedServer !== serverStream) {
        throw new Error('Reconnect replaced the logical WebRtcStream')
      }
      await runBidirectionalTransfer({
        clientStream,
        serverStream,
        clientReader,
        serverReader,
        payloadBytes,
        seed: hashSeed(`${scenario.name}:${iteration}:resumed`)
      })
      transferredBytes += payloadBytes * 2
    }

    return {
      durationMs: Math.round(performance.now() - startedAt),
      transferredBytes,
      signaling: bus.stats,
      strategy: clientStream.signalingStrategy
    }
  } finally {
    await Promise.allSettled([
      clientReader?.return(),
      serverReader?.return(),
      connection.close(),
      listener.close()
    ])
    for (const peerConnection of [...clientConnections, ...serverConnections]) {
      try {
        peerConnection.close()
      } catch {}
    }
    bus.close()
  }
}

async function runBidirectionalTransfer ({
  clientStream,
  serverStream,
  clientReader,
  serverReader,
  payloadBytes,
  seed
}) {
  const clientPayload = deterministicPayload(payloadBytes, seed)
  const serverPayload = deterministicPayload(payloadBytes, seed ^ 0xa5a5a5a5)
  await Promise.all([
    transferAndVerify(clientStream, serverReader, clientPayload),
    transferAndVerify(serverStream, clientReader, serverPayload)
  ])
}

async function transferAndVerify (sender, receiver, payload) {
  const received = readExactly(receiver, payload.byteLength)
  for (let offset = 0; offset < payload.byteLength; offset += CHUNK_BYTES) {
    sender.send(payload.subarray(offset, Math.min(payload.byteLength, offset + CHUNK_BYTES)))
    if (((offset / CHUNK_BYTES) + 1) % 4 === 0) await sender.onDrain()
  }
  await sender.onDrain()
  const actual = await withTimeout(received, CONNECTION_TIMEOUT_MS, 'payload transfer')
  const expectedHash = sha256(payload)
  const actualHash = sha256(actual)
  if (actualHash !== expectedHash) {
    throw new Error(`Payload hash mismatch: expected ${expectedHash}, received ${actualHash}`)
  }
}

async function readExactly (iterator, byteLength) {
  const result = new Uint8Array(byteLength)
  let offset = 0
  while (offset < byteLength) {
    const item = await iterator.next()
    if (item.done) throw new Error(`Stream ended after ${offset} of ${byteLength} bytes`)
    if (offset + item.value.byteLength > byteLength) {
      throw new Error(`Stream delivered more than the expected ${byteLength} bytes`)
    }
    result.set(item.value, offset)
    offset += item.value.byteLength
  }
  return result
}

function deterministicPayload (byteLength, seed) {
  const payload = new Uint8Array(byteLength)
  let state = seed >>> 0
  for (let index = 0; index < payload.byteLength; index += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
    payload[index] = state >>> 24
  }
  return payload
}

function trackingPeerConnection (connections) {
  return function TrackingRTCPeerConnection (configuration) {
    const connection = new wrtc.RTCPeerConnection(configuration)
    connections.push(connection)
    return connection
  }
}

function deferred () {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function withTimeout (promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function sha256 (value) {
  return createHash('sha256').update(value).digest('hex')
}

function hashSeed (value) {
  return createHash('sha256').update(value).digest().readUInt32BE(0)
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const profile = PROFILES[options.profile]
  const iterations = options.iterations ?? profile.iterations
  const payloadBytes = options.payloadBytes ?? profile.payloadBytes
  const selected = options.scenarios == null
    ? SCENARIOS
    : SCENARIOS.filter(scenario => options.scenarios.includes(scenario.name))
  if (selected.length === 0) throw new Error('No soak scenarios selected')
  if (options.scenarios != null && selected.length !== new Set(options.scenarios).size) {
    const known = new Set(SCENARIOS.map(scenario => scenario.name))
    const unknown = [...new Set(options.scenarios)].filter(name => !known.has(name))
    throw new Error(`Unknown soak scenarios: ${unknown.join(', ')}`)
  }

  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch
    },
    configuration: {
      profile: options.profile,
      iterations,
      payloadBytes,
      scenarios: selected.map(scenario => scenario.name)
    },
    results: []
  }
  let failed = 0
  process.stdout.write(
    `[soak] profile=${options.profile} iterations=${iterations} payload=${payloadBytes} bytes/direction\n`
  )

  for (const scenario of selected) {
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      process.stdout.write(`[soak] ${scenario.name} ${iteration}/${iterations} ... `)
      const result = {
        scenario: scenario.name,
        iteration,
        status: 'passed'
      }
      try {
        Object.assign(result, await runScenarioIteration(scenario, iteration, payloadBytes))
        process.stdout.write(`passed (${result.durationMs} ms, ${result.strategy})\n`)
      } catch (error) {
        failed += 1
        result.status = 'failed'
        result.error = error instanceof Error ? error.stack ?? error.message : String(error)
        process.stdout.write(`failed (${error instanceof Error ? error.message : String(error)})\n`)
      }
      report.results.push(result)
    }
  }

  report.finishedAt = new Date().toISOString()
  report.summary = {
    passed: report.results.length - failed,
    failed,
    transferredBytes: report.results.reduce((total, result) => total + (result.transferredBytes ?? 0), 0),
    durationMs: report.results.reduce((total, result) => total + (result.durationMs ?? 0), 0)
  }

  if (options.report != null) {
    const reportPath = resolve(options.report)
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`[soak] report=${reportPath}\n`)
  }
  process.stdout.write(`[soak] passed=${report.summary.passed} failed=${report.summary.failed}\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch(error => {
  process.stderr.write(`[soak] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
