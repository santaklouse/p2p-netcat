import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, publicKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromPublicKey } from '@libp2p/peer-id'
import wrtc from '@roamhq/wrtc'
import { createP2PNode, protectPubsubPeerDiscovery } from '../src/node.js'
import { loadOrCreateIdentity } from '../src/identity.js'
import { startRelay } from 'p2p-netcat/relay'
import { protocolForService as protocolFromCliSubpath } from 'p2p-netcat/core'
import {
  createWebRtcActionHub,
  connectNativeWebRtc,
  decodeWebRtcAuthResponse,
  encodeWebRtcAuthResponse,
  preferDialAddresses,
  protocolForService,
  relayedTargetAddress,
  startNativeWebRtcListener,
  webRtcAuthPayload,
  validateService
} from 'p2p-netcat-core'

class MemorySignalingBus {
  sessions = new Set()
  deliveryLog = []

  createSession (name, peerId, { trickleIce = true, offerDelayMs = 0 } = {}) {
    const bus = this
    const listeners = new Set()
    const session = {
      name,
      peerId,
      topic: 'memory-native-webrtc-topic',
      trickleIce,
      ready: Promise.resolve(),
      subscribe (listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async publish (message) {
        const signal = Object.freeze({
          version: 2,
          room: session.topic,
          from: session.peerId,
          createdAt: Date.now(),
          ...message
        })
        for (const target of bus.sessions) {
          if (target === session) continue
          const deliver = () => {
            bus.deliveryLog.push(signal.type)
            target.emit(signal)
          }
          if (signal.type === 'offer' && offerDelayMs > 0) setTimeout(deliver, offerDelayMs)
          else queueMicrotask(deliver)
        }
      },
      status () {
        return { name, open: 1, connecting: 0, total: 1 }
      },
      async close () {
        bus.sessions.delete(session)
        listeners.clear()
      },
      emit (message) {
        if (message.to != null && message.to !== peerId) return
        for (const listener of listeners) listener(message)
      }
    }
    this.sessions.add(session)
    return session
  }
}

test('логический порт валидируется и преобразуется в protocol id', () => {
  assert.equal(validateService('8080'), 8080)
  assert.equal(protocolForService(8080), '/p2p-netcat/1.0.0/8080')
  assert.throws(() => validateService(0), /от 1 до 65535/)
  assert.throws(() => validateService(65536), /от 1 до 65535/)
})

test('CLI subpath p2p-netcat/core экспортирует browser-safe ядро', () => {
  assert.equal(protocolFromCliSubpath(31337), '/p2p-netcat/1.0.0/31337')
})

test('ошибка остановки частично запущенного PubSub не скрывает исходную ошибку', () => {
  const stopped = protectPubsubPeerDiscovery(() => ({
    beforeStop () {
      throw new Error('Pubsub is not started')
    }
  }))({})
  assert.doesNotThrow(() => stopped.beforeStop())

  const unexpected = protectPubsubPeerDiscovery(() => ({
    beforeStop () {
      throw new Error('unexpected cleanup failure')
    }
  }))({})
  assert.throws(() => unexpected.beforeStop(), /unexpected cleanup failure/)
})

test('постоянный ключ сохраняет один и тот же PeerId и закрытые права', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p2p-netcat-test-'))
  const keyPath = join(directory, 'identity.key')
  const first = await loadOrCreateIdentity(keyPath)
  const second = await loadOrCreateIdentity(keyPath)

  assert.equal(peerIdFromPrivateKey(first).toString(), peerIdFromPrivateKey(second).toString())
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600)
})

test('relay multiaddr строится из relay и PeerId', async () => {
  const relayId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
  const targetId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
  const relay = `/ip4/127.0.0.1/tcp/9090/p2p/${relayId}`

  assert.equal(
    relayedTargetAddress(relay, targetId).toString(),
    `${relay}/p2p-circuit/p2p/${targetId}`
  )
})

