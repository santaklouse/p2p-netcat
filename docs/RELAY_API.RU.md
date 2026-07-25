# Программный API Circuit Relay

[English](RELAY_API.md) | **Русский**

Node.js-пакет предоставляет отдельную точку входа relay:

```js
import { startRelay } from 'p2p-netcat/relay'
```

Эта точка входа работает только в Node.js. Она не входит в браузерно-безопасный
пакет `p2p-netcat-core`.

## Установка

После публикации текущей версии пакета:

```bash
npm install p2p-netcat
```

Внутри этого репозитория npm workspaces разрешают ту же точку входа без
дополнительной установки пакета.

## Полный пример

```js
import { startRelay } from 'p2p-netcat/relay'

const announce = (process.env.P2P_RELAY_ANNOUNCE ?? '')
  .split(',')
  .map(address => address.trim())
  .filter(Boolean)

const relay = await startRelay({
  identityPath: './data/p2p-netcat-relay.key',
  localPort: 9090,
  websocketPort: 9091,
  announce,
  enableMdns: false,
  enablePubsub: true,
  enableQuic: true
})

console.log(`Relay PeerId: ${relay.peerId}`)
for (const address of relay.addresses) console.log(`Relay address: ${address}`)

let stopping = false
const shutdown = async signal => {
  if (stopping) return
  stopping = true
  console.log(`Остановка relay после ${signal}...`)
  await relay.stop()
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
```

`createLibp2p()` запускает узел до завершения `startRelay()`, поэтому
возвращённый объект уже представляет слушающий relay. Жизненным циклом управляет
вызывающая программа: библиотека не устанавливает обработчики сигналов процесса
и не вызывает `process.exit()`.

## Параметры

| Параметр | По умолчанию | Назначение |
|---|---:|---|
| `identityPath` | путь ключа relay p2p-netcat | Постоянный Ed25519-ключ. Передайте `null` для временного PeerId. |
| `privateKey` | — | Готовый приватный ключ libp2p. Имеет приоритет над `identityPath`. |
| `localPort` | `9090` | TCP-порт и, если включён, UDP-порт QUIC. В тестах можно передать `0` для выбора ОС. |
| `websocketPort` | `9091` | Порт обычного WebSocket. Передайте `null`, чтобы отключить его. |
| `ipVersion` | обе версии | Значение `4` или `6` ограничивает слушатели выбранной версией IP. |
| `announce` | `[]` | Публичные multiaddr вместо использования только наблюдаемых адресов интерфейсов. |
| `enableMdns` | `true` | Включает обнаружение в LAN. |
| `enablePubsub` | `true` | Включает подписанные GossipSub-объявления в теме p2p-netcat. |
| `enableQuic` | `true` | Включает QUIC v1 вместе с TCP. |

При включённом PubSub relay одновременно становится участником совместимой
discovery mesh. Он может передавать подписанные объявления между подключёнными
узлами p2p-netcat, но не превращается в центральный каталог: узлам всё равно
нужен начальный маршрут хотя бы к одному участнику той же GossipSub mesh. Для
relay без этой роли передайте `enablePubsub: false`.

Возвращённый объект содержит:

- `node`: запущенный libp2p-узел для расширенной интеграции;
- `peerId`: строковый PeerId relay;
- `addresses`: актуальные listen/announce multiaddr с
  `/p2p/<relayPeerId>`;
- `identityPath`: абсолютный путь постоянного ключа либо `null` для переданного
  извне или временного ключа;
- `stop()`: идемпотентную асинхронную остановку.

## Публичное размещение и WSS

`P2P_RELAY_ANNOUNCE` в примере принимает реальные публичные multiaddr через
запятую. Сам relay слушает `/ws`, а HTTPS-браузер может подключаться только к
публичному `/wss`. Завершите TLS на reverse proxy или CDN, направьте трафик на
WebSocket-порт relay и добавьте полученный WSS multiaddr в ручное поле relay
веб-клиента либо в `network-config.json`.

Circuit Relay переносит уже зашифрованное libp2p-соединение. Он видит PeerId,
время и объём трафика, но не защищённое Noise содержимое приложения.
