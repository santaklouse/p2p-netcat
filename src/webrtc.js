import wrtc from '@roamhq/wrtc'

// Trystero packages are temporary signaling adapters behind the project-owned WebRTC API.
import { publicKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPublicKey, peerIdFromPrivateKey } from '@libp2p/peer-id'
import {
  getRelaySockets as getNostrRelaySockets,
  joinRoom as joinNostrRoom
} from '@trystero-p2p/nostr'
import {
  defaultRelayUrls as defaultTorrentRelayUrls,
  getRelaySockets as getTorrentRelaySockets,
  joinRoom as joinTorrentRoom,
  pauseRelayReconnection,
  resumeRelayReconnection
} from '@trystero-p2p/torrent'
import {
  WEBRTC_APP_ID,
  WEBRTC_RECONNECT_GRACE_MS,
  connectNativeWebRtc,
  createNostrSignalingSession,
  createSignalingPeerId,
  createTorrentSignalingSession,
  createWebRtcClientChallenge,
  createWebRtcActionHub,
  defaultRtcConfiguration,
  decodeWebRtcAuthResponse,
  encodeWebRtcAuthResponse,
  signWebRtcAuthResponse,
  startNativeWebRtcListener,
  verifyWebRtcAuthResponse,
  webRtcAuthPayload,
  webRtcClientIdFromChallenge,
  webRtcRoomId
} from 'p2p-netcat-core'

const { RTCPeerConnection } = wrtc
const RELAY_STATUS_DELAY_MS = 1_500
const SEARCH_PROGRESS_INTERVAL_MS = 5_000
const LEGACY_FALLBACK_DELAY_MS = 4_000

const SIGNALING_STRATEGIES = [
  {
    id: 'nostr',
    label: 'Nostr',
    joinRoom: joinNostrRoom,
    getRelaySockets: getNostrRelaySockets,
    relayConfig: {
      redundancy: 5,
      warnOnRelayFailure: false
    }
  },
  {
    id: 'torrent',
    label: 'BitTorrent',
    joinRoom: joinTorrentRoom,
    getRelaySockets: getTorrentRelaySockets,
    relayConfig: {
      urls: [...defaultTorrentRelayUrls],
      warnOnRelayFailure: false
    }
  }
]

let activeRoomCount = 0

function verboseLog (enabled, message) {
  if (enabled) process.stderr.write(`[p2p-nc] ${message}\n`)
}

function bytes (value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new Error('WebRTC signaling передал данные неизвестного типа')
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
    if (result.status === 'rejected') verboseLog(verbose, `WebRTC/native signaling не запущен: ${result.reason?.message ?? result.reason}`)
  }
  if (sessions.length === 0) throw new Error('Не удалось запустить собственный WebRTC signaling')
  return sessions
}

function roomConfig (strategy) {
  return {
    appId: WEBRTC_APP_ID,
    rtcPolyfill: RTCPeerConnection,
    trickleIce: true,
    rtcConfig: defaultRtcConfiguration(),
    relayConfig: strategy.relayConfig
  }
}

function retainRelaySession () {
  if (activeRoomCount === 0) resumeRelayReconnection()
  activeRoomCount += 1
}

function closeRelaySocket (socket) {
  const close = () => {
    try {
      socket.close()
    } catch {}
  }

  if (socket.readyState === 0) socket.addEventListener('open', close, { once: true })
  else close()
}

function releaseRelaySession () {
  activeRoomCount = Math.max(0, activeRoomCount - 1)
  if (activeRoomCount !== 0) return

  pauseRelayReconnection()
  for (const strategy of SIGNALING_STRATEGIES) {
    for (const socket of Object.values(strategy.getRelaySockets())) closeRelaySocket(socket)
  }
}

function relayStatus (strategy) {
  const sockets = Object.values(strategy.getRelaySockets())
  const open = sockets.filter(socket => socket.readyState === 1).length
  const connecting = sockets.filter(socket => socket.readyState === 0).length
  return `${strategy.label} ${open}/${sockets.length} открыто${connecting > 0 ? `, ${connecting} подключается` : ''}`
}

