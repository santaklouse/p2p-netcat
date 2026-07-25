# p2p-netcat

**English** | [Русский](README.RU.md)

`p2p-nc` is a JavaScript command-line utility inspired by `netcat`. Instead of
the server's IP address, it uses a cryptographic libp2p `PeerId`. Its transport
is compatible with the IPFS networking stack: QUIC v1, TCP, Noise, Yamux, IPFS
Amino DHT, mDNS, and Circuit Relay v2.

## Documentation

- [Detailed architecture and connection algorithm](docs/ARCHITECTURE.md) —
  identity, discovery, route selection, CLI, browser, relay, encryption,
  backpressure, and failure handling;
- [Browser PWA guide](web/README.md) — build, GitHub Pages,
  `network-config.json`, and WSS relay configuration;
- [Shared JavaScript library API](packages/core/README.md) — browser-safe
  `p2p-netcat-core`, also available to CLI consumers as `p2p-netcat/core`;
- [Programmatic Circuit Relay API](docs/RELAY_API.md) — start and stop a relay
  from another Node.js application through `p2p-netcat/relay`.
- [gs-netcat-compatible modes](docs/GS_NETCAT_COMPAT.md) — `-d`, `-p`, `-q`,
  `-S`, `-T`, and `-i`, including forwarding, SOCKS, PTY, and Tor routing.
- [Publishing guide](docs/PUBLISHING.md) — release order, npm verification,
  and clean-install checks for the CLI, core, and prebuilt web PWA.

## What already works

- Bidirectional, binary-transparent stdin/stdout transfer;
- QUIC v1 as the preferred direct transport, with automatic TCP fallback;
- A stable server PeerId derived from a local Ed25519 key;
- Logical ports, allowing one PeerId to expose multiple services;
- PeerId-only discovery through mDNS, signed GossipSub announcements, and the
  IPFS Amino DHT;
- a direct Trystero/WebRTC fallback; Node.js races public Nostr relays and
  WebTorrent trackers while the browser keeps the compatible WebTorrent path;
- a shared nine-endpoint STUN pool for CLI and browser WebRTC NAT traversal;
- bounded end-to-end flow control from `node-pty` through the transport and Web
  Worker to xterm;
- automatic recovery of a temporarily lost WebRTC peer for 120 seconds without
  terminating the existing PTY;
- Circuit Relay v2 connections for nodes behind NAT;
- A built-in relay mode;
- gs-netcat-style TCP forwarding, SOCKS4/4a/5, quiet, Tor, and true PTY modes;
- `-l`, `-k`, `-w`, `-d`, `-p`, `-q`, `-S`, `-T`, `-i`, `-z`, `-e`, `-4`,
  `-6`, and verbose mode;
- Authenticated encryption through QUIC TLS 1.3 or Noise, including connections
  through a relay.

Netcat-style UDP datagram mode (`-u`) is deliberately rejected for now. QUIC
does use UDP underneath, but it still provides a reliable, ordered stream.

## Installation

Node.js 22 or newer is required. The QUIC transport uses a native N-API module
with prebuilt binaries for mainstream macOS, Linux, and Windows platforms.
Interactive `-i` uses the native `node-pty` module; on Linux, installing from
npm may require Python, `make`, and a C/C++ compiler for `node-gyp`.

The current js-libp2p dependency set does not support Node.js 18. On an older
Ubuntu installation, upgrade before running the CLI:

```bash
nvm install 22
nvm use 22
node --version
```

The CLI checks this before importing libp2p and reports the required version
instead of a secondary `CustomEvent`, `Promise.withResolvers`, or PubSub cleanup
error.

Install the published CLI from npm:

```bash
npm install --global p2p-netcat
```

For development from source:

```bash
npm install
npm link
```

After `npm link`, both commands are available: `p2p-nc` and the shorter `pnc`.

