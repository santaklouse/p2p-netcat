import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import {
  DEFAULT_STUN_URLS,
  NATIVE_WEBRTC_FRAME_CONTROL,
  NATIVE_WEBRTC_FRAME_DATA,
  PTY_FRAME_DATA,
  PTY_FRAME_RESIZE,
  PUBSUB_DISCOVERY_INTERVAL_MS,
  PUBSUB_DISCOVERY_TOPIC,
  PtyFrameDecoder,
  TrysteroStream,
  WebRtcStream,
  browserDialableAddress,
  createRelayDialPlan,
  createWebRtcClientChallenge,
  createWebRtcActionHub,
  createNostrSignalingSession,
  createTorrentSignalingSession,
  decodeNativeWebRtcControl,
  decodeNativeWebRtcFrame,
  decodeWebRtcAuthResponse,
  defaultRtcConfiguration,
  decodePtyResize,
  encodePtyData,
  encodePtyResize,
  encodeNativeWebRtcFrame,
  encodeWebRtcAuthResponse,
  normalizeRelayAddress,
  preferDialAddresses,
  protocolForService,
  signWebRtcAuthResponse,
  verifyWebRtcAuthResponse,
  webRtcAuthPayload,
  webRtcClientIdFromChallenge,
  webRtcRoomId,
  validateService
} from '../src/index.js'

class FakeSignalingWebSocket {
  static sockets = new Set()

  constructor (url) {
    this.url = url
    this.readyState = 0
    this.subscriptionId = null
    this.filter = null
    this.infoHash = null
    this.peerId = null
    FakeSignalingWebSocket.sockets.add(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.()
    })
  }

  send (raw) {
    const message = JSON.parse(raw)
    if (Array.isArray(message)) {
      if (message[0] === 'REQ') {
        this.subscriptionId = message[1]
        this.filter = message[2]
      } else if (message[0] === 'EVENT') {
        for (const socket of FakeSignalingWebSocket.sockets) {
          if (socket.url !== this.url || socket.readyState !== 1 || socket.subscriptionId == null) continue
          const event = message[1]
          const topic = event.tags.find(tag => tag[0] === 't')?.[1]
          if (!socket.filter?.['#t']?.includes(topic)) continue
          queueMicrotask(() => socket.onmessage?.({
            data: JSON.stringify(['EVENT', socket.subscriptionId, event])
          }))
        }
      }
      return
    }

    if (message.action !== 'announce') return
    this.infoHash = message.info_hash
    this.peerId = message.peer_id
    for (const offer of message.offers ?? []) {
      for (const socket of FakeSignalingWebSocket.sockets) {
        if (
          socket === this ||
          socket.url !== this.url ||
          socket.readyState !== 1 ||
          socket.infoHash !== message.info_hash
        ) continue
        queueMicrotask(() => socket.onmessage?.({
          data: JSON.stringify({
            action: 'announce',
            info_hash: message.info_hash,
            peer_id: message.peer_id,
            offer_id: offer.offer_id,
            offer: offer.offer
          })
        }))
      }
    }
    if (message.answer != null) {
      for (const socket of FakeSignalingWebSocket.sockets) {
        if (
          socket.url !== this.url ||
          socket.readyState !== 1 ||
          socket.infoHash !== message.info_hash ||
          socket.peerId !== message.to_peer_id
        ) continue
        queueMicrotask(() => socket.onmessage?.({
          data: JSON.stringify({
            action: 'announce',
            info_hash: message.info_hash,
            peer_id: message.peer_id,
            offer_id: message.offer_id,
            answer: message.answer
          })
        }))
      }
    }
  }

  close () {
    if (this.readyState === 3) return
    this.readyState = 3
    FakeSignalingWebSocket.sockets.delete(this)
    queueMicrotask(() => this.onclose?.())
  }
}

test('PTY codec is browser-safe and preserves fragmented frames', () => {
  const data = encodePtyData(new TextEncoder().encode('hello'))
  const resize = encodePtyResize(132, 43)
  const combined = new Uint8Array(data.byteLength + resize.byteLength)
  combined.set(data)
  combined.set(resize, data.byteLength)

  const decoder = new PtyFrameDecoder()
  assert.deepEqual(decoder.push(combined.slice(0, 3)), [])
  const frames = decoder.push(combined.slice(3))
  decoder.finish()

  assert.equal(frames[0].type, PTY_FRAME_DATA)
  assert.equal(new TextDecoder().decode(frames[0].data), 'hello')
  assert.equal(frames[1].type, PTY_FRAME_RESIZE)
  assert.deepEqual(decodePtyResize(frames[1].data), { columns: 132, rows: 43 })
  assert.throws(() => new PtyFrameDecoder().push(Uint8Array.from([0, 0, 16, 0, 1])), /exceeds/)
})

