# p2p-netcat

[English](README.md) | **Русский**

`p2p-nc` — консольная JavaScript-утилита в духе `netcat`, где вместо IP-адреса
сервера используется криптографический libp2p `PeerId`. Транспорт совместим с
сетевым слоем IPFS: QUIC v1, TCP, Noise, Yamux, IPFS Amino DHT, mDNS и Circuit
Relay v2.

## Документация

- [Подробная архитектура и алгоритм работы](docs/ARCHITECTURE.RU.md) —
  идентичность, discovery, выбор маршрута, CLI, браузер, relay, шифрование,
  backpressure и обработка ошибок;
- [Руководство по установке](docs/INSTALLATION.RU.md) — npm one-liner, первое
  подключение, обновление, удаление, identity и диагностика;
- [Миграция WebRTC без Trystero](docs/WEBRTC_MIGRATION.RU.md) — текущая граница
  зависимости, собственный signaling и безопасные этапы удаления;
- [Браузерный PWA-клиент](web/README.RU.md) — сборка, GitHub Pages,
  `network-config.json` и настройка WSS relay;
- [API общей JavaScript-библиотеки](packages/core/README.RU.md) — browser-safe
  пакет `p2p-netcat-core`, также доступный пользователям CLI как
  `p2p-netcat/core`;
- [Программный API Circuit Relay](docs/RELAY_API.RU.md) — запуск и остановка
  relay из другой Node.js-программы через `p2p-netcat/relay`.
- [Режимы, совместимые с gs-netcat](docs/GS_NETCAT_COMPAT.RU.md) — `-d`, `-p`,
  `-q`, `-S`, `-T` и `-i`: forwarding, SOCKS, PTY и маршрутизация через Tor.
- [Руководство по публикации](docs/PUBLISHING.RU.md) — порядок релиза,
  npm-проверки и чистая установка CLI, core и собранной web PWA.

## Что уже работает

- двунаправленная бинарно-прозрачная передача stdin/stdout;
- QUIC v1 как приоритетный прямой транспорт с автоматическим fallback на TCP;
- стабильный PeerId сервера из локального Ed25519-ключа;
- логические порты: один PeerId может предоставлять разные сервисы;
- поиск только по PeerId через mDNS, подписанные GossipSub-объявления и IPFS
  Amino DHT;
- собственный прямой WebRTC-путь, который и в Node.js, и в браузере параллельно
  использует подписанные события публичных Nostr relay и WebTorrent trackers;
- отложенный Trystero fallback для совместимости с уже опубликованными peers;
- общий пул из девяти STUN endpoint для WebRTC NAT traversal в CLI и браузере;
- ограниченный сквозной flow control от `node-pty` через транспорт и Web Worker
  до xterm;
- автоматическое восстановление временно потерянного WebRTC peer в течение 120
  секунд без завершения существующего PTY;
- соединение через Circuit Relay v2 для узлов за NAT;
- собственный relay-режим;
- TCP forwarding, SOCKS4/4a/5, quiet, Tor и настоящий PTY в стиле gs-netcat;
- `-l`, `-k`, `-w`, `-d`, `-p`, `-q`, `-S`, `-T`, `-i`, `-z`, `-e`, `-4`,
  `-6` и подробный режим;
- аутентифицированное шифрование через QUIC TLS 1.3 или Noise, включая
  соединения через relay.

Режим UDP-датаграмм в стиле netcat (`-u`) пока намеренно отклоняется. Сам QUIC
использует UDP на транспортном уровне, но предоставляет надёжный упорядоченный
поток.

## Установка

Требуется Node.js 22 или новее. QUIC-транспорт использует нативный N-API-модуль
с готовыми бинарными сборками для основных платформ macOS, Linux и Windows.
Интерактивный `-i` использует нативный `node-pty`; при установке из npm на Linux
могут потребоваться Python, `make` и C/C++ compiler для `node-gyp`.

