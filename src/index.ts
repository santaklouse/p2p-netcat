import './runtime-polyfills.js'
import type { Libp2p } from 'libp2p'
import { multiaddr } from '@multiformats/multiaddr'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createNode, nodeInfo } from './libp2p-node.js'
import P2pNetcat from './netcat.js'
import PubSubManager from './pubsub-manager.js'
import type { NetcatSession } from './netcat.js'
import { Uint8ArrayList } from 'uint8arraylist'

interface CliArgs {
  mode?: 'client' | 'server'
  remotePeerId?: string
  topic?: string
  connect: string[]
  wait: boolean
  waitTimeoutSec?: number
  interactive: boolean
  execCommand?: string
}

async function main(args: CliArgs): Promise<void> {
  const mode = args.mode ?? (args.remotePeerId ? 'client' : 'server')

  const node = await createNode()
  await node.start()

  const info = nodeInfo(node)
  console.error('=== P2P Netcat ===')
  console.error(`peerId: ${info.peerId}`)
  info.listenAddrs.forEach((a: string) => console.error(`listen: ${a}`))
  await connectToAddrs(node, args.connect)

  if (args.topic) {
    if (args.execCommand || args.interactive) {
      throw new Error('Flags -e/-i are available only in stream mode (without --topic)')
    }

    try {
      await runPubSub(node, args.topic)
    } finally {
      await node.stop()
    }
    return
  }

  const netcat = new P2pNetcat(node)
  const execCommand = resolveExecCommand(args)

  try {
    if (mode === 'server') {
      await runServer(netcat, execCommand, args.interactive)
      return
    }

    if (!args.remotePeerId) {
      throw new Error('Для client режима нужен --remote-peer-id <peerId>')
    }

    await runClient(netcat, args.remotePeerId, args.wait, args.waitTimeoutSec, execCommand, args.interactive)
  } finally {
    await netcat.close()
  }
}

async function runServer(netcat: P2pNetcat, execCommand?: string, interactiveShell = false): Promise<void> {
  console.error('server: waiting for incoming stream...')

  const done = new Promise<void>((resolve) => {
    netcat.handleIncoming(async (session) => {
      console.error(`server: incoming from ${session.peerId}`)
      if (execCommand) {
        await runCommandOverSession(session, execCommand, interactiveShell)
      } else {
        await Promise.all([netcat.pipeStreamToStdout(session), netcat.pipeStdinToStream(session)])
      }
      resolve()
    })
  })

  await done
}

async function runClient(
  netcat: P2pNetcat,
  remotePeerId: string,
  waitForRemote: boolean,
  waitTimeoutSec?: number,
  execCommand?: string,
  interactiveShell = false
): Promise<void> {
  const timeoutMs = Math.max(1, waitTimeoutSec ?? 60) * 1000
  const start = Date.now()
  let attempt = 0
  let session

  while (true) {
    attempt++
    try {
      if (attempt === 1) {
        console.error(`client: dialing ${remotePeerId}...`)
      } else {
        console.error(`client: retry dial ${remotePeerId} (attempt ${attempt})...`)
      }
      session = await netcat.dialPeer(remotePeerId)
      break
    } catch (err) {
      if (!waitForRemote || Date.now() - start >= timeoutMs) {
        throw err
      }

      const secondsLeft = Math.max(0, Math.ceil((timeoutMs - (Date.now() - start)) / 1000))
      console.error(`client: remote peer is not available yet, retry in 1s (${secondsLeft}s left)`)
      await delay(1000)
    }
  }

  if (execCommand) {
    console.error(`client: connected, executing command "${execCommand}" over stream`)
    await runCommandOverSession(session, execCommand, interactiveShell)
  } else {
    console.error('client: connected, piping stdin<->stream<->stdout')
    await Promise.all([netcat.pipeStreamToStdout(session), netcat.pipeStdinToStream(session)])
  }
}

async function runPubSub(node: Libp2p, topic: string): Promise<void> {
  const pubsub = new PubSubManager(node)
  console.error(`pubsub: subscribe ${topic}`)

  let shuttingDown = false
  let resolveShutdown: (() => void) | null = null

  const shutdownPromise = new Promise<void>((resolve) => {
    resolveShutdown = resolve
  })

  const shutdown = (unsubscribe: () => void): void => {
    if (shuttingDown) return
    shuttingDown = true
    unsubscribe()
    resolveShutdown?.()
  }

  const unsubscribe = await pubsub.subscribe(topic, (msg) => {
    const data = PubSubManager.formatData(msg.data)
    process.stdout.write(data)
  })

  process.stdin.resume()
  let publishQueue = Promise.resolve()
  const shouldExitOnStdinEnd = !process.stdin.isTTY
  let receivedStdinData = false

  process.stdin.on('data', (chunk: Buffer) => {
    receivedStdinData = true
    publishQueue = publishQueue
      .then(() => publishChunk(pubsub, topic, chunk))
      .catch((err) => {
        console.error(`pubsub queue error: ${String(err)}`)
      })
  })

  process.stdin.once('end', () => {
    if (!shouldExitOnStdinEnd || !receivedStdinData) return
    void publishQueue.finally(() => shutdown(unsubscribe))
  })

  process.once('SIGINT', () => shutdown(unsubscribe))
  process.once('SIGTERM', () => shutdown(unsubscribe))

  await shutdownPromise
}

