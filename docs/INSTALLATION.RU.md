# Установка p2p-netcat

[English version](INSTALLATION.md)

## Требования

- Node.js 22 или новее;
- npm, поставляемый вместе с Node.js;
- macOS, Linux или Windows;
- исходящие TCP/WSS- и UDP-соединения для discovery, signaling и прямого
  QUIC/WebRTC.

Проверьте версии:

```bash
node --version
npm --version
```

Если Node.js ещё не установлен, используйте официальный установщик:
[nodejs.org/download](https://nodejs.org/en/download).

## Установка одной командой

```bash
npm install --global p2p-netcat@latest
```

Проверьте установленный CLI:

```bash
p2p-nc --version
p2p-nc --help
```

Команды `p2p-nc` и `pnc` указывают на один бинарный файл.

## Обновление

```bash
npm install --global p2p-netcat@latest
```

## Удаление

```bash
npm uninstall --global p2p-netcat
```

## Первый обычный сеанс

На компьютере, принимающем соединение:

```bash
p2p-nc -l -v 31337
```

Команда напечатает постоянный PeerId. На втором компьютере передайте
полученный PeerId:

```bash
printf 'hello from p2p-netcat\n' | p2p-nc 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

PeerId в примере синтаксически корректен, но для реального соединения
скопируйте PeerId, напечатанный вашим слушателем.

## Интерактивный PTY

На сервере:

```bash
p2p-nc -l -i -v 31337
```

В CLI-клиенте:

```bash
p2p-nc -i 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

Либо откройте статический
[браузерный клиент](https://santaklouse.github.io/p2p-netcat/), включите
«Интерактивный PTY» и вставьте PeerId своего сервера.

Выход из интерактивного CLI: `Ctrl-E`, затем `Q`.

## Постоянный ключ и PeerId

По умолчанию слушатель хранит ключ в пользовательском каталоге конфигурации.
Чтобы явно выбрать файл:

```bash
p2p-nc -l -I /var/lib/p2p-netcat/server.key -v 31337
```

Сделайте резервную копию этого файла. Новый ключ создаст новый PeerId.

## Если PeerId долго не находится

Запускайте обе стороны с `-v`. CLI покажет:

- состояние поиска libp2p DHT/PubSub;
- число открытых Nostr relay и WebTorrent tracker;
- обнаружение и проверку WebRTC-кандидата;
- выбранный транспорт;
- изменения WebRTC/ICE и переподключение.

Увеличить время поиска до 90 секунд:

```bash
p2p-nc -v -w 90 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

Все WebRTC-соединения теперь используют только собственную реализацию signaling
через Nostr/WebTorrent. Для наблюдения за этим путём включите подробную
диагностику:

```bash
p2p-nc -l -i -v 31337
p2p-nc -i -v 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

Самый предсказуемый вариант для двух узлов за строгим NAT — передать обеим
сторонам один доступный Circuit Relay v2 через `--relay`. Подробности:
[программный relay](RELAY_API.RU.md) и
[алгоритм соединения](ARCHITECTURE.RU.md).

## Ошибка прав npm

Не меняйте права системных каталогов npm рекурсивно. Предпочтительно установить
Node.js через менеджер версий пользователя или официальный установщик, затем
повторить:

```bash
npm install --global p2p-netcat@latest
```
