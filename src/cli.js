import { Command, InvalidArgumentError } from 'commander'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { createP2PNode } from './node.js'
import { defaultIdentityPath, loadOrCreateIdentity } from './identity.js'
import { DEFAULT_SERVICE, protocolForService, validateService } from 'p2p-netcat-core'
import { APP_VERSION, IPFS_BOOTSTRAP_PEERS } from './constants.js'
import { bridgeSession, execSession } from './session.js'
import { advertiseSelf, resolveTarget } from './discovery.js'
import { connectTrystero, startTrysteroListener } from './trystero.js'
import { startRelay } from './relay.js'
import { socksProxySession, startLocalForward, tcpForwardSession } from './forwarding.js'
import { interactiveClientSession, ptyServerSession } from './pty.js'
import { quietRequested, runUnderTor } from './tor.js'

let suppressDiagnostics = false

function integer (value, previous) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new InvalidArgumentError(`ожидалось неотрицательное целое число, получено: ${value}`)
  }
  return number
}

function positiveInteger (value) {
  const number = integer(value)
  if (number === 0) throw new InvalidArgumentError('значение должно быть больше нуля')
  return number
}

function collect (value, values) {
  return [...values, value]
}

function stderr (message) {
  if (suppressDiagnostics) return
  process.stderr.write(`${message}\n`)
}

function addressLines (node) {
  const peerId = node.peerId.toString()
  return node.getMultiaddrs().map(address => {
    const value = address.toString()
    return value.includes('/p2p/') ? value : `${value}/p2p/${peerId}`
  })
}

function printNodeInfo (node, { json = false, label = 'узел' } = {}) {
  const payload = {
    peerId: node.peerId.toString(),
    addresses: addressLines(node)
  }

  if (json) {
    stderr(JSON.stringify(payload))
    return
  }

  stderr(`[p2p-nc] ${label} PeerId: ${payload.peerId}`)
  for (const address of payload.addresses) stderr(`[p2p-nc] адрес: ${address}`)
}