const args = parseArgs(process.argv.slice(2))
main(args).catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { connect: [], wait: false, interactive: false }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--mode':
        args.mode = argv[++i] as 'client' | 'server'
        break
      case '--remote-peer-id':
        args.remotePeerId = argv[++i]
        break
      case '--topic':
        args.topic = argv[++i]
        break
      case '--connect':
        args.connect.push(argv[++i])
        break
      case '--wait':
        args.wait = true
        break
      case '--wait-timeout':
        args.wait = true
        args.waitTimeoutSec = Number(argv[++i])
        if (!Number.isFinite(args.waitTimeoutSec) || args.waitTimeoutSec <= 0) {
          throw new Error('--wait-timeout must be a positive number of seconds')
        }
        break
      case '-i':
      case '--interactive':
        args.interactive = true
        break
      case '-e':
      case '--exec':
        args.execCommand = argv[++i]
        if (!args.execCommand) {
          throw new Error('-e/--exec requires a command string')
        }
        break
    }
  }

  return args
}

async function publishChunk(pubsub: PubSubManager, topic: string, chunk: Buffer): Promise<void> {
  const deadlineMs = Date.now() + 20000

  while (true) {
    if (pubsub.getSubscriberCount(topic) === 0) {
      await pubsub.waitForSubscribers(topic, { timeoutMs: 1000 })
    }

    try {
      await pubsub.publish(topic, chunk)
      return
    } catch (err) {
      const message = String(err)
      if (message.includes('NoPeersSubscribedToTopic') && Date.now() < deadlineMs) {
        await delay(300)
        continue
      }
      if (message.includes('NoPeersSubscribedToTopic')) {
        console.error(`pubsub: no subscribers for topic "${topic}"`)
      } else {
        console.error(`pubsub publish error: ${message}`)
      }
      return
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectToAddrs(node: Libp2p, addrs: string[]): Promise<void> {
  for (const addr of addrs) {
    try {
      await node.dial(multiaddr(addr))
      console.error(`connected: ${addr}`)
    } catch (err) {
      console.error(`connect failed: ${addr}: ${String(err)}`)
    }
  }
}

function resolveExecCommand(args: CliArgs): string | undefined {
  if (args.execCommand) return args.execCommand
  if (!args.interactive) return undefined

  const shell = process.env.SHELL ?? '/bin/bash'
  return `${shell} -il`
}

function chunkToUint8(chunk: Uint8Array | Uint8ArrayList): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : chunk.subarray()
}

async function runCommandOverSession(
  session: NetcatSession,
  command: string,
  interactiveShell: boolean
): Promise<void> {
  const child = spawn(command, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const stream = session.stream
  const escapeState = { ctrlE: false }
  let childExited = false

  const streamToChild = (async () => {
    for await (const chunk of stream) {
      const data = chunkToUint8(chunk)
      const escaped = interactiveShell ? processInteractiveEscape(data, escapeState) : { data, terminate: false }

      if (escaped.data.length > 0) {
        if (!child.stdin.write(Buffer.from(escaped.data))) {
          await once(child.stdin, 'drain')
        }
      }

      if (escaped.terminate) {
        child.kill('SIGTERM')
        break
      }
    }
    child.stdin.end()
  })()

  const stdoutToStream = pipeReadableToStream(child.stdout, stream)
  const stderrToStream = pipeReadableToStream(child.stderr, stream)
  const childExit = once(child, 'exit').then(() => {
    childExited = true
    return 'child' as const
  })
  const inputDone = streamToChild.then(() => 'input' as const)

  const first = await Promise.race([childExit, inputDone])

  if (first === 'child') {
    await stream.close()
  } else {
    await Promise.race([childExit, delay(2000)])
  }

  if (!childExited) {
    child.kill('SIGTERM')
  }

  await Promise.allSettled([stdoutToStream, stderrToStream, streamToChild])
  await stream.close()
}

async function pipeReadableToStream(
  readable: AsyncIterable<Uint8Array>,
  stream: NetcatSession['stream']
): Promise<void> {
  for await (const chunk of readable) {
    const data = chunk

    while (true) {
      if (stream.send(data)) break
      await stream.onDrain()
    }
  }
}

function processInteractiveEscape(
  input: Uint8Array,
  state: { ctrlE: boolean }
): { data: Uint8Array; terminate: boolean } {
  const output: number[] = []
  let terminate = false

  for (const byte of input) {
    if (state.ctrlE) {
      if (byte === 0x71) {
        terminate = true
        state.ctrlE = false
        continue
      }
      output.push(0x05)
      state.ctrlE = false
    }

    if (byte === 0x05) {
      state.ctrlE = true
      continue
    }

    output.push(byte)
  }

  return {
    data: Uint8Array.from(output),
    terminate
  }
}