QUIC is enabled by default. Use `--no-quic` only for diagnostics or on a system
where the native QUIC module is unavailable. `-p` now follows gs-netcat and is
used for TCP forwarding. The internal libp2p TCP/UDP listen port is configured
with `--transport-port`; when it is `0`, the operating system chooses each port
independently. `-i` now means interactive PTY, so the short identity option is
`-I` while `--identity` remains unchanged.

## Quick start

On the first computer:

```bash
p2p-nc -l 8080
```

The command prints the persistent PeerId to `stderr`, for example:

```text
[p2p-nc] слушатель:8080 PeerId: 12D3KooWLs9pvVfwbo6yHsYB66kRLq2RJwfH3bBQZhp94kerbFd9
```

On the second computer, copy the printed PeerId and run:

```bash
p2p-nc 12D3KooWLs9pvVfwbo6yHsYB66kRLq2RJwfH3bBQZhp94kerbFd9 8080
```

Once connected, everything typed in either terminal is sent to the other one.
The PeerId above is illustrative: the connection command must contain the value
printed by your own listener.

To print the PeerId without starting a listener:

```bash
p2p-nc id
```

The server key is created at `~/.config/p2p-netcat/identity.key` with `0600`
permissions. Deleting the key creates a new PeerId. The client identity is
ephemeral unless `--identity` is supplied explicitly.

## Verifiable local example without manual copying

The following commands run entirely on one computer:

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

## Nodes behind NAT: running your own relay

The public IPFS DHT is used for discovery, but public IPFS nodes do not promise
unlimited relaying of arbitrary streams. For predictable connectivity between
two nodes behind NAT, run a relay once on a VPS with both TCP and UDP port 9090
open:

```bash
p2p-nc relay -4 -p 9090 \
  --announce /ip4/203.0.113.10/udp/9090/quic-v1 \
  --announce /ip4/203.0.113.10/tcp/9090
```

In a real command, `--announce` must contain the VPS's public address. The relay
prints its complete multiaddr. Assume it prints:

```text
/ip4/203.0.113.10/udp/9090/quic-v1/p2p/12D3KooWK4bicbvfPNGzfuMBf6xE43ecgB26NHDZRTfLM7CNh9yw
/ip4/203.0.113.10/tcp/9090/p2p/12D3KooWK4bicbvfPNGzfuMBf6xE43ecgB26NHDZRTfLM7CNh9yw
```

Server behind NAT:

```bash
p2p-nc -l 8080 --relay /ip4/203.0.113.10/udp/9090/quic-v1/p2p/12D3KooWK4bicbvfPNGzfuMBf6xE43ecgB26NHDZRTfLM7CNh9yw
```

The client behind NAT uses the same relay but addresses the server only by its
PeerId:

```bash
p2p-nc --relay /ip4/203.0.113.10/udp/9090/quic-v1/p2p/12D3KooWK4bicbvfPNGzfuMBf6xE43ecgB26NHDZRTfLM7CNh9yw 12D3KooWJ7satLo5LXjhSZBMVTWRG1AZ77sQYtX81qHHf2VtscdL 8080
```

Traffic between the client and server remains end-to-end encrypted. The relay
can see the participants' PeerIds and traffic volume and timing, but it cannot
read the contents.

The same relay can be embedded into another Node.js process without spawning
the CLI:

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

See the [programmatic relay guide](docs/RELAY_API.md) for every option,
persistent identity, signal handling, public announce addresses, and WSS.

## Browser PWA client

The `web` directory contains a fully static React client without SSR, API
routes, a database, or server-side scripts. The libp2p networking stack runs in
a Web Worker. A Service Worker caches the application shell for offline PWA
startup and updates it in the background. The page includes a terminal widget,
text and file transfer, EOF, and binary-stream download.

Build the static files:

```bash
cd web
npm install
npm run build
```

The result is written to `web/dist` and can be placed on any HTTPS static file
host; the application needs no backend. Opening it through `file://` is not a
supported mode because browsers require a secure context—HTTPS or `localhost`—
for Service Workers and PWA installation.

