import wrtc from '@roamhq/wrtc'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import {
  WEBRTC_RECONNECT_GRACE_MS,
  connectNativeWebRtc,
  createNostrSignalingSession,
  createSignalingPeerId,
  createTorrentSignalingSession,
  defaultRtcConfiguration,
  signWebRtcAuthResponse,
  startNativeWebRtcListener,
  verifyWebRtcAuthResponse,
  webRtcRoomId
} from 'p2p-netcat-core'

const { RTCPeerConnection } = wrtc

function verboseLog (enabled, message) {
  if (enabled) process.stderr.write(`[p2p-nc] ${message}\n`)
}

function nativeStatusLog (verbose, status) {
  if (!verbose || !['open', 'error', 'closed'].includes(status.state)) return
  const detail = status.detail == null ? '' : ` (${status.detail})`
  verboseLog(true, `WebRTC/${status.adapter}: ${status.url}: ${status.state}${detail}`)
}

async function createNativeSessions (roomId, signalingPeerId, verbose, pairingToken) {
  const options = {
    roomId,
    peerId: signalingPeerId,
    WebSocket: globalThis.WebSocket,
    onStatus: status => nativeStatusLog(verbose, status),
    pairingToken
  }
  const results = await Promise.allSettled([
    createNostrSignalingSession(options),
    createTorrentSignalingSession(options)
  ])
  const sessions = results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
  for (const result of results) {
    if (result.status === 'rejected') {
      verboseLog(verbose, `WebRTC/native signaling не запущен: ${result.reason?.message ?? result.reason}`)
    }
  }
  if (sessions.length === 0) throw new Error('Не удалось запустить собственный WebRTC signaling')
  return sessions
}

export async function startWebRtcListener ({
  privateKey,
  service,
  onStream,
  verbose = false,
  pairingToken
}) {
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const roomId = webRtcRoomId(peerId, service)
  const signalingPeerId = createSignalingPeerId()
  const signalingSessions = await createNativeSessions(
    roomId,
    signalingPeerId,
    verbose,
    pairingToken
  )

  const listener = startNativeWebRtcListener({
    signalingSessions,
    RTCPeerConnection,
    rtcConfig: defaultRtcConfiguration(),
    createAuthResponse: challenge => signWebRtcAuthResponse(privateKey, service, challenge),
    onStream: (stream, remoteId, strategy) => {
      verboseLog(verbose, `WebRTC/${strategy}: собственный прямой канал установлен с ${remoteId}`)
      onStream?.(stream, remoteId, strategy)
    },
    onPeerDisconnected: remoteId => {
      verboseLog(
        verbose,
        `WebRTC/native: канал ${remoteId} потерян; жду восстановление до ${WEBRTC_RECONNECT_GRACE_MS / 1000} с`
      )
    },
    onPeerReconnected: (remoteId, _stream, strategy) => {
      verboseLog(verbose, `WebRTC/${strategy}: канал ${remoteId} восстановлен`)
    },
    onState: (strategy, remoteId, state) => {
      verboseLog(
        verbose,
        `WebRTC/${strategy}: ${remoteId}: connection=${state.connectionState}, ICE=${state.iceConnectionState}`
      )
    },
    onLog: message => verboseLog(verbose, `WebRTC/native: ${message}`)
  })
  verboseLog(verbose, 'WebRTC: собственный Nostr/BitTorrent signaling запущен')
  if (pairingToken != null) {
    verboseLog(verbose, 'WebRTC: приватный режим использует зашифрованный native signaling')
  }

  return listener
}

export function connectWebRtc ({
  peerId,
  service,
  timeoutMs = 30_000,
  verbose = false,
  pairingToken
}) {
  const roomId = webRtcRoomId(peerId, service)
  const signalingPeerId = createSignalingPeerId()
  let connection
  let closed = false

  const promise = (async () => {
    const signalingSessions = await createNativeSessions(
      roomId,
      signalingPeerId,
      verbose,
      pairingToken
    )
    if (closed) {
      await Promise.allSettled(signalingSessions.map(session => session.close()))
      throw new Error('WebRTC-подключение отменено')
    }

    connection = connectNativeWebRtc({
      signalingSessions,
      RTCPeerConnection,
      rtcConfig: defaultRtcConfiguration(),
      timeoutMs,
      verifyAuthResponse: async (value, challenge) => {
        const valid = await verifyWebRtcAuthResponse(value, peerId, service, challenge)
        if (!valid) throw new Error('некорректная подпись PeerId')
        verboseLog(verbose, `WebRTC/native: PeerId ${peerId} подтверждён`)
        return true
      },
      onReconnecting: () => verboseLog(
        verbose,
        `WebRTC/native: канал потерян; жду переподключение до ${WEBRTC_RECONNECT_GRACE_MS / 1000} с`
      ),
      onReconnected: (_stream, strategy) => {
        verboseLog(verbose, `WebRTC/${strategy}: канал восстановлен`)
      },
      onState: (strategy, remoteId, state) => verboseLog(
        verbose,
        `WebRTC/${strategy}: ${remoteId}: connection=${state.connectionState}, ICE=${state.iceConnectionState}`
      ),
      onLog: message => verboseLog(verbose, `WebRTC/native: ${message}`)
    })
    verboseLog(verbose, 'WebRTC/native: ищу пир через собственные Nostr и BitTorrent adapters')
    const stream = await connection.promise
    verboseLog(verbose, `WebRTC: выбран ${stream.signalingStrategy ?? 'native signaling'}`)
    return stream
  })().catch(error => {
    if (closed) throw new Error('WebRTC-подключение отменено', { cause: error })
    throw new Error(`WebRTC не нашёл ${peerId}:${service}: ${error.message}`, { cause: error })
  })

  return {
    promise,
    async close () {
      if (closed) return
      closed = true
      await connection?.close()
    }
  }
}
