# Миграция WebRTC без Trystero

[English](WEBRTC_MIGRATION.md) | **Русский**

Теперь `p2p-netcat-core` владеет WebRTC-протоколом, контроллером соединения и
двумя signaling-адаптерами для публичной инфраструктуры. Trystero больше не
является основным путём. Он временно остаётся отложенным fallback совместимости
до завершения длительных тестов native-пути между браузерами, Linux и macOS.

Отказ от Trystero не отменяет необходимость rendezvous-инфраструктуры. Два
компьютера за NAT не могут обменяться SDP, зная только PeerId. Новый код
прозрачно использует публичные Nostr relays и WebTorrent WebSocket trackers, но
не требует серверов p2p-netcat или серверных скриптов.

## Текущее состояние

| Этап | Состояние |
|---|---|
| Независимый от signaling byte stream, flow control, EOF, keepalive и reconnect | Реализован в core |
| Собственный контроллер `RTCPeerConnection` и ordered reliable `RTCDataChannel` | Реализован в core |
| Подписанный Nostr signaling adapter | Реализован в core |
| WebTorrent WebSocket tracker signaling adapter | Реализован в core |
| Интеграция с CLI и статической PWA | Native запускается первым, Trystero — через четыре секунды |
| Удаление Trystero npm dependencies | После длительных тестов в реальных сетях |

Браузерное приложение по-прежнему состоит только из статических файлов для
GitHub Pages. В Node.js `RTCPeerConnection` предоставляет `@roamhq/wrtc`, а
браузер использует встроенную реализацию.

## Алгоритм native-соединения

1. Listener строит детерминированную room из постоянного PeerId и логического
   порта.
2. Обе стороны хешируют versioned room в необратимую signaling topic.
3. Каждый процесс создаёт одну случайную 20-символьную signaling identity,
   общую для Nostr и tracker adapters.
4. Инициатор создаёт по одному non-trickle SDP offer для каждого адаптера.
   Полный SDP выбран потому, что WebTorrent tracker переносит offer/answer, но
   не произвольный поток ICE candidates.
5. Первый ответ, открывший `p2p-netcat-v2`, запускает 32-байтовый challenge.
6. Сервер подписывает domain-separated payload постоянным libp2p Ed25519-ключом.
   Клиент восстанавливает PeerId и проверяет точное совпадение с запрошенным.
7. Только после успешной проверки клиент отправляет `AUTH_READY`. Поэтому
   непроверенный кандидат не может запустить PTY или прикладной поток listener.
8. Побеждает первый аутентифицированный адаптер. Проигравшие Nostr/tracker
   peer connections закрываются до передачи прикладных данных.
9. При временной потере data channel тот же `WebRtcStream` и PTY сохраняются до
   120 секунд. Reconnect привязывает новый data channel к прежнему потоку.

Offer glare здесь отсутствует по конструкции: клиенты создают offer, listener
только отвечает. Каждая повторная попытка получает уникальный session ID, а
дубликаты из tracker/Nostr фильтруются до endpoint controller.

## Native wire protocol

Каждое сообщение `RTCDataChannel` бинарное:

```text
+---------+------------+--------------------------+
| version | frame type | payload                  |
+---------+------------+--------------------------+
| 0x02    | 0x00       | байты приложения         |
| 0x02    | 0x01       | UTF-8 stream control     |
| 0x02    | 0x02       | authentication challenge |
| 0x02    | 0x03       | public key + signature   |
| 0x02    | 0x04       | authentication accepted  |
+---------+------------+--------------------------+
```

Stream control поддерживает `flow:1`, `ack:<bytes>`, `resume`, `ping`/`pong`,
`eof` и `abort`. `RTCDataChannel.bufferedAmount` создаёт первую границу
backpressure, а `WebRtcStream` добавляет сквозное окно 256 КиБ, чтобы быстрый
вывод PTY не увеличивал память браузера без ограничения.

## Signaling adapters

### Nostr

Адаптер открывает WebSocket к нескольким публичным relay, создаёт временный
Schnorr-ключ и публикует подписанные events kind `25050`. Event содержит
versioned room tag, принимается не старше 120 секунд и проверяется по
каноническому event ID и подписи до обработки SDP. PeerId сервера всё равно
проверяется внутри WebRTC: временный Nostr-ключ подтверждает только целостность
signaling event.

### WebTorrent trackers

Адаптер выводит детерминированный 20-байтовый tracker `info_hash`, хранит
ограниченный пул offer, адресует answer через `offer_id` и `to_peer_id`,
периодически повторяет announce, удаляет дубликаты ответов и переподключается с
exponential backoff. Пользовательские данные через tracker не проходят.

## Публичный API core

```js
import {
  NativeWebRtcPeer,
  WebRtcStream,
  connectNativeWebRtc,
  createNostrSignalingSession,
  createSignalingPeerId,
  createTorrentSignalingSession,
  defaultRtcConfiguration,
  startNativeWebRtcListener,
  webRtcRoomId
} from 'p2p-netcat/core'
```

Те же exports доступны в отдельном пакете `p2p-netcat-core`. Signaling-функции
принимают внедряемые конструкторы `WebSocket` и `RTCPeerConnection`, поэтому
они browser-safe и тестируются без Node.js globals.

## Период совместимости

CLI listener сейчас открывает native adapters и legacy Trystero rooms. Клиент
сразу запускает native signaling, а Trystero — только если native-канал не
победил за четыре секунды. Общая client-session identity позволяет новому
listener отклонить дублирующие native/legacy-каналы одного нового клиента.

Trystero dependencies будут удалены после длительного прохождения матрицы:

- browser → Linux CLI и macOS CLI → Linux CLI между разными странами;
- Chrome, Firefox и Safari;
- обычный, symmetric и restrictive NAT;
- фоновые вкладки и сон/пробуждение;
- большой непрерывный вывод PTY в течение нескольких часов;
- повторные потери и восстановления сети в пределах 120 секунд;
- старый опубликованный client → новый listener и новый client → старый listener.

STUN обнаруживает NAT mapping, но не является relay. При symmetric NAT или
заблокированном UDP всё ещё может потребоваться TURN либо настроенный libp2p
Circuit Relay. Публичные relays и trackers принадлежат третьим сторонам: они
видят signaling topics, время и SDP/ICE candidates, но не прикладные данные
зашифрованного peer-to-peer channel. Они не гарантируют 100% доступность.
