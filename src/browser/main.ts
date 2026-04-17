import '../runtime-polyfills.js'
import { createLibp2p, type Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { mplex } from '@libp2p/mplex'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { floodsub } from '@libp2p/floodsub'
import { NETCAT_PROTOCOL } from '../netcat-protocol.js'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { Stream } from '@libp2p/interface'
import { Uint8ArrayList } from 'uint8arraylist'

type PubSubMessageEventDetail = {
  topic: string
  data: Uint8Array
}

type PubSubService = {
  subscribe: (topic: string) => void
  unsubscribe: (topic: string) => void
  publish: (topic: string, data: Uint8Array) => Promise<unknown>
  addEventListener: (type: 'message', listener: (evt: CustomEvent<PubSubMessageEventDetail>) => void) => void
  removeEventListener: (type: 'message', listener: (evt: CustomEvent<PubSubMessageEventDetail>) => void) => void
}

type NetcatSession = {
  stream: Stream
  peerId: string
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

let node: Libp2p | null = null
let currentSession: NetcatSession | null = null
const subscribedTopics = new Set<string>()

const el = {
  startBtn: must<HTMLButtonElement>('start-btn'),
  stopBtn: must<HTMLButtonElement>('stop-btn'),
  peerId: must<HTMLElement>('peer-id'),
  listenAddrs: must<HTMLElement>('listen-addrs'),
  connectAddr: must<HTMLInputElement>('connect-addr'),
  connectBtn: must<HTMLButtonElement>('connect-btn'),
  netcatPeerId: must<HTMLInputElement>('netcat-peer-id'),
  netcatDialBtn: must<HTMLButtonElement>('netcat-dial-btn'),
  netcatSendInput: must<HTMLInputElement>('netcat-send-input'),
  netcatSendBtn: must<HTMLButtonElement>('netcat-send-btn'),
  netcatIncoming: must<HTMLTextAreaElement>('netcat-incoming'),
  netcatStatus: must<HTMLElement>('netcat-status'),
  pubsubTopic: must<HTMLInputElement>('pubsub-topic'),
  pubsubSubscribeBtn: must<HTMLButtonElement>('pubsub-subscribe-btn'),
  pubsubUnsubscribeBtn: must<HTMLButtonElement>('pubsub-unsubscribe-btn'),
  pubsubMessage: must<HTMLInputElement>('pubsub-message'),
  pubsubPublishBtn: must<HTMLButtonElement>('pubsub-publish-btn'),
  pubsubMessages: must<HTMLTextAreaElement>('pubsub-messages'),
  log: must<HTMLTextAreaElement>('log')
}

el.startBtn.addEventListener('click', () => {
  void startNode()
})
el.stopBtn.addEventListener('click', () => {
  void stopNode()
})
el.connectBtn.addEventListener('click', () => {
  void dialAddr(el.connectAddr.value.trim())
})
el.netcatDialBtn.addEventListener('click', () => {
  void dialNetcat(el.netcatPeerId.value.trim())
})
el.netcatSendBtn.addEventListener('click', () => {
  void sendNetcat(el.netcatSendInput.value)
})
el.pubsubSubscribeBtn.addEventListener('click', () => {
  void subscribeTopic(el.pubsubTopic.value.trim())
})
el.pubsubUnsubscribeBtn.addEventListener('click', () => {
  void unsubscribeTopic(el.pubsubTopic.value.trim())
})
el.pubsubPublishBtn.addEventListener('click', () => {
  void publishTopic(el.pubsubTopic.value.trim(), el.pubsubMessage.value)
})

updateUi()

async function startNode(): Promise<void> {
  if (node) return

  node = await createLibp2p({
    transports: [webSockets()],
    streamMuxers: [mplex()],
    connectionEncrypters: [noise()],
    services: {
      identify: identify(),
      pubsub: floodsub()
    }
  })

  await node.start()
  await node.handle(NETCAT_PROTOCOL, async (stream, connection) => {
    log(`incoming netcat stream from ${connection.remotePeer.toString()}`)
    setSession({ stream, peerId: connection.remotePeer.toString() })
  })

  const pubsub = node.services.pubsub as PubSubService
  pubsub.addEventListener('message', onPubSubMessage)

  el.peerId.textContent = node.peerId.toString()
  renderListenAddrs(node.getMultiaddrs().map((m) => m.toString()))
  log(`node started: ${node.peerId.toString()}`)
  updateUi()
}

async function stopNode(): Promise<void> {
  if (!node) return

  try {
    if (currentSession) {
      await currentSession.stream.close()
      currentSession = null
    }

    const pubsub = node.services.pubsub as PubSubService
    pubsub.removeEventListener('message', onPubSubMessage)
    subscribedTopics.clear()
    await node.stop()
    log('node stopped')
  } finally {
    node = null
    el.peerId.textContent = 'not started'
    el.listenAddrs.textContent = '-'
    el.netcatStatus.textContent = 'not connected'
    updateUi()
  }
}

async function dialAddr(addr: string): Promise<void> {
  if (!node || addr.length === 0) return

  try {
    await node.dial(multiaddr(addr))
    log(`connected to ${addr}`)
  } catch (err) {
    log(`connect failed: ${addr}: ${String(err)}`)
  }
}

async function dialNetcat(peerId: string): Promise<void> {
  if (!node || peerId.length === 0) return

  try {
    const stream = await node.dialProtocol(peerIdFromString(peerId), NETCAT_PROTOCOL)
    setSession({ stream, peerId })
    log(`netcat stream connected to ${peerId}`)
  } catch (err) {
    log(`netcat dial failed: ${String(err)}`)
  }
}

async function sendNetcat(text: string): Promise<void> {
  if (!currentSession || text.length === 0) return

  const payload = textEncoder.encode(`${text}\n`)
  while (!currentSession.stream.send(payload)) {
    await currentSession.stream.onDrain()
  }
  el.netcatSendInput.value = ''
}

async function subscribeTopic(topic: string): Promise<void> {
  if (!node || topic.length === 0) return

  try {
    const pubsub = node.services.pubsub as PubSubService
    pubsub.subscribe(topic)
    subscribedTopics.add(topic)
    log(`subscribed topic: ${topic}`)
  } catch (err) {
    log(`subscribe failed: ${String(err)}`)
  }
}

async function unsubscribeTopic(topic: string): Promise<void> {
  if (!node || topic.length === 0) return

  try {
    const pubsub = node.services.pubsub as PubSubService
    pubsub.unsubscribe(topic)
    subscribedTopics.delete(topic)
    log(`unsubscribed topic: ${topic}`)
  } catch (err) {
    log(`unsubscribe failed: ${String(err)}`)
  }
}

async function publishTopic(topic: string, message: string): Promise<void> {
  if (!node || topic.length === 0 || message.length === 0) return

  try {
    const pubsub = node.services.pubsub as PubSubService
    await pubsub.publish(topic, textEncoder.encode(message))
    log(`published to ${topic}: ${message}`)
    el.pubsubMessage.value = ''
  } catch (err) {
    log(`publish failed: ${String(err)}`)
  }
}

function onPubSubMessage(evt: CustomEvent<PubSubMessageEventDetail>): void {
  const msg = evt.detail
  if (!subscribedTopics.has(msg.topic)) return

  const line = `[${new Date().toLocaleTimeString()}] ${msg.topic}: ${safeDecode(msg.data)}`
  appendText(el.pubsubMessages, line)
}

function setSession(session: NetcatSession): void {
  if (currentSession) {
    void currentSession.stream.close()
  }
  currentSession = session
  el.netcatStatus.textContent = `connected: ${session.peerId}`
  void readSession(session)
}

async function readSession(session: NetcatSession): Promise<void> {
  try {
    for await (const chunk of session.stream) {
      const data = chunkToUint8(chunk)
      appendText(el.netcatIncoming, safeDecode(data))
    }
  } catch (err) {
    log(`netcat stream read error: ${String(err)}`)
  } finally {
    if (currentSession?.stream === session.stream) {
      currentSession = null
      el.netcatStatus.textContent = 'not connected'
    }
  }
}

function chunkToUint8(chunk: Uint8Array | Uint8ArrayList): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : chunk.subarray()
}

function safeDecode(data: Uint8Array): string {
  try {
    return textDecoder.decode(data)
  } catch {
    return `[binary ${data.byteLength} bytes]`
  }
}

function renderListenAddrs(addrs: string[]): void {
  if (addrs.length === 0) {
    el.listenAddrs.textContent = '-'
    return
  }

  el.listenAddrs.textContent = addrs.join('\n')
}

function appendText(target: HTMLTextAreaElement, line: string): void {
  target.value += `${line}\n`
  target.scrollTop = target.scrollHeight
}

function log(message: string): void {
  appendText(el.log, `[${new Date().toLocaleTimeString()}] ${message}`)
}

function updateUi(): void {
  const started = node != null
  el.startBtn.disabled = started
  el.stopBtn.disabled = !started
  el.connectBtn.disabled = !started
  el.netcatDialBtn.disabled = !started
  el.netcatSendBtn.disabled = !started
  el.pubsubSubscribeBtn.disabled = !started
  el.pubsubUnsubscribeBtn.disabled = !started
  el.pubsubPublishBtn.disabled = !started
}

function must<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) {
    throw new Error(`Missing element #${id}`)
  }
  return found as T
}