test('native WebRTC wire codec preserves binary data and control messages', () => {
  const data = decodeNativeWebRtcFrame(encodeNativeWebRtcFrame(
    NATIVE_WEBRTC_FRAME_DATA,
    Uint8Array.from([0, 255, 42])
  ))
  const control = decodeNativeWebRtcFrame(encodeNativeWebRtcFrame(
    NATIVE_WEBRTC_FRAME_CONTROL,
    'ack:42'
  ))

  assert.equal(data.type, NATIVE_WEBRTC_FRAME_DATA)
  assert.deepEqual([...data.payload], [0, 255, 42])
  assert.equal(control.type, NATIVE_WEBRTC_FRAME_CONTROL)
  assert.equal(decodeNativeWebRtcControl(control.payload), 'ack:42')
  assert.throws(() => decodeNativeWebRtcFrame(Uint8Array.from([99, 0])), /Unsupported/)
})

test('native Nostr signaling exchanges signed room-scoped messages', async () => {
  const roomId = 'nostr-test-room'
  const url = 'wss://nostr.test/'
  const statuses = []
  const server = await createNostrSignalingSession({
    roomId,
    peerId: 'SERVER12345678901234',
    urls: [url],
    WebSocket: FakeSignalingWebSocket,
    onStatus: status => statuses.push(status)
  })
  const client = await createNostrSignalingSession({
    roomId,
    peerId: 'CLIENT12345678901234',
    urls: [url],
    WebSocket: FakeSignalingWebSocket
  })
  await Promise.all([server.ready, client.ready])

  const offer = nextSignal(server)
  await client.publish({ type: 'offer', sessionId: 'session-1234', sdp: 'offer-sdp' })
  const signal = await offer.catch(error => {
    throw new Error(`${error.message}: ${JSON.stringify(statuses)}`, { cause: error })
  })
  assert.deepEqual(signal, {
    version: 2,
    room: server.topic,
    type: 'offer',
    sessionId: 'session-1234',
    from: client.peerId,
    createdAt: signal.createdAt,
    sdp: 'offer-sdp'
  })

  await Promise.all([server.close(), client.close()])
})

function nextSignal (session, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`${session.name} signal timeout`))
    }, timeoutMs)
    const unsubscribe = session.subscribe(message => {
      clearTimeout(timeout)
      unsubscribe()
      resolve(message)
    })
  })
}

test('native BitTorrent signaling routes offer and addressed answer', async () => {
  const roomId = 'torrent-test-room'
  const url = 'wss://tracker.test/'
  const server = await createTorrentSignalingSession({
    roomId,
    peerId: 'SERVER12345678901234',
    urls: [url],
    WebSocket: FakeSignalingWebSocket
  })
  const client = await createTorrentSignalingSession({
    roomId,
    peerId: 'CLIENT12345678901234',
    urls: [url],
    WebSocket: FakeSignalingWebSocket
  })
  await Promise.all([server.ready, client.ready])

  const receivedOffer = nextSignal(server)
  await client.publish({ type: 'offer', sessionId: 'session-5678', sdp: 'offer-sdp' })
  const offer = await receivedOffer
  assert.equal(offer.from, client.peerId)
  assert.equal(offer.sdp, 'offer-sdp')

  const receivedAnswer = nextSignal(client)
  await server.publish({
    type: 'answer',
    sessionId: offer.sessionId,
    to: offer.from,
    sdp: 'answer-sdp'
  })
  const answer = await receivedAnswer
  assert.equal(answer.from, server.peerId)
  assert.equal(answer.sdp, 'answer-sdp')

  await Promise.all([server.close(), client.close()])
})

test('общая сеть использует одну PubSub-тему и переданный STUN-пул', () => {
  assert.equal(PUBSUB_DISCOVERY_TOPIC, 'io.github.santaklouse.p2p-netcat.peer-discovery.v1')
  assert.equal(PUBSUB_DISCOVERY_INTERVAL_MS, 10_000)
  assert.deepEqual(DEFAULT_STUN_URLS, [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
    'stun:stun.counterpath.com:3478',
    'stun:stun.sipgate.net:3478',
    'stun:stun.voipbuster.com:3478',
    'stun:stun.internetcalls.com:3478'
  ])

  const first = defaultRtcConfiguration()
  const second = defaultRtcConfiguration()
  assert.deepEqual(first.iceServers[0].urls, DEFAULT_STUN_URLS)
  assert.notEqual(first.iceServers[0].urls, second.iceServers[0].urls)
})