function signalingStatus () {
  return SIGNALING_STRATEGIES.map(relayStatus).join('; ')
}

function watchPeerConnection (room, remoteId, strategy, verbose) {
  if (!verbose) return
  const connection = room.getPeers()[remoteId]
  if (connection == null) return
  let previous
  const report = () => {
    const state = `connection=${connection.connectionState}, ICE=${connection.iceConnectionState}`
    if (state === previous) return
    previous = state
    verboseLog(true, `WebRTC/${strategy.label}: ${remoteId}: ${state}`)
  }
  connection.addEventListener?.('connectionstatechange', report)
  connection.addEventListener?.('iceconnectionstatechange', report)
  report()
}

function joinStrategyRoom (strategy, roomId, callbacks) {
  retainRelaySession()
  try {
    const room = strategy.joinRoom(roomConfig(strategy), roomId, callbacks)
    return { room, release: releaseRelaySession }
  } catch (error) {
    releaseRelaySession()
    throw error
  }
}

function startStrategyListener ({
  strategy,
  privateKey,
  peerId,
  service,
  roomId,
  onStream,
  onStreamClosed,
  verbose
}) {
  const authenticatedRemoteIds = new Map()
  const joined = joinStrategyRoom(strategy, roomId, {
    handshakeTimeoutMs: 12_000,
    onPeerHandshake: async (remoteId, send, receive) => {
      verboseLog(verbose, `WebRTC/${strategy.label}: найден кандидат ${remoteId}, подписываю проверочный запрос`)
      const request = await receive()
      const challenge = bytes(request.data)
      authenticatedRemoteIds.set(remoteId, webRtcClientIdFromChallenge(challenge) ?? remoteId)
      const signature = await privateKey.sign(webRtcAuthPayload(peerId, service, challenge))
      await send(encodeWebRtcAuthResponse(publicKeyToProtobuf(privateKey.publicKey), signature))
      verboseLog(verbose, `WebRTC/${strategy.label}: проверочный ответ отправлен кандидату ${remoteId}`)
    },
    onJoinError: ({ error, peerId: remoteId }) => {
      verboseLog(verbose, `WebRTC/${strategy.label}: кандидат ${remoteId ?? 'unknown'} отклонён: ${error}`)
    }
  })

  const hub = createWebRtcActionHub(joined.room, {
    release: joined.release,
    onPeerDisconnected: (remoteId, stream) => {
      const logicalRemoteId = authenticatedRemoteIds.get(remoteId) ?? remoteId
      verboseLog(
        verbose,
        `WebRTC/${strategy.label}: канал ${remoteId} потерян; сохраняю сессию ${WEBRTC_RECONNECT_GRACE_MS / 1000} с для переподключения`
      )
      onStreamClosed?.(logicalRemoteId, stream, { temporary: true })
    },
    onPeerReconnected: (remoteId, stream) => {
      const logicalRemoteId = authenticatedRemoteIds.get(remoteId) ?? remoteId
      watchPeerConnection(joined.room, remoteId, strategy, verbose)
      verboseLog(verbose, `WebRTC/${strategy.label}: канал ${remoteId} восстановлен, продолжаю прежнюю сессию`)
      onStream?.(stream, logicalRemoteId, strategy, { reconnected: true })
    },
    onStreamClosed: (remoteId, stream) => {
      const logicalRemoteId = authenticatedRemoteIds.get(remoteId) ?? remoteId
      if (stream.connectionStatus === 'disconnected') {
        verboseLog(verbose, `WebRTC/${strategy.label}: срок ожидания ${remoteId} истёк, сессия закрыта`)
      }
      authenticatedRemoteIds.delete(remoteId)
      onStreamClosed?.(logicalRemoteId, stream)
    },
    onStream: (stream, remoteId) => {
      const logicalRemoteId = authenticatedRemoteIds.get(remoteId) ?? remoteId
      watchPeerConnection(joined.room, remoteId, strategy, verbose)
      onStream(stream, logicalRemoteId, strategy)
    }
  })
  verboseLog(verbose, `WebRTC/${strategy.label}: слушаю room для ${peerId}:${service}`)
  return hub
}