Текущий набор зависимостей js-libp2p не поддерживает Node.js 18. На Ubuntu со
старой версией Node сначала выполните:

```bash
nvm install 22
nvm use 22
node --version
```

CLI проверяет версию до импорта libp2p и показывает понятное требование вместо
вторичных ошибок `CustomEvent`, `Promise.withResolvers` или очистки PubSub.

Установка опубликованного CLI из npm:

```bash
npm install --global p2p-netcat
```

Для разработки из исходного кода:

```bash
npm install
npm link
```

После `npm link` доступны обе команды: `p2p-nc` и короткая `pnc`.

QUIC включён по умолчанию. Используйте `--no-quic` только для диагностики или
если нативный QUIC-модуль недоступен на системе. Теперь `-p`, как в gs-netcat,
отвечает за TCP forwarding. Внутренний TCP/UDP listen-порт libp2p задаётся через
`--transport-port`; при значении `0` операционная система выбирает порты
независимо. `-i` теперь включает интерактивный PTY, поэтому короткая опция файла
идентичности перенесена на `-I`, а длинная `--identity` не изменилась.

## Быстрый запуск

На первом компьютере:

```bash
p2p-nc -l 8080
```

Команда напечатает в `stderr` постоянный PeerId, например:

```text
[p2p-nc] слушатель:8080 PeerId: 12D3KooWLs9pvVfwbo6yHsYB66kRLq2RJwfH3bBQZhp94kerbFd9
```

На втором компьютере нужно скопировать напечатанный PeerId и выполнить:

```bash
p2p-nc 12D3KooWLs9pvVfwbo6yHsYB66kRLq2RJwfH3bBQZhp94kerbFd9 8080
```

После соединения всё введённое в одном терминале передаётся в другой. PeerId в
примере иллюстративный: команда подключения должна содержать значение,
напечатанное именно вашим слушателем.

Показать PeerId, не запуская слушатель:

```bash
p2p-nc id
```

Серверный ключ создаётся в `~/.config/p2p-netcat/identity.key` с правами `0600`.
Удаление ключа создаст новый PeerId. Клиентская идентичность временная, если явно
не передан `--identity`.

## Проверяемый локальный пример без ручного копирования

Эти команды полностью запускаются на одном компьютере:

```bash
DEMO_KEY=/tmp/p2p-netcat-demo.key
DEMO_ID="$(p2p-nc id --identity "$DEMO_KEY")"
p2p-nc -l 8080 --identity "$DEMO_KEY" > /tmp/p2p-netcat-received.txt &
DEMO_PID=$!
sleep 2
printf 'hello over PeerId\n' | p2p-nc "$DEMO_ID" 8080
wait "$DEMO_PID"
cat /tmp/p2p-netcat-received.txt
```

## Узлы за NAT: собственный relay

Публичная IPFS DHT используется для поиска, но публичные IPFS-узлы не обещают
неограниченную ретрансляцию произвольных потоков. Для предсказуемой работы двух
узлов за NAT лучше один раз запустить relay на VPS с открытым портом 9090 для
TCP и UDP:

```bash
p2p-nc relay -4 -p 9090 \
  --announce /ip4/203.0.113.10/udp/9090/quic-v1 \
  --announce /ip4/203.0.113.10/tcp/9090
```

В реальной команде `--announce` должен содержать публичный адрес VPS. Relay
печатает полный multiaddr. Пусть он равен:

```text
/ip4/203.0.113.10/udp/9090/quic-v1/p2p/12D3KooWK4bicbvfPNGzfuMBf6xE43ecgB26NHDZRTfLM7CNh9yw
/ip4/203.0.113.10/tcp/9090/p2p/12D3KooWK4bicbvfPNGzfuMBf6xE43ecgB26NHDZRTfLM7CNh9yw
```

Сервер за NAT:

```bash
p2p-nc -l 8080 --relay /ip4/203.0.113.10/udp/9090/quic-v1/p2p/12D3KooWK4bicbvfPNGzfuMBf6xE43ecgB26NHDZRTfLM7CNh9yw
```