test('публичный relay API запускает и идемпотентно останавливает Circuit Relay v2', async () => {
  const relay = await startRelay({
    identityPath: null,
    localPort: 0,
    websocketPort: null,
    ipVersion: 4,
    enableMdns: false,
    enableQuic: false
  })

  assert.match(relay.peerId, /^12D3KooW/)
  assert.equal(relay.identityPath, null)
  assert.ok(relay.addresses.some(address => address.includes('/ip4/127.0.0.1/tcp/')))
  assert.ok(relay.addresses.every(address => address.endsWith(`/p2p/${relay.peerId}`)))
  assert.equal(relay.node.status, 'started')

  await Promise.all([relay.stop(), relay.stop()])
  assert.equal(relay.node.status, 'stopped')
})

test('QUIC имеет приоритет перед TCP, а relay остаётся последним', () => {
  const address = value => ({ multiaddr: { toString: () => value } })
  const quicAddress = address('/ip4/127.0.0.1/udp/9090/quic-v1')
  const tcpAddress = address('/ip4/127.0.0.1/tcp/9090')
  const relayAddress = address('/ip4/127.0.0.1/tcp/9091/p2p/relay/p2p-circuit')

  assert.ok(preferDialAddresses(quicAddress, tcpAddress) < 0)
  assert.ok(preferDialAddresses(tcpAddress, relayAddress) < 0)
})

test('WebRTC challenge криптографически привязан к ожидаемому PeerId', async () => {
  const privateKey = await generateKeyPair('Ed25519')
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const payload = webRtcAuthPayload(peerId, 31337, challenge)
  const frame = encodeWebRtcAuthResponse(
    publicKeyToProtobuf(privateKey.publicKey),
    await privateKey.sign(payload)
  )
  const response = decodeWebRtcAuthResponse(frame)
  const publicKey = publicKeyFromProtobuf(response.publicKey)
  assert.equal(peerIdFromPublicKey(publicKey).toString(), peerId)
  assert.equal(await publicKey.verify(payload, response.signature), true)
  assert.equal(await publicKey.verify(webRtcAuthPayload(peerId, 31338, challenge), response.signature), false)
})

test('общий WebRTC action hub сохраняет тот же поток при кратком переподключении peer', async () => {
  let leaveCount = 0
  const room = {
    makeAction () {
      return {
        async send () {},
        onMessage: null
      }
    },
    async leave () {
      leaveCount += 1
    },
    onPeerJoin: null,
    onPeerLeave: null
  }
  const opened = []
  const disconnected = []
  const reconnected = []
  const hub = createWebRtcActionHub(room, {
    reconnectGraceMs: 1_000,
    onStream: (stream, peerId) => opened.push({ stream, peerId }),
    onPeerDisconnected: peerId => disconnected.push(peerId),
    onPeerReconnected: peerId => reconnected.push(peerId)
  })

  room.onPeerJoin('remote-1')
  const stream = opened[0].stream
  room.onPeerLeave('remote-1')
  assert.equal(stream.status, 'open')
  assert.equal(stream.connectionStatus, 'reconnecting')
  assert.deepEqual(disconnected, ['remote-1'])

  room.onPeerJoin('remote-1')
  assert.equal(stream.connectionStatus, 'connected')
  assert.equal(opened.length, 1)
  assert.deepEqual(reconnected, ['remote-1'])

  await hub.close()
  assert.equal(leaveCount, 1)
  assert.equal(stream.status, 'closed')
})