A ready-to-use `.github/workflows/pages.yml` workflow is included for GitHub
Pages. In the repository settings, select **Settings → Pages → Source → GitHub
Actions**. The workflow automatically uses the repository subpath as Vite's
base URL.

The browser does not require a relay address by default. It starts two paths in
parallel: Trystero/WebRTC through public WebTorrent trackers, and libp2p lookup
through signed GossipSub announcements, HTTP Delegated Routing, and IPFS Amino
DHT fallback. The first authenticated channel wins. Discovered libp2p
multiaddrs are also raced.

GossipSub discovery is enabled by default in CLI nodes, relays, and the browser
Worker. Use `--no-pubsub` on the CLI or relay command to disable it. It is an
additional discovery path, not a global rendezvous guarantee: both peers need
connectivity to a compatible GossipSub mesh. Trystero uses the shared STUN pool
to improve direct NAT traversal; STUN alone cannot replace TURN or Circuit
Relay when both sides are behind restrictive NAT.

If the server advertises only TCP/QUIC addresses or automatic discovery cannot
find a usable route, expand the advanced settings and provide a WebSocket relay:

```bash
p2p-nc relay -4 -p 9090 --websocket-port 9091
```

Locally, the browser can use the printed address containing
`/tcp/9091/ws/p2p/`. When the page is hosted on HTTPS, publish the relay over
WSS, typically through a TLS reverse proxy on port 443. See
[`web/README.md`](web/README.md) for the complete guide.

## Shared JavaScript library

Logic that must behave identically in the CLI and browser lives in the
[`p2p-netcat-core`](packages/core) npm package. It uses no Node.js APIs and
owns logical-port and protocol-ID rules, PeerId/multiaddr validation, WS/WSS
relay validation, Circuit Relay route planning, and transport preference.

Applications that already depend on the CLI package can use its subpath export:

```js
import { createRelayDialPlan, protocolForService } from 'p2p-netcat/core'
```

Browser-only packages should keep using the smaller standalone
`p2p-netcat-core` package to avoid installing Node-only CLI transports. The CLI
imports the same core, while the browser imports it from its
Web Worker. Platform adapters remain separate: stdin/stdout, local identities,
QUIC, and the DHT belong to the CLI; DOM integration, Worker RPC, and the PWA
lifecycle belong to `web`. This gives future discovery and fallback strategies
one shared interface instead of two diverging implementations.

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

## gs-netcat-style modes

Expose `192.168.6.7:22` on the server side and listen locally on client port
`2222`. Every local TCP connection receives an independent P2P stream:

```bash
# Server side
p2p-nc -l -d 192.168.6.7 -p 22 31337

# Client side
p2p-nc -p 2222 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
ssh -p 2222 root@127.0.0.1
```

Run a SOCKS4/4a/5 proxy on the remote node and expose it as local port `1080`:

```bash
# Server side
p2p-nc -l -S 31337

# Client side
p2p-nc -p 1080 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
curl --proxy socks5h://127.0.0.1:1080 https://example.com/
```

Open a real PTY login shell. Terminal resize and control bytes are forwarded;
press `Ctrl-e q` to disconnect the client:

```bash
p2p-nc -l -i 31337
p2p-nc -i 12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

Before connecting the browser client to this listener, enable
**Interactive PTY -i**. The web terminal renders ANSI and forwards keyboard and
resize events through the shared `p2p-netcat-core` PTY codec.

`-q` suppresses diagnostics on stderr without changing application bytes.
`-T` re-executes the client under `torsocks`, disables direct QUIC/WebRTC and
automatic discovery, and therefore requires an explicit TCP/WS/WSS Circuit
Relay route:

```bash
P2P_NETCAT_TOR_HOST=127.0.0.1 \
P2P_NETCAT_TOR_PORT=9050 \
p2p-nc -T \
  --relay /ip4/203.0.113.10/tcp/9090/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW \
  12D3KooWQ3uxpHgjDKE6vGmvzKS8RPbxUDLwJ7XCLaD6YXdUfbR9 31337