Клиент за NAT использует тот же relay, но адресует сервер только по его PeerId:

```bash
p2p-nc --relay /ip4/203.0.113.10/udp/9090/quic-v1/p2p/12D3KooWK4bicbvfPNGzfuMBf6xE43ecgB26NHDZRTfLM7CNh9yw 12D3KooWJ7satLo5LXjhSZBMVTWRG1AZ77sQYtX81qHHf2VtscdL 8080
```

Трафик между клиентом и сервером остаётся сквозным образом зашифрованным; relay
видит PeerId участников и объём/время трафика, но не содержимое.

Тот же relay можно встроить в другую Node.js-программу без запуска CLI как
дочернего процесса:

```js
import { startRelay } from 'p2p-netcat/relay'

const relay = await startRelay({
  identityPath: './data/p2p-netcat-relay.key',
  localPort: 9090,
  websocketPort: 9091,
  enableMdns: false
})

console.log(relay.peerId, relay.addresses)
await relay.stop()
```

Все параметры, постоянная идентичность, обработка сигналов, публичные announce
адреса и WSS описаны в [руководстве по программному relay](docs/RELAY_API.RU.md).

## Браузерный PWA-клиент

В каталоге `web` находится полностью статический React-клиент без SSR, API,
базы данных и серверных скриптов. Сетевой стек libp2p работает в Web Worker, а
Service Worker кеширует оболочку интерфейса, обеспечивает офлайн-запуск PWA и
фоновое обновление. На странице есть терминальный виджет, отправка текста и
файлов, EOF и сохранение полученного бинарного потока.

Собрать готовые статические файлы:

```bash
cd web
npm install
npm run build
```

Результат находится в `web/dist` и может быть размещён на любом HTTPS-хостинге
статических файлов. Backend приложению не нужен. Открытие через `file://` не
поддерживается, потому что браузеры разрешают Service Worker и установку PWA
только в secure context — на HTTPS либо `localhost`.

Для GitHub Pages добавлен готовый workflow `.github/workflows/pages.yml`. В
настройках репозитория достаточно выбрать **Settings → Pages → Source → GitHub
Actions**; workflow сам учтёт подпуть репозитория при сборке Vite. По умолчанию
публикуется английская страница со ссылкой на полный русский интерфейс по адресу
`?lang=ru`.

По умолчанию relay-адрес в браузере не требуется. Клиент параллельно запускает
native WebRTC signaling через подписанные Nostr events и публичные WebTorrent
trackers, а также libp2p-поиск через подписанные GossipSub-объявления, HTTP
Delegated Routing и IPFS Amino DHT. Legacy Trystero запускается только если
native WebRTC не подключился за четыре секунды. Побеждает первый
аутентифицированный канал. Найденные libp2p multiaddr также проверяются
параллельно.

GossipSub discovery по умолчанию включён в CLI-узлах, relay и браузерном Worker.
В CLI и relay его можно выключить опцией `--no-pubsub`. Это дополнительный путь
поиска, а не глобальная гарантия rendezvous: обоим пирам нужна связность с
совместимой GossipSub mesh. Native WebRTC и compatibility fallback используют
общий STUN-пул для улучшения прямого NAT traversal, но один STUN не заменяет
TURN или Circuit Relay, если обе стороны находятся за жёстким NAT.

Если у сервера опубликованы только TCP/QUIC-адреса или автоматический поиск не
нашёл маршрут, можно раскрыть дополнительные настройки и явно указать
WebSocket relay:

```bash
p2p-nc relay -4 -p 9090 --websocket-port 9091
```

Локально веб-клиент может использовать напечатанный адрес с
`/tcp/9091/ws/p2p/`. Если страница размещена по HTTPS, relay должен быть
опубликован через WSS, например с TLS reverse proxy на 443-м порту. Полная
инструкция находится в
[`web/README.RU.md`](web/README.RU.md).