test('native WebRTC endpoint аутентифицирует PeerId и передаёт бинарный поток', async () => {
  const privateKey = await generateKeyPair('Ed25519')
  const serverPeerId = peerIdFromPrivateKey(privateKey).toString()
  const service = 31337
  const bus = new MemorySignalingBus()
  const serverSignaling = bus.createSession('Memory signaling', 'SERVER12345678901234')
  const clientSignaling = bus.createSession(
    'Memory signaling',
    'CLIENT12345678901234',
    { offerDelayMs: 20 }
  )
  const peerConnections = []
  function TrackingRTCPeerConnection (configuration) {
    const connection = new wrtc.RTCPeerConnection(configuration)
    peerConnections.push(connection)
    return connection
  }
  let resolveServerStream
  const serverStreamPromise = new Promise(resolve => {
    resolveServerStream = resolve
  })
  let resolveServerReconnected
  const serverReconnectedPromise = new Promise(resolve => {
    resolveServerReconnected = resolve
  })
  let resolveClientReconnected
  const clientReconnectedPromise = new Promise(resolve => {
    resolveClientReconnected = resolve
  })
  let resolveServerClosed
  const serverClosedPromise = new Promise(resolve => {
    resolveServerClosed = resolve
  })
  const listener = startNativeWebRtcListener({
    signalingSessions: [serverSignaling],
    RTCPeerConnection: TrackingRTCPeerConnection,
    rtcConfig: { iceServers: [] },
    createAuthResponse: async challenge => encodeWebRtcAuthResponse(
      publicKeyToProtobuf(privateKey.publicKey),
      await privateKey.sign(webRtcAuthPayload(serverPeerId, service, challenge))
    ),
    onStream: stream => resolveServerStream(stream),
    onPeerReconnected: (_remoteId, stream) => resolveServerReconnected(stream),
    onStreamClosed: (_remoteId, stream) => resolveServerClosed(stream)
  })
  const connection = connectNativeWebRtc({
    signalingSessions: [clientSignaling],
    RTCPeerConnection: TrackingRTCPeerConnection,
    rtcConfig: { iceServers: [] },
    timeoutMs: 10_000,
    reconnectGraceMs: 10_000,
    onReconnected: stream => resolveClientReconnected(stream),
    verifyAuthResponse: async (value, challenge) => {
      const response = decodeWebRtcAuthResponse(value)
      const publicKey = publicKeyFromProtobuf(response.publicKey)
      if (peerIdFromPublicKey(publicKey).toString() !== serverPeerId) return false
      return publicKey.verify(webRtcAuthPayload(serverPeerId, service, challenge), response.signature)
    }
  })

  try {
    const [clientStream, serverStream] = await Promise.all([
      connection.promise,
      serverStreamPromise
    ])
    const clientReader = clientStream[Symbol.asyncIterator]()
    const serverReader = serverStream[Symbol.asyncIterator]()
    const clientPayload = Uint8Array.from([0, 42, 255, 10])
    clientStream.send(clientPayload)
    await clientStream.onDrain()
    assert.deepEqual((await serverReader.next()).value, clientPayload)

    const serverPayload = Uint8Array.from([9, 8, 7])
    serverStream.send(serverPayload)
    await serverStream.onDrain()
    assert.deepEqual((await clientReader.next()).value, serverPayload)
    assert.equal(clientStream.signalingStrategy, 'Memory signaling')
    assert.ok(
      bus.deliveryLog.indexOf('candidate') < bus.deliveryLog.indexOf('offer'),
      'listener must accept trickle candidates delivered before their offer'
    )

    peerConnections[0].close()
    let reconnectTimer
    const reconnectTimeout = new Promise((_, reject) => {
      reconnectTimer = setTimeout(
        () => reject(new Error('Native WebRTC reconnect timeout')),
        10_000
      )
    })
    const [reconnectedClientStream, reconnectedServerStream] = await Promise.race([
      Promise.all([clientReconnectedPromise, serverReconnectedPromise]),
      reconnectTimeout
    ]).finally(() => clearTimeout(reconnectTimer))
    assert.equal(reconnectedClientStream, clientStream)
    assert.equal(reconnectedServerStream, serverStream)

    const resumedPayload = Uint8Array.from([11, 22, 33, 44])
    clientStream.send(resumedPayload)
    await clientStream.onDrain()
    assert.deepEqual((await serverReader.next()).value, resumedPayload)
    await Promise.allSettled([clientReader.return(), serverReader.return()])
    await connection.close()
    assert.equal(await serverClosedPromise, serverStream)
    assert.equal(serverStream.status, 'closed')
  } finally {
    await Promise.allSettled([connection.close(), listener.close()])
  }
})