```

`Tor`, `torsocks`, and a reachable relay are required. See the
[complete compatibility guide](docs/GS_NETCAT_COMPAT.md) for mode validation,
security boundaries, and environment variables.

## Equivalents of common netcat commands

Check reachability without exchanging data:

```bash
p2p-nc -z -v 12D3KooWLs9pvVfwbo6yHsYB66kRLq2RJwfH3bBQZhp94kerbFd9 8080
```

Transfer a file:

```bash
p2p-nc -l 9000 > received.tar.gz
p2p-nc 12D3KooWLs9pvVfwbo6yHsYB66kRLq2RJwfH3bBQZhp94kerbFd9 9000 < archive.tar.gz
```

Run a command for each connection:

```bash
p2p-nc -l -k 7000 -e '/bin/sh -i'
```

The `-e` option gives the connected user the privileges of the local process.
Use it only with trusted PeerIds and inside an isolated environment.

Complete command reference:

```bash
p2p-nc --help
p2p-nc relay --help
```

## How a connection is established

1. The listener loads its persistent key; the hash of the public key becomes
   its PeerId.
2. Logical port `8080` becomes the libp2p protocol
   `/p2p-netcat/1.0.0/8080`.
3. The server publishes a provider record for its PeerId CID to the Amino DHT.
4. The client searches known addresses, mDNS, signed GossipSub announcements,
   that provider record, and the DHT.
5. With `--relay`, it builds a `relay/p2p-circuit/p2p/server` route.
6. Without an explicit route, a direct Trystero/WebRTC channel is attempted in
   parallel.
7. QUIC TLS 1.3, Noise, or a signed WebRTC challenge authenticates the PeerId.
8. stdin/stdout or PTY frames are transferred with bounded backpressure. The
   browser acknowledges output only after xterm has rendered it.
9. A transient WebRTC disconnect enters a 120-second reconnecting state. The
   existing PTY and bounded output queue survive when the same peer returns.

With `-v`, the CLI reports the active libp2p and WebRTC search branches, open
Nostr relay/WebTorrent tracker counts, elapsed search time, candidate
authentication, the selected signaling strategy, WebRTC/ICE state changes, and
session recovery or grace-period expiry.

The [architecture document](docs/ARCHITECTURE.md) describes every CLI and
browser branch, timeout, cache, concurrent address race, and trust boundary in
detail.

HTTP/3 is not part of the application protocol. Direct peers use raw libp2p
QUIC streams, avoiding unnecessary HTTP request, header, and CONNECT semantics.

## Practical MVP limitations

- PeerId-only internet connections work after a provider record containing a
  public or relayed server address has been published. The first publication
  may take about a minute; `-v` reports when it succeeds.
- Servers behind CGNAT must use an available Circuit Relay v2. The most reliable
  option is to pass the same `--relay` to both the server and client.
- WebRTC improves direct connectivity, but symmetric NAT or blocked UDP may
  still require TURN or Circuit Relay; public trackers provide no SLA.
- Trystero uses all trackers bundled with its current BitTorrent strategy and
  Node.js also races a Nostr signaling strategy. Both automatically reconnect,
  but third-party infrastructure cannot guarantee 100% availability.
- A backgrounded page can resume the same PTY while its JavaScript context
  remains alive. A browser that fully discards or reloads the page creates a
  new ephemeral Trystero identity and therefore starts a new PTY session.
- PubSub improves discovery only after a node reaches a compatible mesh member;
  it is not a global rendezvous service.
- An IPFS HTTP gateway is not a relay and cannot carry this protocol.
- Networks that block UDP automatically fall back to TCP when both addresses
  are known; `--no-quic` disables QUIC explicitly.
- In `-k` mode without `-e`, shared stdin is inconvenient for concurrent
  clients; incoming streams are limited to one active session.
- PeerId allowlist authorization and datagram mode are natural next steps, but
  they are not implemented in this version.

## Development

```bash
npm test
npm run lint
npm --prefix packages/core test
cd web && npm ci && npm test && npm run lint
```