function startLegacyWebRtcListener ({ privateKey, service, onStream, onClosed, verbose = false }) {
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const roomId = webRtcRoomId(peerId, service)
  const activeStreams = new Map()
  const hubs = []

  const onStrategyStream = (stream, remoteId, strategy, { reconnected = false } = {}) => {
    if (reconnected) {
      if (activeStreams.get(remoteId) === stream) {
        verboseLog(verbose, `WebRTC/${strategy.label}: PTY/поток ${remoteId} успешно возобновлён`)
      }
      return
    }

    const current = activeStreams.get(remoteId)
    if (current != null) {
      verboseLog(verbose, `WebRTC/${strategy.label}: закрываю дублирующий канал кандидата ${remoteId}`)
      stream.abort(new Error('Другой signaling-канал уже установил соединение'))
      return
    }

    activeStreams.set(remoteId, stream)
    Object.defineProperty(stream, 'signalingStrategy', {
      configurable: true,
      value: strategy.label
    })
    verboseLog(verbose, `WebRTC/${strategy.label}: прямой канал установлен с ${remoteId}`)
    onStream?.(stream, remoteId, strategy.label)
  }

  const onStreamClosed = (remoteId, stream, { temporary = false } = {}) => {
    if (temporary) return
    if (activeStreams.get(remoteId) === stream) activeStreams.delete(remoteId)
    onClosed?.(remoteId, stream)
  }

  for (const strategy of SIGNALING_STRATEGIES) {
    try {
      hubs.push(startStrategyListener({
        strategy,
        privateKey,
        peerId,
        service,
        roomId,
        onStream: onStrategyStream,
        onStreamClosed,
        verbose
      }))
    } catch (error) {
      verboseLog(verbose, `WebRTC/${strategy.label}: signaling не запущен: ${error.message}`)
    }
  }

  if (hubs.length === 0) throw new Error('Не удалось запустить ни один WebRTC signaling-канал')

  const relayStatusTimer = verbose
    ? setTimeout(() => verboseLog(true, `WebRTC relay-состояние: ${signalingStatus()}`), RELAY_STATUS_DELAY_MS)
    : null
  relayStatusTimer?.unref?.()

  return {
    async close () {
      if (relayStatusTimer != null) clearTimeout(relayStatusTimer)
      activeStreams.clear()
      await Promise.allSettled(hubs.map(hub => hub.close()))
    }
  }
}

