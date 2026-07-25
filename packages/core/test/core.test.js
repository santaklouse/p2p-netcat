import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STUN_URLS,
  PTY_FRAME_DATA,
  PTY_FRAME_RESIZE,
  PUBSUB_DISCOVERY_INTERVAL_MS,
  PUBSUB_DISCOVERY_TOPIC,
  PtyFrameDecoder,
  TrysteroStream,
  WebRtcStream,
  browserDialableAddress,
  createRelayDialPlan,
  createWebRtcActionHub,
  decodeWebRtcAuthResponse,
  defaultRtcConfiguration,
  decodePtyResize,
  encodePtyData,
  encodePtyResize,
  encodeWebRtcAuthResponse,
  normalizeRelayAddress,
  preferDialAddresses,
  protocolForService,
  webRtcAuthPayload,
  webRtcRoomId,
  validateService
} from '../src/index.js'

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