test('общая библиотека валидирует логический порт и protocol id', () => {
  assert.equal(validateService('8080'), 8080)
  assert.equal(protocolForService(8080), '/p2p-netcat/1.0.0/8080')
  assert.throws(() => validateService(0), /от 1 до 65535/)
  assert.throws(() => validateService(65536), /от 1 до 65535/)
})

test('общая библиотека строит неизменяемый relay dial plan', async () => {
  const relayId = '12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW'
  const targetId = '12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9'
  const relay = `/ip4/127.0.0.1/tcp/9091/ws/p2p/${relayId}`
  const plan = createRelayDialPlan({
    peerId: targetId,
    service: 31337,
    relay,
    requireWebSocket: true
  })

  assert.equal(plan.protocol, '/p2p-netcat/1.0.0/31337')
  assert.equal(plan.destination, `${relay}/p2p-circuit/p2p/${targetId}`)
  assert.ok(Object.isFrozen(plan))
})

test('общая библиотека применяет browser security policy к relay', async () => {
  const relayId = '12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW'
  const ws = `/dns4/relay.example/tcp/443/ws/p2p/${relayId}`
  const wss = `/dns4/relay.example/tcp/443/wss/p2p/${relayId}`

  assert.throws(() => normalizeRelayAddress(ws, { secureContext: true }), /защищённому \/wss/)
  assert.equal(normalizeRelayAddress(wss, { requireWebSocket: true, secureContext: true }), wss)
  assert.equal(browserDialableAddress(wss, { secureContext: true }), true)
  assert.equal(browserDialableAddress('/ip4/127.0.0.1/tcp/9090', { secureContext: true }), false)
})

test('общая сортировка предпочитает WebRTC и QUIC, relay оставляет последним', () => {
  assert.ok(preferDialAddresses('/ip4/127.0.0.1/udp/1/webrtc-direct', '/ip4/127.0.0.1/udp/1/quic-v1') < 0)
  assert.ok(preferDialAddresses('/ip4/127.0.0.1/udp/1/quic-v1', '/ip4/127.0.0.1/tcp/1') < 0)
  assert.ok(preferDialAddresses('/ip4/127.0.0.1/tcp/1', '/ip4/127.0.0.1/tcp/2/ws/p2p/relay/p2p-circuit') < 0)
})

test('WebRTC room и authentication frame детерминированы', async () => {
  const targetId = '12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9'
  const challenge = new Uint8Array(32).fill(7)
  assert.equal(webRtcRoomId(targetId, 31337), `${targetId}:31337`)
  assert.ok(webRtcAuthPayload(targetId, 31337, challenge).byteLength > challenge.byteLength)
  const encoded = encodeWebRtcAuthResponse(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]))
  const decoded = decodeWebRtcAuthResponse(encoded)
  assert.deepEqual([...decoded.publicKey], [1, 2, 3])
  assert.deepEqual([...decoded.signature], [4, 5])
})

test('core подписывает и проверяет native WebRTC challenge по точному PeerId', async () => {
  const privateKey = await generateKeyPair('Ed25519')
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const response = await signWebRtcAuthResponse(privateKey, 31337, challenge)

  assert.equal(await verifyWebRtcAuthResponse(response, peerId, 31337, challenge), true)
  assert.equal(await verifyWebRtcAuthResponse(response, peerId, 31338, challenge), false)
})

test('native и legacy WebRTC attempts используют одну client-session identity', () => {
  const clientId = 'ClientSession1234567'
  const challenge = createWebRtcClientChallenge(clientId)

  assert.equal(challenge.byteLength, 32)
  assert.equal(webRtcClientIdFromChallenge(challenge), clientId)
  assert.equal(webRtcClientIdFromChallenge(new Uint8Array(31)), null)
})

test('legacy Trystero stream export remains an alias during migration', () => {
  assert.equal(TrysteroStream, WebRtcStream)
})

test('WebRTC action hub owns action mapping and reconnects the same stream', async () => {
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
  const reconnected = []
  const hub = createWebRtcActionHub(room, {
    reconnectGraceMs: 1_000,
    onStream: (stream, peerId) => opened.push({ stream, peerId }),
    onPeerReconnected: peerId => reconnected.push(peerId)
  })

  room.onPeerJoin('remote-1')
  const stream = opened[0].stream
  room.onPeerLeave('remote-1')
  room.onPeerJoin('remote-1')

  assert.equal(opened.length, 1)
  assert.equal(stream.connectionStatus, 'connected')
  assert.deepEqual(reconnected, ['remote-1'])

  await hub.close()
  assert.equal(leaveCount, 1)
  assert.equal(stream.status, 'closed')
})

