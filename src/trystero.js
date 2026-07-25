import wrtc from '@roamhq/wrtc'
import { publicKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPublicKey, peerIdFromPrivateKey } from '@libp2p/peer-id'
import {
  defaultRelayUrls,
  getRelaySockets,
  joinRoom,
  pauseRelayReconnection,
  resumeRelayReconnection
} from '@trystero-p2p/torrent'
import {
  TRYSTERO_APP_ID,
  TrysteroStream,
  defaultRtcConfiguration,
  decodeTrysteroAuthResponse,
  encodeTrysteroAuthResponse,
  trysteroAuthPayload,
  trysteroRoomId
} from 'p2p-netcat-core'

const { RTCPeerConnection } = wrtc
const DATA_ACTION = 'pnc-data-v1'
const CONTROL_ACTION = 'pnc-ctl-v1'

function bytes (value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new Error('Trystero передал данные неизвестного типа')
}

function roomConfig () {
  return {
    appId: TRYSTERO_APP_ID,
    rtcPolyfill: RTCPeerConnection,
    trickleIce: true,
    rtcConfig: defaultRtcConfiguration(),
    relayConfig: {
      urls: [...defaultRelayUrls],
      warnOnRelayFailure: false
    }
  }
}

function closeRelaySockets () {
  pauseRelayReconnection()
  for (const socket of Object.values(getRelaySockets())) {
    const close = () => {
      try {
        socket.close()
      } catch {}
    }
    if (socket.readyState === 0) socket.addEventListener('open', close, { once: true })
    else close()
  }
}

function createHub (room, { onStream, leaveAfterStream = false } = {}) {
  const streams = new Map()
  const data = room.makeAction(DATA_ACTION)
  const control = room.makeAction(CONTROL_ACTION)

  const streamFor = peerId => {
    let stream = streams.get(peerId)
    if (stream != null) return stream
    stream = new TrysteroStream({
      sendData: chunk => data.send(chunk, { target: peerId }),
      sendControl: value => control.send(value, { target: peerId }),
      onFinalize: () => {
        streams.delete(peerId)
        if (leaveAfterStream) void room.leave()
      }
    })
    streams.set(peerId, stream)
    return stream
  }

  data.onMessage = (chunk, { peerId }) => streamFor(peerId).receiveData(bytes(chunk))
  control.onMessage = (value, { peerId }) => streamFor(peerId).receiveControl(String(value))
  room.onPeerJoin = peerId => onStream?.(streamFor(peerId), peerId)
  room.onPeerLeave = peerId => {
    streams.get(peerId)?.peerLeft()
    streams.delete(peerId)
  }

  return {
    streamFor,
    async close () {
      for (const stream of streams.values()) stream.peerLeft()
      streams.clear()
      await room.leave()
      closeRelaySockets()
    }
  }
}

export function startTrysteroListener ({ privateKey, service, onStream, verbose = false }) {
  resumeRelayReconnection()
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const roomId = trysteroRoomId(peerId, service)
  const room = joinRoom(roomConfig(), roomId, {
    handshakeTimeoutMs: 12_000,
    onPeerHandshake: async (_remoteId, _send, receive) => {
      const request = await receive()
      const challenge = bytes(request.data)
      const signature = await privateKey.sign(trysteroAuthPayload(peerId, service, challenge))
      await _send(encodeTrysteroAuthResponse(publicKeyToProtobuf(privateKey.publicKey), signature))
    },
    onJoinError: ({ error }) => {
      if (verbose) process.stderr.write(`[p2p-nc] Trystero handshake отклонён: ${error}\n`)
    }
  })
  const hub = createHub(room, { onStream })
  if (verbose) process.stderr.write(`[p2p-nc] Trystero/WebRTC room активна для ${peerId}:${service}\n`)
  return hub
}

export function connectTrystero ({ peerId, service, timeoutMs = 30_000, verbose = false }) {
  resumeRelayReconnection()
  const roomId = trysteroRoomId(peerId, service)
  let settled = false
  let rejectAttempt
  let timeout
  let hub

  const room = joinRoom(roomConfig(), roomId, {
    handshakeTimeoutMs: 12_000,
    onPeerHandshake: async (_remoteId, send, receive) => {
      const challenge = crypto.getRandomValues(new Uint8Array(32))
      await send(challenge)
      const response = decodeTrysteroAuthResponse((await receive()).data)
      const publicKey = publicKeyFromProtobuf(response.publicKey)
      const authenticatedPeerId = peerIdFromPublicKey(publicKey).toString()
      if (authenticatedPeerId !== peerId) throw new Error(`Trystero peer предъявил другой PeerId: ${authenticatedPeerId}`)
      const valid = await publicKey.verify(trysteroAuthPayload(peerId, service, challenge), response.signature)
      if (!valid) throw new Error('Некорректная подпись Trystero PeerId')
    },
    onJoinError: ({ error }) => {
      if (verbose) process.stderr.write(`[p2p-nc] Trystero peer отклонён: ${error}\n`)
    }
  })

  const promise = new Promise((resolve, reject) => {
    rejectAttempt = reject
    hub = createHub(room, {
      leaveAfterStream: true,
      onStream: (stream, remoteId) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (verbose) process.stderr.write(`[p2p-nc] прямой Trystero/WebRTC-канал установлен: ${remoteId}\n`)
        resolve(stream)
      }
    })
    timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void hub.close()
      reject(new Error(`Trystero/WebRTC не нашёл ${peerId}:${service} за ${Math.ceil(timeoutMs / 1000)} с`))
    }, timeoutMs)
  })

  return {
    promise,
    async close () {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        rejectAttempt?.(new Error('Trystero/WebRTC-подключение отменено'))
      }
      await hub.close()
    }
  }
}
