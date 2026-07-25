# p2p-netcat-core

[English](README.md) | **Русский**

Полная схема взаимодействия библиотеки с CLI и браузерным Worker описана в
[`docs/ARCHITECTURE.RU.md`](https://github.com/santaklouse/p2p-netcat/blob/main/docs/ARCHITECTURE.RU.md).

Общее browser-safe ядро `p2p-netcat`. Пакет не использует Node.js API и может
импортироваться одновременно консольным приложением, Web Worker и другими
JavaScript-клиентами.

Пакет отвечает за:

- логические порты и protocol ID;
- нормализацию PeerId и multiaddr;
- валидацию relay-адресов;
- построение Circuit Relay dial plan;
- определение browser-compatible адресов;
- единый порядок предпочтения транспортов;
- общую тему и интервал PubSub discovery;
- общий пул STUN-серверов WebRTC;
- browser-safe кадрирование PTY-данных/resize и инкрементальное декодирование;
- согласованный flow control Trystero с окном байтов, подтверждениями, keepalive,
  EOF и abort.

Создание libp2p-узла, DHT, Web Worker RPC и stdin/stdout остаются в платформенных
пакетах.

## Экспортируемый API

| Функция | Назначение |
|---|---|
| `validateService(value)` | Проверяет логический порт `1..65535` |
| `protocolForService(service)` | Строит `/p2p-netcat/1.0.0/{service}` |
| `encodePtyData(value)` | Кадрирует клавиатурные или терминальные байты интерактивного сеанса |
| `encodePtyResize(columns, rows)` | Кадрирует размеры терминала |
| `decodePtyResize(value)` | Декодирует и проверяет размеры терминала |
| `PtyFrameDecoder` | Инкрементально разбирает PTY-фреймы между transport chunks |
| `normalizePeerId(value)` | Проверяет и канонизирует PeerId |
| `normalizeMultiaddr(value)` | Проверяет и канонизирует multiaddr |
| `normalizeRelayAddress(value, options)` | Проверяет relay, WS/WSS и secure-context ограничения |
| `relayedTargetAddress(relay, peerId, options)` | Возвращает Circuit Relay multiaddr цели |
| `createRelayDialPlan(input)` | Возвращает неизменяемый план подключения |
| `browserDialableAddress(address, options)` | Проверяет пригодность адреса для браузера |
| `addressRank(address)` | Возвращает числовой приоритет транспорта |
| `preferDialAddresses(a, b)` | Comparator для сортировки multiaddr |
| `PUBSUB_DISCOVERY_TOPIC` | Отдельная GossipSub-тема discovery приложения |
| `PUBSUB_DISCOVERY_INTERVAL_MS` | Интервал повторной публикации объявления |
| `DEFAULT_STUN_URLS` | Неизменяемый общий список STUN URL |
| `defaultRtcConfiguration()` | Возвращает новую WebRTC-конфигурацию с общим STUN-пулом |
| `trysteroRoomId(peerId, service)` | Строит детерминированную WebRTC room |
| `trysteroAuthPayload(...)` | Строит подписываемый challenge с domain separation |
| `encodeTrysteroAuthResponse(...)` | Кодирует публичный ключ и подпись |
| `decodeTrysteroAuthResponse(...)` | Проверяет и декодирует ответ |
| `TrysteroStream` | Адаптирует action-канал к потоку с backpressure и EOF |

Приоритет сортировки: WebRTC Direct, QUIC v1, WebTransport, WSS, WS, TCP,
прочие адреса и Circuit Relay. Наличие позиции в общем рейтинге не означает,
что конкретная платформа реализует соответствующий транспорт.

`defaultRtcConfiguration()` каждый раз возвращает новый объект, поскольку
реализации WebRTC могут нормализовать или изменять конфигурацию. Сейчас пул
содержит пять Google STUN endpoint, а также CounterPath, Sipgate, VoIPBuster и
InternetCalls. STUN помогает определить NAT mapping, но не является TURN relay
и не гарантирует прямое соединение через symmetric или жёсткий NAT.

`TrysteroStream` объявляет поддержку flow control сообщением `flow:1`. Два
актуальных пира по умолчанию ограничивают неподтверждённые данные окном 256 КиБ
и отправляют `ack:<bytes>` лишь тогда, когда async consumer перешёл к следующему
блоку после обработки текущего. Согласование обратно совместимо: старый пир без
`flow:1` продолжает работать по прежним правилам транспорта. Лёгкие
`ping`/`pong` поддерживают неактивный data channel.

Если нужно только browser-safe ядро, установите отдельный пакет:

```bash
npm install p2p-netcat-core
```

Код, в котором уже установлен Node.js CLI, может использовать равнозначный
subpath export:

```js
import { createRelayDialPlan } from 'p2p-netcat/core'
```

Для browser-only проекта предпочтителен прямой `p2p-netcat-core`: он не
устанавливает Node-only транспорты CLI.

Пример использования общего плана подключения:

```js
import { createRelayDialPlan } from 'p2p-netcat-core'

const plan = createRelayDialPlan({
  peerId: '12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9',
  service: 31337,
  relay: '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW',
  requireWebSocket: true,
  secureContext: true
})

console.log(plan.destination)
console.log(plan.protocol)
```