## Общая JavaScript-библиотека

Логика, которая должна совпадать в CLI и браузере, вынесена в npm-пакет
[`p2p-netcat-core`](packages/core). Он не использует Node.js API и содержит
единые правила для логических портов и protocol ID, проверки PeerId/multiaddr,
валидации WS/WSS relay, построения Circuit Relay-маршрута и выбора приоритетных
транспортов.

Приложение, в котором уже установлен CLI-пакет, может использовать его subpath:

```js
import { createRelayDialPlan, protocolForService } from 'p2p-netcat/core'
```

Для browser-only проекта лучше оставить отдельный компактный
`p2p-netcat-core`, чтобы не устанавливать Node-only транспорты CLI. Сам CLI
импортирует то же ядро, а браузер использует его внутри Web Worker.
Платформенные части намеренно разделены: работа с stdin/stdout, локальным ключом,
QUIC и DHT остаётся в CLI; DOM, Worker RPC и PWA lifecycle — в каталоге `web`.
Благодаря этому discovery и fallback можно развивать через общий интерфейс без
дублирования правил подключения.

```js
import { createRelayDialPlan, protocolForService } from 'p2p-netcat-core'

const protocol = protocolForService(31337)
const plan = createRelayDialPlan({
  peerId: '12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9',
  service: 31337,
  relay: '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW',
  requireWebSocket: true,
  secureContext: true
})
```

## Режимы в стиле gs-netcat

Сервер предоставляет доступ к `192.168.6.7:22`, а клиент слушает локальный порт
`2222`. Каждое локальное TCP-соединение получает отдельный P2P-поток:

```bash
# На стороне сервера
p2p-nc -l -d 192.168.6.7 -p 22 31337

# На стороне клиента
p2p-nc -p 2222 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
ssh -p 2222 root@127.0.0.1
```

SOCKS4/4a/5 работает на удалённом узле и публикуется локально на порту `1080`:

```bash
# На стороне сервера
p2p-nc -l -S 31337

# На стороне клиента
p2p-nc -p 1080 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
curl --proxy socks5h://127.0.0.1:1080 https://example.com/
```

Настоящий PTY login shell передаёт изменение размера терминала и управляющие
байты. Для отключения клиента нажмите `Ctrl-e q`:

```bash
p2p-nc -l -i 31337
p2p-nc -i 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

В браузерном клиенте перед подключением к такому listener включите
**«Интерактивный PTY -i»**. Веб-терминал обрабатывает ANSI, передаёт клавиатуру
и resize тем же общим PTY codec из `p2p-netcat-core`.

`-q` скрывает диагностику в stderr, не изменяя прикладные байты. `-T` повторно
запускает клиент через `torsocks`, отключает прямые QUIC/WebRTC и автоматический
discovery, поэтому требует явного TCP/WS/WSS Circuit Relay:

```bash
P2P_NETCAT_TOR_HOST=127.0.0.1 \
P2P_NETCAT_TOR_PORT=9050 \
p2p-nc -T \
  --relay /ip4/203.0.113.10/tcp/9090/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW \
  12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

Нужны установленные `Tor`, `torsocks` и доступный relay. Проверки сочетаний
опций, границы безопасности и переменные окружения описаны в
[полном руководстве](docs/GS_NETCAT_COMPAT.RU.md).

## Аналоги типичных команд netcat

Проверка доступности без обмена данными:

```bash
p2p-nc -z -v 12D3KooWLs9pvVfwbo6yHsYB66kRLq2RJwfH3bBQZhp94kerbFd9 8080
```

Передача файла:

```bash
p2p-nc -l 9000 > received.tar.gz
p2p-nc 12D3KooWLs9pvVfwbo6yHsYB66kRLq2RJwfH3bBQZhp94kerbFd9 9000 < archive.tar.gz
```

Запуск команды для каждого подключения:

```bash
p2p-nc -l -k 7000 -e '/bin/sh -i'
```

`-e` даёт подключившемуся пользователю права локального процесса. Использовать
его можно только с доверенными PeerId и в изолированном окружении.

Полная справка:

```bash
p2p-nc --help
p2p-nc relay --help
```

## Как проходит соединение

1. Слушатель загружает постоянный ключ; хеш публичного ключа становится PeerId.
2. Логический порт `8080` превращается в libp2p-протокол
   `/p2p-netcat/1.0.0/8080`.
3. Сервер публикует provider record для CID собственного PeerId в Amino DHT.
4. Клиент ищет PeerId через известные адреса, mDNS, подписанный GossipSub,
   provider record или DHT.
5. При `--relay` строится маршрут `relay/p2p-circuit/p2p/server`.
6. Без явного маршрута параллельно запускаются native Nostr/WebTorrent WebRTC
   и libp2p-поиск; отложенный Trystero сохраняет совместимость со старыми peers.
7. QUIC TLS 1.3, Noise или подписанный WebRTC challenge аутентифицирует PeerId.
8. stdin/stdout или PTY-фреймы передаются с ограниченным backpressure. Браузер
   подтверждает вывод только после его отрисовки в xterm.
9. Временный разрыв WebRTC переводит канал в состояние переподключения на 120
   секунд. При возвращении того же peer сохраняются прежний PTY и ограниченная
   очередь вывода.

С `-v` CLI показывает активные ветки поиска libp2p и WebRTC, число открытых
Nostr relay/WebTorrent tracker, прошедшее время, проверку кандидата, выбранную
signaling-стратегию, изменения состояний WebRTC/ICE, восстановление сессии или
истечение grace-периода.

Полное пошаговое описание разных веток CLI и браузера, таймаутов, кеша,
параллельного выбора адресов и модели доверия находится в
[документе об архитектуре](docs/ARCHITECTURE.RU.md).

HTTP/3 не используется как прикладной протокол. Между узлами передаются сырые
libp2p QUIC-потоки без лишних HTTP-запросов, заголовков и семантики CONNECT.

## Практические ограничения MVP

- «Только PeerId» через интернет работает после публикации provider record с
  публичным или relay-адресом сервера. При первом запуске это может занять около
  минуты; `-v` показывает успешную публикацию.
- Серверы за CGNAT должны использовать доступный Circuit Relay v2; самый
  надёжный вариант — передать одинаковый `--relay` серверу и клиенту.
- WebRTC увеличивает шанс прямого соединения, но symmetric NAT и блокировка UDP
  могут потребовать TURN или Circuit Relay; публичные trackers не дают SLA.
- Native adapters подключаются к нескольким публичным Nostr relay и WebTorrent
  trackers и автоматически восстанавливают signaling. Trystero временно
  сохранён только как отложенный compatibility fallback. Сторонняя
  инфраструктура не гарантирует 100% доступность.
- Свёрнутая или фоновая страница продолжит тот же PTY, пока браузер сохраняет
  её JavaScript-контекст. Полная выгрузка вкладки из памяти или reload создаёт
  новую временную signaling identity, поэтому такой клиент начнёт новый PTY.
- PubSub улучшает discovery только после подключения к участнику совместимой
  mesh и не является глобальным rendezvous-сервисом.
- IPFS HTTP gateway не является relay и не может переносить этот протокол.
- Если сеть блокирует UDP, соединение автоматически откатывается на TCP при
  наличии обоих адресов; `--no-quic` отключает QUIC явно.
- В `-k` без `-e` общий stdin неудобен для параллельных клиентов; входящие
  потоки ограничены одним активным сеансом.
- Авторизация по allowlist PeerId и режим датаграмм — следующие логичные этапы,
  но в текущей версии не реализованы.

## Разработка

```bash
npm test
npm run lint
npm --prefix packages/core test
cd web && npm ci && npm test && npm run lint
```