function connectWithStrategy ({ strategy, peerId, service, roomId, timeoutMs, verbose, signalingPeerId }) {
  let settled = false
  let rejectAttempt
  let timeout
  let hub

  const joined = joinStrategyRoom(strategy, roomId, {
    handshakeTimeoutMs: 12_000,
    onPeerHandshake: async (remoteId, send, receive) => {
      verboseLog(verbose, `WebRTC/${strategy.label}: найден кандидат ${remoteId}, проверяю PeerId`)
      const challenge = createWebRtcClientChallenge(signalingPeerId)
      await send(challenge)
      const response = decodeWebRtcAuthResponse((await receive()).data)
      const publicKey = publicKeyFromProtobuf(response.publicKey)
      const authenticatedPeerId = peerIdFromPublicKey(publicKey).toString()
      if (authenticatedPeerId !== peerId) throw new Error(`пир предъявил другой PeerId: ${authenticatedPeerId}`)
      const valid = await publicKey.verify(webRtcAuthPayload(peerId, service, challenge), response.signature)
      if (!valid) throw new Error('некорректная подпись PeerId')
      verboseLog(verbose, `WebRTC/${strategy.label}: PeerId ${peerId} подтверждён`)
    },
    onJoinError: ({ error, peerId: remoteId }) => {
      verboseLog(verbose, `WebRTC/${strategy.label}: кандидат ${remoteId ?? 'unknown'} отклонён: ${error}`)
    }
  })

  const promise = new Promise((resolve, reject) => {
    rejectAttempt = reject
    hub = createWebRtcActionHub(joined.room, {
      release: joined.release,
      leaveAfterStream: true,
      onPeerDisconnected: remoteId => {
        verboseLog(
          verbose,
          `WebRTC/${strategy.label}: канал ${remoteId} потерян; жду переподключение до ${WEBRTC_RECONNECT_GRACE_MS / 1000} с`
        )
      },
      onPeerReconnected: remoteId => {
        watchPeerConnection(joined.room, remoteId, strategy, verbose)
        verboseLog(verbose, `WebRTC/${strategy.label}: канал ${remoteId} восстановлен, поток продолжен`)
      },
      onStream: (stream, remoteId) => {
        if (settled) {
          stream.abort(new Error('Попытка подключения уже завершена'))
          return
        }
        settled = true
        clearTimeout(timeout)
        Object.defineProperty(stream, 'signalingStrategy', {
          configurable: true,
          value: strategy.label
        })
        watchPeerConnection(joined.room, remoteId, strategy, verbose)
        verboseLog(verbose, `WebRTC/${strategy.label}: прямой канал установлен с ${remoteId}`)
        resolve(stream)
      }
    })
    timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void hub.close()
      reject(new Error(`${strategy.label} не нашёл ${peerId}:${service}`))
    }, timeoutMs)
  })

  return {
    strategy,
    promise,
    async close () {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        rejectAttempt?.(new Error(`${strategy.label}-подключение отменено`))
      }
      await hub.close()
    }
  }
}