function installShutdown (node, { close = [] } = {}) {
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await Promise.allSettled(close.map(handler => handler()))
    await node.stop().catch(() => {})
  }

  const onSignal = signal => {
    stop().finally(() => process.kill(process.pid, signal))
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

function commonNodeOptions (command) {
  return command
    .option('--transport-port <port>', 'локальный TCP/UDP-порт libp2p (0 = выбрать автоматически)', integer, 0)
    .option('-4, --ipv4', 'слушать только IPv4')
    .option('-6, --ipv6', 'слушать только IPv6')
    .option('-I, --identity <file>', 'файл постоянного приватного ключа')
    .option('--relay <multiaddr>', 'Circuit Relay v2; можно указать несколько раз', collect, [])
    .option('--bootstrap <multiaddr>', 'заменить стандартные IPFS bootstrap-узлы', collect, [])
    .option('--announce <multiaddr>', 'публичный адрес, объявляемый через DHT; можно повторять', collect, [])
    .option('--no-dht', 'не подключаться к публичной IPFS Amino DHT')
    .option('--no-mdns', 'отключить обнаружение соседей в локальной сети')
    .option('--no-pubsub', 'отключить подписанный GossipSub Peer Discovery')
    .option('--no-quic', 'отключить QUIC и использовать TCP/relay')
    .option('--no-webrtc', 'отключить прямой Trystero/WebRTC fallback')
    .option('--bind <host>', 'локальный адрес для -p forwarding', '127.0.0.1')
    .option('--json', 'выводить сведения об узле в JSON в stderr')
    .option('-v, --verbose', 'подробная диагностика в stderr')
}

function nodeOptionsFrom (options, { privateKey, dhtServer = false, relayServer = false } = {}) {
  if (options.ipv4 && options.ipv6) throw new Error('Опции -4 и -6 нельзя использовать одновременно')
  const enableDht = options.dht !== false

  return {
    privateKey,
    localPort: options.transportPort,
    websocketPort: options.websocketPort,
    ipVersion: options.ipv4 ? 4 : options.ipv6 ? 6 : undefined,
    announce: options.announce,
    relays: options.relay,
    bootstrapPeers: options.tor
      ? []
      : options.bootstrap.length > 0
      ? options.bootstrap
      : enableDht ? IPFS_BOOTSTRAP_PEERS : [],
    enableDht: options.tor ? false : enableDht,
    enableMdns: options.tor ? false : options.mdns !== false,
    enablePubsub: options.tor ? false : options.pubsub !== false,
    enableQuic: options.tor ? false : options.quic !== false,
    listen: options.tor ? false : true,
    dhtServer,
    relayServer
  }
}

async function runListener (target, serviceArgument, options) {
  if (serviceArgument != null) {
    throw new Error('В режиме -l укажите только логический порт: p2p-nc -l 8080')
  }

  const service = validateService(target ?? DEFAULT_SERVICE)
  const identityPath = resolve(options.identity ?? defaultIdentityPath())
  const privateKey = await loadOrCreateIdentity(identityPath)
  const node = await createP2PNode(nodeOptionsFrom(options, { privateKey, dhtServer: true }))
  const removeSignalHandlers = installShutdown(node)
  const advertiseController = new AbortController()
  const advertiseTask = options.dht === false
    ? Promise.resolve()
    : advertiseSelf(node, { signal: advertiseController.signal, verbose: options.verbose })
  const protocol = protocolForService(service)
  const persistentMode = options.keepOpen || options.interactive || options.socks || options.port != null
  let completed
  const firstSession = new Promise((resolve, reject) => { completed = { resolve, reject } })
  let handled = false

  const handleIncoming = async (stream, remotePeer) => {
    if (handled && !persistentMode) {
      stream.abort(new Error('Слушатель принимает только одно подключение'))
      return
    }
    handled = true
    stderr(`[p2p-nc] peer ${remotePeer} подключен к логическому порту ${service}`)

    try {
      if (options.interactive) {
        await ptyServerSession(stream, options)
      } else if (options.socks) {
        await socksProxySession(stream, { timeoutMs: options.timeout * 1000 })
      } else if (options.port != null) {
        await tcpForwardSession(stream, {
          host: options.destination ?? '127.0.0.1',
          port: options.port,
          timeoutMs: options.timeout * 1000
        })
      } else if (options.exec != null) {
        await execSession(stream, options.exec, options)
      } else {
        await bridgeSession(stream, {
          closeDelayMs: options.quitDelay * 1000,
          inactivityTimeoutMs: options.timeoutExplicit ? options.timeout * 1000 : 0
        })
      }
      if (!persistentMode) completed.resolve()
    } catch (error) {
      if (persistentMode) stderr(`[p2p-nc] сеанс ${remotePeer} завершён с ошибкой: ${error.message}`)
      else completed.reject(error)
    }
  }

  await node.handle(protocol, async (stream, connection) => {
    await handleIncoming(stream, connection.remotePeer)
  }, {
    maxInboundStreams: persistentMode ? 1024 : 1,
    runOnLimitedConnection: true
  })

  const trysteroListener = options.webrtc === false
    ? null
    : startTrysteroListener({
        privateKey,
        service,
        verbose: options.verbose,
        onStream: (stream, remotePeer) => void handleIncoming(stream, `webrtc:${remotePeer}`)
      })

  printNodeInfo(node, { json: options.json, label: `слушатель:${service}` })
  stderr(`[p2p-nc] постоянный ключ: ${identityPath}`)

  let previousAddresses = new Set(addressLines(node))
  node.addEventListener('self:peer:update', () => {
    for (const address of addressLines(node)) {
      if (!previousAddresses.has(address)) stderr(`[p2p-nc] новый адрес: ${address}`)
      previousAddresses.add(address)
    }
  })

  try {
    if (persistentMode) {
      await new Promise(() => {})
    } else {
      await firstSession
    }
  } finally {
    advertiseController.abort()
    await advertiseTask.catch(() => {})
    await trysteroListener?.close().catch(() => {})
    removeSignalHandlers()
    await node.stop()
  }
}

async function runClient (target, serviceArgument, options) {
  if (target == null) {
    throw new Error('Не указан PeerId. Пример: p2p-nc 12D3KooW... 8080')
  }

  const service = validateService(serviceArgument ?? DEFAULT_SERVICE)
  const privateKey = await loadOrCreateIdentity(options.identity == null ? null : resolve(options.identity))
  const node = await createP2PNode(nodeOptionsFrom(options, { privateKey }))
  const timeoutMs = options.timeout * 1000
  const libp2pController = new AbortController()
  let dialTargetPromise
  let trysteroAttempt
  let localForward
  let removeSignalHandlers = () => {}

  const openLibp2pStream = async () => {
    dialTargetPromise ??= resolveTarget(node, target, {
      relays: options.relay,
      timeoutMs,
      verbose: options.verbose,
      signal: libp2pController.signal
    })
    const dialTarget = await dialTargetPromise
    return node.dialProtocol(dialTarget, protocolForService(service), {
      signal: AbortSignal.any([libp2pController.signal, AbortSignal.timeout(timeoutMs)]),
      runOnLimitedConnection: true
    })
  }

  try {
    if (options.verbose) printNodeInfo(node, { json: options.json, label: 'клиент' })
    if (options.port != null) {
      localForward = await startLocalForward({
        host: options.bind,
        port: options.port,
        openStream: openLibp2pStream,
        onError: error => stderr(`[p2p-nc] TCP forwarding session: ${error.message}`)
      })
      removeSignalHandlers = installShutdown(node, { close: [() => localForward.close()] })
      const address = localForward.address
      stderr(`[p2p-nc] локальный TCP ${address.address}:${address.port} -> ${target}:${service}`)
      await once(localForward.server, 'close')
      return
    }

    removeSignalHandlers = installShutdown(node)
    if (options.verbose) {
      stderr('[p2p-nc] запускаю параллельное подключение: libp2p (DHT/PubSub) и WebRTC (Nostr/BitTorrent)')
    }
    const libp2pAttempt = openLibp2pStream()

    const useTrystero = options.webrtc !== false && !options.tor && !target.startsWith('/') && options.relay.length === 0
    if (useTrystero) trysteroAttempt = connectTrystero({ peerId: target, service, timeoutMs, verbose: options.verbose })
    let winner
    try {
      winner = await Promise.any([
        libp2pAttempt.then(stream => ({ transport: 'libp2p', stream })),
        ...(trysteroAttempt == null
          ? []
          : [trysteroAttempt.promise.then(stream => ({
              transport: `Trystero/WebRTC (${stream.signalingStrategy ?? 'signaling'})`,
              stream
            }))])
      ])
    } catch (error) {
      const reasons = error instanceof AggregateError ? error.errors.map(item => item.message).join('; ') : error.message
      throw new Error(`Ни один транспорт не установил соединение: ${reasons}`, { cause: error })
    }

    if (winner.transport === 'libp2p') await trysteroAttempt?.close().catch(() => {})
    else libp2pController.abort(new Error('Выбран более быстрый Trystero/WebRTC-канал'))
    const stream = winner.stream
    if (options.verbose || options.zero) stderr(`[p2p-nc] соединение с ${target}:${service} установлено`)
    if (options.verbose) stderr(`[p2p-nc] выбран транспорт: ${winner.transport}`)
    if (options.zero) {
      await stream.close()
      return
    }

    if (options.interactive) {
      await interactiveClientSession(stream)
    } else {
      await bridgeSession(stream, {
        closeDelayMs: options.quitDelay * 1000,
        inactivityTimeoutMs: options.timeoutExplicit ? timeoutMs : 0
      })
    }
  } finally {
    libp2pController.abort(new Error('Клиент завершён'))
    await trysteroAttempt?.close().catch(() => {})
    await localForward?.close().catch(() => {})
    removeSignalHandlers()
    await node.stop()
  }
}

async function runRelay (options) {
  if (options.ipv4 && options.ipv6) throw new Error('Опции -4 и -6 нельзя использовать одновременно')
  const identityPath = resolve(options.identity ?? `${defaultIdentityPath()}.relay`)
  const relay = await startRelay({
    identityPath,
    localPort: options.localPort,
    websocketPort: options.websocketPort,
    ipVersion: options.ipv4 ? 4 : options.ipv6 ? 6 : undefined,
    announce: options.announce,
    enableMdns: options.mdns !== false,
    enablePubsub: options.pubsub !== false,
    enableQuic: options.quic !== false
  })
  const node = relay.node
  installShutdown(node)
  printNodeInfo(node, { json: options.json, label: 'relay' })
  stderr(`[p2p-nc] relay готов; постоянный ключ: ${relay.identityPath}`)
  await new Promise(() => {})
}

async function printIdentity (options) {
  const identityPath = resolve(options.identity ?? defaultIdentityPath())
  const privateKey = await loadOrCreateIdentity(identityPath)
  const node = await createP2PNode({
    privateKey,
    listen: false,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    enablePubsub: false
  })
  process.stdout.write(`${node.peerId}\n`)
  await node.stop()
}

export function createProgram () {
  const program = new Command()
    .name('p2p-nc')
    .enablePositionalOptions()
    .description('Netcat-подобный потоковый P2P-клиент на libp2p/IPFS, адресуемый по PeerId')
    .version(APP_VERSION)
    .usage('[опции] [PeerId|multiaddr] [логический-порт]')
    .argument('[target]', 'PeerId/multiaddr сервера; с -l это логический порт')
    .argument('[service]', 'логический порт сервиса', value => validateService(value))
    .option('-l, --listen', 'режим сервера')
    .option('-k, --keep-open', 'после сеанса продолжать принимать подключения')
    .option('-w, --timeout <seconds>', 'таймаут поиска/подключения; при явном -w также простоя', positiveInteger, 60)
    .option('--quit-delay <seconds>', 'задержка закрытия после EOF stdin', integer, 0)
    .option('-d, --destination <host>', 'адрес назначения TCP forwarding на стороне сервера')
    .option('-p, --port <port>', 'порт назначения с -l или локальный listen-порт клиента', positiveInteger)
    .option('-q, --quiet', 'не выводить предупреждения, ошибки и статус')
    .option('-S, --socks', 'SOCKS4/4a/5 server на удалённой стороне; требует -l')
    .option('-T, --tor', 'подключаться к указанному Circuit Relay через Tor/torsocks')
    .option('-i, --interactive', 'интерактивный PTY login shell')
    .option('-z, --zero', 'только проверить возможность подключения')
    .option('-e, --exec <command>', 'на сервере подключить поток к команде (опасно без доверия к клиенту)')
    .option('-u, --udp', 'UDP-режим (не поддерживается: libp2p-поток надёжен)')

  commonNodeOptions(program)

  program.action(async (target, service, options) => {
    suppressDiagnostics = options.quiet === true
    if (options.quiet) options.verbose = false
    options.timeoutExplicit = program.getOptionValueSource('timeout') === 'cli'
    if (options.udp) throw new Error('Опция -u пока не поддерживается: текущий протокол передаёт надёжный двунаправленный поток')
    if (options.exec != null && !options.listen) throw new Error('Опция -e доступна только вместе с -l')
    if (options.destination != null && !options.listen) throw new Error('Опция -d доступна только вместе с -l')
    if (options.destination != null && options.port == null) throw new Error('Опция -d требует -p <порт-назначения>')
    if (options.socks && !options.listen) throw new Error('Опция -S доступна только вместе с -l')
    if (options.socks && (options.destination != null || options.port != null)) throw new Error('Опция -S несовместима с -d/-p на сервере')
    if (options.interactive && options.exec != null) throw new Error('Опции -i и -e нельзя использовать одновременно')
    if (options.interactive && options.socks) throw new Error('Опции -i и -S нельзя использовать одновременно')
    if (!options.listen && options.interactive && options.port != null) throw new Error('Клиентские опции -i и -p нельзя использовать одновременно')
    if (!options.listen && options.zero && options.port != null) throw new Error('Клиентские опции -z и -p нельзя использовать одновременно')
    if (options.tor && options.listen) throw new Error('Опция -T поддерживается только в клиентском режиме')
    if (options.tor && options.relay.length === 0) throw new Error('Опция -T требует явный --relay с TCP/WS/WSS multiaddr')
    if (options.tor && options.relay.some(address => address.includes('/udp/'))) throw new Error('Tor не переносит QUIC/UDP: используйте TCP/WS/WSS relay multiaddr')
    if (options.listen) return runListener(target, service, options)
    return runClient(target, service, options)
  })

  program.command('relay')
    .description('запустить собственный публичный Circuit Relay v2')
    .option('-p, --local-port <port>', 'публичный TCP/UDP-порт relay', integer, 9090)
    .option('--websocket-port <port>', 'WebSocket-порт для браузерных клиентов', positiveInteger, 9091)
    .option('-4, --ipv4', 'слушать только IPv4')
    .option('-6, --ipv6', 'слушать только IPv6')
    .option('-I, --identity <file>', 'файл постоянного приватного ключа')
    .option('--announce <multiaddr>', 'публичный адрес relay; можно повторять', collect, [])
    .option('--no-mdns', 'отключить обнаружение в LAN')
    .option('--no-pubsub', 'отключить подписанный GossipSub Peer Discovery')
    .option('--no-quic', 'отключить QUIC и использовать только TCP')
    .option('--json', 'вывести сведения в JSON')
    .option('-v, --verbose', 'подробная диагностика')
    .action(runRelay)

  program.command('id')
    .description('показать постоянный PeerId слушателя и завершиться')
    .option('-I, --identity <file>', 'файл постоянного приватного ключа')
    .action(printIdentity)

  return program
}

export async function main (argv = process.argv) {
  try {
    if (await runUnderTor(argv)) return
    await createProgram().parseAsync(argv)
  } catch (error) {
    if (!quietRequested(argv)) {
      process.stderr.write(`[p2p-nc] ошибка: ${error.message}\n`)
      if (process.env.DEBUG?.includes('p2p-netcat')) process.stderr.write(`${error.stack}\n`)
    }
    process.exitCode = 1
  }
}