test('два локальных узла передают двунаправленный бинарный поток', async () => {
  const server = await createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    relays: []
  })
  const client = await createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    relays: []
  })
  const protocol = protocolForService(49152)
  const received = []

  try {
    await server.handle(protocol, async stream => {
      for await (const chunk of stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray()
        received.push(...bytes)
        stream.send(Uint8Array.from(bytes, byte => byte ^ 0xff))
      }
      await stream.close()
    })

    const target = server.getMultiaddrs().find(address => {
      const value = address.toString()
      return value.includes('/ip4/127.0.0.1/') && value.includes('/tcp/')
    })
    assert.ok(target, 'сервер должен слушать localhost')
    const stream = await client.dialProtocol(target, protocol)
    const payload = Uint8Array.from([0x00, 0x41, 0xff, 0x0a])
    stream.send(payload)
    await stream.close()

    const response = []
    for await (const chunk of stream) {
      response.push(...(chunk instanceof Uint8Array ? chunk : chunk.subarray()))
    }

    assert.deepEqual(received, [...payload])
    assert.deepEqual(response, [...payload].map(byte => byte ^ 0xff))
  } finally {
    await Promise.allSettled([client.stop(), server.stop()])
  }
})

test('GossipSub обнаруживает PeerId через промежуточный совместимый узел', async () => {
  const nodeOptions = async () => ({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    enablePubsub: true,
    pubsubIntervalMs: 200,
    enableQuic: false,
    relays: []
  })
  const hub = await createP2PNode(await nodeOptions())
  const seeker = await createP2PNode(await nodeOptions())
  const target = await createP2PNode(await nodeOptions())

  try {
    const discovered = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PubSub discovery timeout')), 8_000)
      seeker.addEventListener('peer:discovery', event => {
        if (!event.detail.id.equals(target.peerId)) return
        clearTimeout(timeout)
        resolve(event.detail)
      })
    })
    const hubAddress = hub.getMultiaddrs().find(address => (
      address.toString().includes('/ip4/127.0.0.1/') && address.toString().includes('/tcp/')
    ))
    assert.ok(hubAddress, 'промежуточный узел должен слушать localhost TCP')

    await Promise.all([seeker.dial(hubAddress), target.dial(hubAddress)])
    const peer = await discovered

    assert.equal(peer.id.toString(), target.peerId.toString())
    assert.ok(peer.multiaddrs.length > 0)
    assert.ok((await seeker.peerStore.get(target.peerId)).addresses.length > 0)
  } finally {
    await Promise.allSettled([seeker.stop(), target.stop(), hub.stop()])
  }
})

test('два локальных узла передают поток напрямую через QUIC v1', async () => {
  const server = await createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    relays: []
  })
  const client = await createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    relays: []
  })
  const protocol = protocolForService(49153)
  const payload = Uint8Array.from([0x51, 0x55, 0x49, 0x43, 0x0a])
  const received = []

  try {
    await server.handle(protocol, async stream => {
      for await (const chunk of stream) {
        received.push(...(chunk instanceof Uint8Array ? chunk : chunk.subarray()))
      }
      stream.send(Uint8Array.from([0x4f, 0x4b, 0x0a]))
      await stream.close()
    })

    const addresses = server.getMultiaddrs().filter(address => address.toString().includes('/ip4/127.0.0.1/'))
    assert.ok(addresses.some(address => address.toString().includes('/quic-v1')), 'сервер должен слушать QUIC на localhost')
    assert.ok(addresses.some(address => address.toString().includes('/tcp/')), 'сервер должен сохранять TCP fallback')
    await client.peerStore.merge(server.peerId, { multiaddrs: addresses })

    const stream = await client.dialProtocol(server.peerId, protocol)
    assert.match(client.getConnections(server.peerId)[0].remoteAddr.toString(), /\/quic-v1/)
    stream.send(payload)
    await stream.close()

    const response = []
    for await (const chunk of stream) {
      response.push(...(chunk instanceof Uint8Array ? chunk : chunk.subarray()))
    }

    assert.deepEqual(received, [...payload])
    assert.deepEqual(response, [0x4f, 0x4b, 0x0a])
  } finally {
    await Promise.allSettled([client.stop(), server.stop()])
  }
})