function connectLegacyWebRtc ({ peerId, service, timeoutMs = 30_000, verbose = false, signalingPeerId = createSignalingPeerId() }) {
  const roomId = webRtcRoomId(peerId, service)
  const attempts = []
  let closed = false

  verboseLog(verbose, 'WebRTC: запускаю параллельный поиск через Nostr и BitTorrent signaling')
  for (const strategy of SIGNALING_STRATEGIES) {
    try {
      attempts.push(connectWithStrategy({ strategy, peerId, service, roomId, timeoutMs, verbose, signalingPeerId }))
      verboseLog(verbose, `WebRTC/${strategy.label}: подключаюсь к публичным relay-узлам`)
    } catch (error) {
      verboseLog(verbose, `WebRTC/${strategy.label}: signaling не запущен: ${error.message}`)
    }
  }

  if (attempts.length === 0) {
    return {
      promise: Promise.reject(new Error('Не удалось запустить ни один WebRTC signaling-канал')),
      async close () {}
    }
  }

  const startedAt = Date.now()
  const reportProgress = () => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    verboseLog(verbose, `WebRTC: ищу ${peerId}:${service}, прошло ${seconds} с; ${signalingStatus()}`)
  }
  const firstStatusTimer = verbose ? setTimeout(reportProgress, RELAY_STATUS_DELAY_MS) : null
  const progressTimer = verbose ? setInterval(reportProgress, SEARCH_PROGRESS_INTERVAL_MS) : null
  firstStatusTimer?.unref?.()
  progressTimer?.unref?.()

  const clearProgress = () => {
    if (firstStatusTimer != null) clearTimeout(firstStatusTimer)
    if (progressTimer != null) clearInterval(progressTimer)
  }

  const promise = Promise.any(attempts.map(attempt => (
    attempt.promise.then(stream => ({ attempt, stream }))
  ))).then(async ({ attempt: winner, stream }) => {
    clearProgress()
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    verboseLog(verbose, `WebRTC: выбран signaling ${winner.strategy.label}, соединение заняло ${elapsedSeconds} с`)
    await Promise.allSettled(
      attempts.filter(attempt => attempt !== winner).map(attempt => attempt.close())
    )
    return stream
  }).catch(error => {
    clearProgress()
    if (closed) throw new Error('WebRTC-подключение отменено', { cause: error })
    const reasons = error instanceof AggregateError
      ? error.errors.map(item => item.message).join('; ')
      : error.message
    throw new Error(
      `WebRTC не нашёл ${peerId}:${service} за ${Math.ceil(timeoutMs / 1000)} с: ${reasons}`,
      { cause: error }
    )
  })

  return {
    promise,
    async close () {
      if (closed) return
      closed = true
      clearProgress()
      await Promise.allSettled(attempts.map(attempt => attempt.close()))
    }
  }
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
  const listeners = []
  const activeStreams = new Map()

  const acceptStream = (stream, remoteId, strategy) => {
    const current = activeStreams.get(remoteId)
    if (current === stream) {
      Object.defineProperty(stream, 'signalingStrategy', {
        configurable: true,
        value: strategy
      })
      return
    }
    if (current != null && current !== stream) {
      verboseLog(verbose, `WebRTC/${strategy}: закрываю дублирующий канал ${remoteId}`)
      stream.abort(new Error('Другой WebRTC signaling-канал уже установил соединение'))
      return
    }
    activeStreams.set(remoteId, stream)
    Object.defineProperty(stream, 'signalingStrategy', {
      configurable: true,
      value: strategy
    })
    onStream?.(stream, remoteId, strategy)
  }
  const forgetStream = (remoteId, stream) => {
    if (activeStreams.get(remoteId) === stream) activeStreams.delete(remoteId)
  }

  try {
    const signalingSessions = await createNativeSessions(roomId, signalingPeerId, verbose, pairingToken)
    listeners.push(startNativeWebRtcListener({
      signalingSessions,
      RTCPeerConnection,
      rtcConfig: defaultRtcConfiguration(),
      createAuthResponse: challenge => signWebRtcAuthResponse(privateKey, service, challenge),
      onStream: (stream, remoteId, strategy) => {
        verboseLog(verbose, `WebRTC/${strategy}: собственный прямой канал установлен с ${remoteId}`)
        acceptStream(stream, remoteId, strategy)
      },
      onStreamClosed: forgetStream,
      onPeerDisconnected: remoteId => {
        verboseLog(verbose, `WebRTC/native: канал ${remoteId} потерян; жду восстановление до ${WEBRTC_RECONNECT_GRACE_MS / 1000} с`)
      },
      onPeerReconnected: (remoteId, stream, strategy) => {
        verboseLog(verbose, `WebRTC/${strategy}: канал ${remoteId} восстановлен`)
        acceptStream(stream, remoteId, strategy)
      },
      onState: (strategy, remoteId, state) => {
        verboseLog(verbose, `WebRTC/${strategy}: ${remoteId}: connection=${state.connectionState}, ICE=${state.iceConnectionState}`)
      },
      onLog: message => verboseLog(verbose, `WebRTC/native: ${message}`)
    }))
    verboseLog(verbose, 'WebRTC: собственный Nostr/BitTorrent signaling запущен')
  } catch (error) {
    verboseLog(verbose, `WebRTC/native: listener не запущен: ${error.message}`)
  }

  if (pairingToken == null) {
    try {
      listeners.push(startLegacyWebRtcListener({
        privateKey,
        service,
        verbose,
        onStream: acceptStream,
        onClosed: forgetStream
      }))
      verboseLog(verbose, 'WebRTC/Trystero: временный fallback совместимости запущен')
    } catch (error) {
      verboseLog(verbose, `WebRTC/Trystero: fallback не запущен: ${error.message}`)
    }
  } else {
    verboseLog(verbose, 'WebRTC: приватный режим использует только зашифрованный native signaling')
  }

  if (listeners.length === 0) throw new Error('Не удалось запустить ни один WebRTC listener')

  return {
    async close () {
      activeStreams.clear()
      await Promise.allSettled(listeners.map(listener => listener.close()))
    }
  }
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
  const attempts = []
  let legacyAttempt
  let legacyTimer
  let closed = false
  let rejectDelayedLegacy

  const nativeAttempt = {
    strategy: { label: 'Native Nostr/BitTorrent' },
    connection: null,
    promise: (async () => {
      const signalingSessions = await createNativeSessions(roomId, signalingPeerId, verbose, pairingToken)
      if (closed) {
        await Promise.allSettled(signalingSessions.map(session => session.close()))
        throw new Error('WebRTC-подключение отменено')
      }
      nativeAttempt.connection = connectNativeWebRtc({
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
        onReconnected: (_stream, strategy) => verboseLog(verbose, `WebRTC/${strategy}: канал восстановлен`),
        onState: (strategy, remoteId, state) => verboseLog(
          verbose,
          `WebRTC/${strategy}: ${remoteId}: connection=${state.connectionState}, ICE=${state.iceConnectionState}`
        ),
        onLog: message => verboseLog(verbose, `WebRTC/native: ${message}`)
      })
      return nativeAttempt.connection.promise
    })(),
    async close () {
      await nativeAttempt.connection?.close()
    }
  }
  attempts.push(nativeAttempt)
  verboseLog(verbose, 'WebRTC/native: ищу пир через собственные Nostr и BitTorrent adapters')

  if (pairingToken == null) {
    const fallbackDelayMs = Math.min(LEGACY_FALLBACK_DELAY_MS, Math.max(500, Math.floor(timeoutMs / 4)))
    const delayedLegacy = {
      strategy: { label: 'Trystero fallback' },
      promise: new Promise((resolve, reject) => {
        rejectDelayedLegacy = reject
        legacyTimer = setTimeout(() => {
          legacyTimer = undefined
          if (closed) {
            reject(new Error('Trystero fallback отменён'))
            return
          }
          verboseLog(verbose, `WebRTC/Trystero: native-канал не найден за ${fallbackDelayMs / 1000} с, запускаю fallback`)
          legacyAttempt = connectLegacyWebRtc({
            peerId,
            service,
            timeoutMs: Math.max(1_000, timeoutMs - fallbackDelayMs),
            verbose,
            signalingPeerId
          })
          legacyAttempt.promise.then(resolve, reject)
        }, fallbackDelayMs)
        legacyTimer.unref?.()
      }),
      async close () {
        if (legacyTimer != null) {
          clearTimeout(legacyTimer)
          legacyTimer = undefined
          rejectDelayedLegacy?.(new Error('Trystero fallback отменён'))
        }
        await legacyAttempt?.close()
      }
    }
    delayedLegacy.promise.catch(() => {})
    attempts.push(delayedLegacy)
  } else {
    verboseLog(verbose, 'WebRTC: приватный режим не использует Trystero fallback')
  }

  const promise = Promise.any(attempts.map(attempt => (
    attempt.promise.then(stream => ({ attempt, stream }))
  ))).then(async ({ attempt: winner, stream }) => {
    await Promise.allSettled(attempts.filter(attempt => attempt !== winner).map(attempt => attempt.close()))
    verboseLog(verbose, `WebRTC: выбран ${winner.strategy.label}`)
    return stream
  }).catch(error => {
    if (closed) throw new Error('WebRTC-подключение отменено', { cause: error })
    const reasons = error instanceof AggregateError
      ? error.errors.map(item => item.message).join('; ')
      : error.message
    throw new Error(`WebRTC не нашёл ${peerId}:${service}: ${reasons}`, { cause: error })
  })

  return {
    promise,
    async close () {
      if (closed) return
      closed = true
      await Promise.allSettled(attempts.map(attempt => attempt.close()))
    }
  }
}

export const createTrysteroHub = createWebRtcActionHub
export const startTrysteroListener = startLegacyWebRtcListener
export const connectTrystero = connectLegacyWebRtc
