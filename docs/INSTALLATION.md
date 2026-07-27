# Installing p2p-netcat

[Русская версия](INSTALLATION.RU.md)

## Requirements

- Node.js 22 or newer;
- npm distributed with Node.js;
- macOS, Linux, or Windows;
- outbound TCP/WSS and UDP connectivity for discovery, signaling, and direct
  QUIC/WebRTC.

Check the installed versions:

```bash
node --version
npm --version
```

If Node.js is not installed, use the official installer:
[nodejs.org/download](https://nodejs.org/en/download).

## One-line installation

```bash
npm install --global p2p-netcat@latest
```

Verify the CLI:

```bash
p2p-nc --version
p2p-nc --help
```

The `p2p-nc` and `pnc` commands point to the same executable.

## Updating

```bash
npm install --global p2p-netcat@latest
```

## Uninstalling

```bash
npm uninstall --global p2p-netcat
```

## First stream session

On the computer accepting the connection:

```bash
p2p-nc -l -v 31337
```

The command prints its persistent PeerId. Use that PeerId on the second
computer:

```bash
printf 'hello from p2p-netcat\n' | p2p-nc 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

The PeerId above is syntactically valid, but a real connection must use the
PeerId printed by your listener.

## Interactive PTY

On the server:

```bash
p2p-nc -l -i -v 31337
```

In a CLI client:

```bash
p2p-nc -i 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

Alternatively, open the static
[browser client](https://santaklouse.github.io/p2p-netcat/), enable
“Interactive PTY”, and paste your server PeerId.

Exit the interactive CLI with `Ctrl-E`, then `Q`.

## Persistent identity

By default, the listener stores its identity key in the user configuration
directory. To select the file explicitly:

```bash
p2p-nc -l -I /var/lib/p2p-netcat/server.key -v 31337
```

Back up this file. Creating a new key creates a new PeerId.

## When PeerId discovery takes too long

Run both sides with `-v`. The CLI reports:

- libp2p DHT/PubSub lookup state;
- open Nostr relay and WebTorrent tracker counts;
- WebRTC candidate discovery and authentication;
- the selected transport;
- WebRTC/ICE changes and recovery.

Increase the lookup deadline to 90 seconds:

```bash
p2p-nc -v -w 90 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

Every WebRTC connection now uses only the project-owned Nostr/WebTorrent
signaling implementation. To inspect that path, enable verbose diagnostics:

```bash
p2p-nc -l -i -v 31337
p2p-nc -i -v 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

For two peers behind restrictive NAT, the most predictable option is to give
both sides the same reachable Circuit Relay v2 with `--relay`. See the
[relay API](RELAY_API.md) and [connection algorithm](ARCHITECTURE.md).

## npm permission errors

Do not recursively change permissions on system npm directories. Prefer a
user-owned Node.js version manager or the official installer, then retry:

```bash
npm install --global p2p-netcat@latest
```
