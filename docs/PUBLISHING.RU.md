# Публикация p2p-netcat в npm

**Русский** | [English](PUBLISHING.md)

Репозиторий формирует три публичных npm-пакета без scope:

| Пакет | Версия | Содержимое |
|---|---:|---|
| `p2p-netcat-core` | `0.5.0` | Browser-safe protocol, native trickle ICE, приватный pairing, route records и PTY-примитивы |
| `p2p-netcat` | `3.3.0` | Node.js CLI и точки входа `p2p-netcat/core`, `p2p-netcat/relay` |
| `p2p-netcat-web` | `0.6.0` | Собранная статическая PWA с собственным WebRTC в каталоге `dist` |

Исходный GitHub-репозиторий:
[`santaklouse/p2p-netcat`](https://github.com/santaklouse/p2p-netcat).

## Требования

- Node.js 22.13 или новее;
- npm-аккаунт с включённой 2FA либо granular token с правом публикации;
- право записи для всех трёх имён пакетов;
- npm registry `https://registry.npmjs.org/`.

Авторизуйтесь и проверьте активный аккаунт:

```bash
npm config set registry https://registry.npmjs.org/
npm login --auth-type=web
npm whoami
```

Ожидаемый аккаунт — `santaklouse`.

## Проверка релиза

Выполните из корня репозитория:

```bash
npm ci
npm run lint
npm test
npm run soak:webrtc -- --profile ci

npm --prefix web ci
npm --prefix web run lint
npm --prefix web test

npm pack ./packages/core --dry-run
npm pack . --dry-run
npm pack ./web --dry-run
```

Проверьте три списка файлов, напечатанные `npm pack`. В них не должно быть
приватных ключей, npm-токенов, кешей разработки и `node_modules`.

## Порядок публикации

Сначала публикуется зависимость, затем использующие её пакеты:

```bash
npm publish ./packages/core --access public
npm publish . --access public
npm publish ./web --access public
```

Пакет `p2p-netcat` был полностью удалён 20 июля 2026 года. npm блокирует
повторное использование имени на 24 часа, а уже использованную комбинацию
`name@version` нельзя опубликовать снова никогда. Версия `3.3.0` завершает
удаление Trystero, добавляет Nostr trickle ICE и автоматическую WebRTC
soak-матрицу.

Web-пакет публикует только собранный `dist`, README, лицензию и метаданные.
Зависимости сборки остаются development-only и не устанавливаются пользователю
статического артефакта.

## Проверка registry

```bash
npm view p2p-netcat-core version dist-tags.latest maintainers --json
npm view p2p-netcat version dist-tags.latest maintainers --json
npm view p2p-netcat-web version dist-tags.latest maintainers --json
```

Проверьте чистую установку во временном каталоге:

```bash
release_test_dir="$(mktemp -d)"
npm install --prefix "${release_test_dir}" \
  p2p-netcat-core@0.5.0 \
  p2p-netcat@3.3.0 \
  p2p-netcat-web@0.6.0
"${release_test_dir}/node_modules/.bin/p2p-nc" --version
test -f "${release_test_dir}/node_modules/p2p-netcat-web/dist/index.html"
```

Ожидаемый вывод CLI:

```text
3.3.0
```

## Следующие релизы

Не удаляйте обычный релиз для исправления. Увеличьте версию нужного пакета,
повторите проверки и опубликуйте новую неизменяемую версию. Если CLI или
web-сборка зависит от новой версии core, всегда сначала публикуйте
`p2p-netcat-core`.

После первого ручного релиза настройте npm trusted publishing для GitHub вместо
хранения долгоживущего npm-токена в GitHub Actions.