test('WebRTC stream сохраняет порядок, backpressure и EOF', async () => {
  const sent = []
  const controls = []
  const stream = new WebRtcStream({
    sendData: async bytes => sent.push([...bytes]),
    sendControl: async control => controls.push(control),
    keepAliveIntervalMs: 0
  })
  assert.equal(stream.send(new Uint8Array([1, 2])), false)
  await stream.onDrain()
  assert.deepEqual(sent, [[1, 2]])
  stream.receiveData(new Uint8Array([3, 4]))
  stream.receiveControl('eof')
  const received = []
  for await (const bytes of stream) received.push([...bytes])
  assert.deepEqual(received, [[3, 4]])
  await stream.close()
  assert.deepEqual(controls, ['flow:1', 'ack:2', 'eof'])
  assert.equal(stream.status, 'closed')
})

test('WebRTC stream limits unacknowledged output until the consumer advances', async () => {
  let sender
  let receiver
  sender = new WebRtcStream({
    flowWindowBytes: 4,
    keepAliveIntervalMs: 0,
    sendData: bytes => receiver.receiveData(bytes),
    sendControl: control => receiver.receiveControl(control)
  })
  receiver = new WebRtcStream({
    flowWindowBytes: 4,
    keepAliveIntervalMs: 0,
    sendData: bytes => sender.receiveData(bytes),
    sendControl: control => sender.receiveControl(control)
  })
  await new Promise(resolve => setImmediate(resolve))

  sender.send(Uint8Array.from([1, 2, 3, 4]))
  await sender.onDrain()
  sender.send(Uint8Array.from([5]))
  const blockedDrain = sender.onDrain()
  let drained = false
  void blockedDrain.then(() => {
    drained = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(drained, false)

  const iterator = receiver[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), {
    value: Uint8Array.from([1, 2, 3, 4]),
    done: false
  })
  const second = iterator.next()
  assert.deepEqual(await second, {
    value: Uint8Array.from([5]),
    done: false
  })
  await blockedDrain

  const completed = iterator.next()
  await sender.close()
  assert.deepEqual(await completed, { value: undefined, done: true })
  await receiver.close()
})

test('WebRTC stream preserves queued data while the peer reconnects', async () => {
  const sent = []
  const controls = []
  const stream = new WebRtcStream({
    keepAliveIntervalMs: 0,
    sendData: async bytes => sent.push([...bytes]),
    sendControl: async control => controls.push(control)
  })
  await new Promise(resolve => setImmediate(resolve))

  stream.peerDisconnected(1_000)
  assert.equal(stream.connectionStatus, 'reconnecting')
  stream.send(Uint8Array.from([7, 8, 9]))
  const drain = stream.onDrain()
  let drained = false
  void drain.then(() => {
    drained = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(drained, false)
  assert.deepEqual(sent, [])

  assert.equal(stream.peerReconnected(), true)
  await drain
  assert.equal(stream.connectionStatus, 'connected')
  assert.deepEqual(sent, [[7, 8, 9]])
  assert.ok(controls.includes('resume'))
  await stream.close()
})

test('WebRTC stream closes only after the reconnect grace period expires', async () => {
  const stream = new WebRtcStream({
    keepAliveIntervalMs: 0,
    sendData: async () => {},
    sendControl: async () => {}
  })

  stream.peerDisconnected(20)
  assert.equal(stream.status, 'open')
  assert.equal(stream.connectionStatus, 'reconnecting')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(stream.status, 'closed')
  assert.equal(stream.connectionStatus, 'disconnected')
})

test('WebRTC stream retries a write that raced with peer disconnection', async () => {
  let attempts = 0
  const sent = []
  const stream = new WebRtcStream({
    keepAliveIntervalMs: 0,
    sendData: async bytes => {
      attempts += 1
      if (attempts === 1) throw new Error('data channel closed during send')
      sent.push([...bytes])
    },
    sendControl: async () => {}
  })

  stream.send(Uint8Array.from([4, 2]))
  const drain = stream.onDrain()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stream.connectionStatus, 'reconnecting')
  assert.deepEqual(sent, [])

  stream.peerReconnected()
  await drain
  assert.equal(attempts, 2)
  assert.deepEqual(sent, [[4, 2]])
  await stream.close()
})
