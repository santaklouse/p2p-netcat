# Миграция WebRTC без Trystero

[English](WEBRTC_MIGRATION.md) | **Русский**

Цель миграции — удалить runtime-зависимости `@trystero-p2p/torrent` и
`@trystero-p2p/nostr`, сохранив прямое WebRTC-соединение между CLI и браузером,
автоматический поиск через публичную инфраструктуру и восстановление
долгоживущих PTY-сессий.

Удаление зависимости не означает отказ от внешних signaling-узлов. Два
компьютера за NAT не могут обменяться SDP и ICE-кандидатами, зная только PeerId,
без какого-либо rendezvous-канала. p2p-netcat продолжит прозрачно использовать
публичные WebTorrent trackers и Nostr relays, но клиентский протокол и WebRTC
state machine будут принадлежать проекту.

## Что уже перенесено в core

`p2p-netcat-core` уже отвечает за:

- стабильный room ID из PeerId и логического порта;
- подписанный PeerId challenge/response;
- общий список STUN-серверов;
- бинарный поток `WebRtcStream`;
- окно backpressure 256 КиБ и `ack:<bytes>`;
- `ping`/`pong`, EOF и abort;
- 120-секундное окно восстановления;
- namespaces `pnc-data-v1` и `pnc-ctl-v1`;
- `createWebRtcActionHub()`, который связывает action room с потоками.

Новые имена API не зависят от реализации signaling:

```js
import {
  WEBRTC_APP_ID,
  WEBRTC_RECONNECT_GRACE_MS,
  WebRtcStream,
  createWebRtcActionHub,
  decodeWebRtcAuthResponse,
  encodeWebRtcAuthResponse,
  webRtcAuthPayload,
  webRtcRoomId
} from 'p2p-netcat/core'
```

Старые имена `TrysteroStream`, `trysteroRoomId()` и остальные Trystero-prefixed
экспорты пока сохранены как aliases. Это позволяет обновить CLI и web независимо
и не ломает существующих пользователей библиотеки.

## Что пока делает Trystero

После первого этапа от Trystero остаются только четыре обязанности:

1. подключение WebSocket к публичным WebTorrent/Nostr signaling-узлам;
2. публикация и получение SDP offer/answer и ICE candidates;
3. управление `RTCPeerConnection` и `RTCDataChannel`;
4. совместимый wire format для существующих опубликованных CLI/web версий.

Передача пользовательских данных, flow control, EOF, keepalive, восстановление
сессии и PeerId-аутентификация уже не должны зависеть от этих обязанностей.

## Следующие этапы

### 1. Собственный интерфейс signaling

Core получит общий контракт:

```ts
export interface SignalingAdapter {
  readonly name: string
  connect(roomId: string, signal: AbortSignal): Promise<SignalingSession>
}

export interface SignalingSession {
  publish(message: WebRtcSignal): Promise<void>
  messages(): AsyncIterable<WebRtcSignal>
  close(): Promise<void>
}
```

Конкретный адаптер не имеет доступа к PTY или пользовательскому потоку. Он
только передаёт короткоживущие signaling-сообщения.

### 2. Собственный WebRTC session controller

Controller создаёт `RTCPeerConnection`, обрабатывает glare по алгоритму perfect
negotiation, упорядочивает trickle ICE candidates, открывает один ordered
reliable `RTCDataChannel` и передаёт его в `WebRtcStream`.

Node.js продолжит предоставлять WebRTC runtime через `@roamhq/wrtc`, а браузер
будет использовать нативный `RTCPeerConnection`.

### 3. WebTorrent tracker adapter

Адаптер реализует WebSocket tracker announce:

- SHA-1 info hash из versioned room namespace;
- пул offer и уникальные `offer_id`;
- адресованные answer;
- повторный announce с ограниченным интервалом;
- дедупликацию сообщений нескольких trackers;
- reconnect с exponential backoff.

Это обязательный путь для статической PWA на GitHub Pages.

### 4. Nostr adapter

Nostr остаётся независимым параллельным rendezvous:

- ephemeral Schnorr identity;
- подписанные NIP-01 events;
- versioned room tag;
- короткий срок жизни signaling events;
- дедупликация по event ID;
- одновременная работа с несколькими relays.

### 5. Dual stack и удаление зависимости

Во время перехода новая реализация и текущий Trystero adapter будут запускаться
параллельно. Первый аутентифицированный канал побеждает, остальные закрываются.
После soak-тестов dependency удаляется из `package.json` и web bundle.

Перед удалением проверяются:

- browser ↔ Linux CLI и macOS CLI ↔ Linux CLI;
- разные страны и разные NAT;
- Chrome, Firefox и Safari;
- фоновые вкладки и сон/пробуждение;
- непрерывный большой вывод PTY;
- временная потеря сети до 120 секунд;
- закрытие EOF/abort без зависших процессов;
- отсутствие дублирующих сессий при одновременном Nostr/tracker discovery.

## Почему не удалять Trystero одним коммитом

WebRTC signaling чувствителен к гонкам ICE, повторным offer, закрытию
WebSocket и особенностям браузеров. Мгновенная замена рабочей реализации без
dual-stack периода противоречит главному требованию p2p-netcat — стабильности
соединения. Поэтапная миграция позволяет сравнивать новый транспорт с текущим
на реальных сетях и откатывать только signaling adapter, не теряя PTY-сессию.
