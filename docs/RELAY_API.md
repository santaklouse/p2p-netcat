# Programmatic Circuit Relay API

**English** | [Русский](RELAY_API.RU.md)

The Node.js package exposes a dedicated relay entrypoint:

```js
import { startRelay } from 'p2p-netcat/relay'
```

This entrypoint is Node-only. It is not part of the browser-safe
`p2p-netcat-core` package.

## Installation

After publishing the current package version:

```bash
npm install p2p-netcat
```

Inside this repository, npm workspaces resolve the same entrypoint without an
additional package installation.

## Complete example

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
  console.log(`Stopping relay after ${signal}...`)
  await relay.stop()
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
```

`createLibp2p()` starts the node before `startRelay()` resolves. The returned
handle therefore represents a listening relay. The host application owns the
lifecycle: the library does not install process signal handlers and does not
call `process.exit()`.

## Options

| Option | Default | Meaning |
|---|---:|---|
| `identityPath` | p2p-netcat relay identity path | Persistent Ed25519 key. Pass `null` for an ephemeral PeerId. |
| `privateKey` | — | Existing libp2p private key. It takes precedence over `identityPath`. |
| `localPort` | `9090` | TCP port and, when enabled, QUIC UDP port. Use `0` in tests for an OS-assigned port. |
| `websocketPort` | `9091` | Plain WebSocket listen port. Pass `null` to disable it. |
| `ipVersion` | both | Set to `4` or `6` to restrict listeners. |
| `announce` | `[]` | Public multiaddrs announced instead of relying only on observed/interface addresses. |
| `enableMdns` | `true` | Enables LAN discovery. |
| `enablePubsub` | `true` | Enables signed GossipSub peer announcements on the p2p-netcat topic. |
| `enableQuic` | `true` | Enables QUIC v1 in addition to TCP. |

With PubSub enabled, the relay also acts as a compatible discovery mesh member.
It can forward signed peer announcements between connected p2p-netcat nodes;
it is still not a central directory, and nodes must first have a route to at
least one member of the same GossipSub mesh. Set `enablePubsub: false` to run a
relay without this discovery role.

The returned handle contains:

- `node`: the started libp2p node for advanced integrations;
- `peerId`: the relay PeerId as a string;
- `addresses`: current listen/announce multiaddrs with `/p2p/<relayPeerId>`;
- `identityPath`: the resolved persistent-key path, or `null` for an injected
  or ephemeral key;
- `stop()`: an idempotent asynchronous shutdown function.

## Public deployment and WSS

`P2P_RELAY_ANNOUNCE` in the example accepts comma-separated real public
multiaddrs. The relay itself listens on `/ws`; an HTTPS browser can only dial a
public `/wss` address. Terminate TLS at a reverse proxy or CDN, forward it to
the relay WebSocket port, and put the resulting WSS multiaddr in the web
client's manual relay field or `network-config.json`.

Circuit Relay forwards an already encrypted libp2p connection. It can observe
PeerIds, timing, and traffic volume, but not the Noise-protected application
payload.
