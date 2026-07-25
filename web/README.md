# p2p-netcat web

**English** | [Русский](README.RU.md)

The complete interaction between the core package, CLI, browser discovery, and
secure stream is documented in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

A fully static browser client for `p2p-netcat`. The project has no SSR, API
routes, database, or server-side scripts. Its production build contains only
HTML, CSS, JavaScript, a Web Worker, a Service Worker, a manifest, and images.

## Features

- connection to a CLI server by `PeerId` and logical port;
- automatic lookup through signed GossipSub announcements, HTTP Delegated
  Routing, and IPFS Amino DHT;
- direct Trystero/WebRTC fallback through public WebTorrent trackers;
- WebTransport or WebSocket/WSS through libp2p Circuit Relay v2;
- an optional manual relay multiaddr as an emergency override;
- Noise encryption and Yamux inside a dedicated Web Worker;
- a terminal widget for text and binary output;
- an interactive xterm-compatible PTY client for listeners started with `-i`;
- text, file, and EOF sending, plus received-byte download;
- an installable PWA with offline UI caching and Service Worker auto-update;
- responsive desktop, tablet, and mobile layouts.

## Connecting to an `-i` listener

Start the CLI listener:

```bash
p2p-nc -l -i 31337
```

In the web UI, enter the printed PeerId and port `31337`, then enable
**Interactive PTY -i** before connecting. In this mode the browser uses the
same framed PTY protocol as the CLI client: keyboard input is forwarded
directly, ANSI sequences are rendered by the terminal, and widget resize events
are sent to the remote `node-pty` process.

Type `exit` or press `Ctrl-E` followed by `q` to leave. The mode is explicit
because ordinary streams and PTY sessions share one logical protocol ID and the
server does not send a separate mode-negotiation message. Leave the switch off
when the listener was started without `-i`.

## Architecture

The Web Worker imports the browser-safe
[`@santaklouse/p2p-netcat-core`](../packages/core) package also used by the CLI.
Protocol IDs, PeerId and logical-port validation, the PTY codec, WS/WSS rules,
and Circuit Relay dial-plan construction are shared. Delegated Routing, the DHT client,
libp2p WebTransport/WebSocket transports, Trystero/WebRTC, Worker messaging,
the terminal UI, and the PWA/Service Worker remain in the web project. This
architecture runs no server-side JavaScript.

When the relay field is empty, Trystero/WebRTC and the Worker start
simultaneously. The Worker listens for signed announcements on the app-specific
GossipSub topic, resolves the PeerId through
`https://delegated-ipfs.dev/routing/v1`, and then uses DHT as a fallback. The
first authenticated channel wins. A successful libp2p route is cached in
IndexedDB for 24 hours. The WebRTC server proves the entered PeerId with a
signed Ed25519 challenge. `public/network-config.json` can add compatible
routing endpoints and a hidden WSS relay pool without changing the UI:

```json
{
  "delegatedRouting": [
    "https://delegated-ipfs.dev/routing/v1"
  ],
  "relays": []
}
```

The `.npmrc` file enables `install-links=true`. This copies the local package
into `node_modules` during `npm ci`, so a clean GitHub Actions build does not
depend on packages previously installed at the repository root.

## PubSub discovery and WebRTC STUN

The Worker and CLI use the same topic:
`io.github.santaklouse.p2p-netcat.peer-discovery.v1`. The
`@libp2p/pubsub-peer-discovery` service periodically publishes the node public
key and current multiaddrs. GossipSub uses strict message signing by default;
the receiver derives the PeerId from the included public key before accepting
the addresses into its peer store. This does not make the announcement trusted:
the final libp2p handshake still has to prove the requested PeerId. Only
browser-dialable WSS/WebTransport/WebRTC addresses become web dial candidates.

PubSub is not a bootstrap mechanism by itself. An announcement can reach the
browser only after it has connected to a compatible subscriber on the same
topic. Public generic IPFS bootstrap peers are not guaranteed to join or carry
this application topic. A p2p-netcat relay participates in the topic by
default, so an already reachable relay can also forward discovery messages.

Both browser and Node Trystero clients use this ICE/STUN pool:

```text
stun:stun.l.google.com:19302
stun:stun1.l.google.com:19302
stun:stun2.l.google.com:19302
stun:stun3.l.google.com:19302
stun:stun4.l.google.com:19302
stun:stun.counterpath.com:3478
stun:stun.sipgate.net:3478
stun:stun.voipbuster.com:3478
stun:stun.internetcalls.com:3478
```

STUN servers learn public NAT mappings and do not carry application bytes.
They are third-party services and may observe source IP addresses and request
timing. STUN does not relay traffic and therefore cannot guarantee WebRTC
connectivity through symmetric NAT or networks that block UDP; the existing
Circuit Relay path remains the deterministic fallback when a reachable relay
is configured.

## Installation and build

Node.js 22.13 or newer is required.

```bash
cd web
npm install
npm run lint
npm run build
```

The complete standalone static output is written to `web/dist`. It can be
deployed to any HTTPS static-file host; the application does not need a backend.

For development:

```bash
cd web
npm run dev
```

## GitHub Pages

The repository already contains `.github/workflows/pages.yml`. It checks
TypeScript, builds only the `web` directory, derives the Vite base path from the
GitHub repository name, and publishes `web/dist`.

After pushing the repository, open **Settings → Pages** and select
**Build and deployment → Source → GitHub Actions**. The next push to `main`
publishes the page automatically. For `santaklouse/p2p-netcat`, the expected
URL is:

```text
https://santaklouse.github.io/p2p-netcat/
```

GitHub Pages supplies HTTPS, allowing the Service Worker, PWA installation,
Delegated Routing, WebRTC, and secure WSS/WebTransport routes to work.

## Verifiable manual relay route

The relay field is optional. This example tests the explicit fallback locally
when automatic discovery cannot use the CLI server's TCP/QUIC address.

Start a relay with a separate WebSocket port in the first terminal:

```bash
p2p-nc relay -4 -p 9090 --websocket-port 9091
```

Copy the printed address containing `/tcp/9091/ws/p2p/`. Start the server in a
second terminal and pass that address through `--relay`:

```bash
p2p-nc -l 31337 --relay /ip4/127.0.0.1/tcp/9091/ws/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW
```

Enter the server PeerId and logical port `31337` in the web UI. Then expand
“Additional relay” and enter the same WebSocket relay multiaddr.

The PeerId in the command above belongs to a development test key. A normal
relay run prints a different PeerId—always use the complete address that your
running relay actually prints.

## HTTPS, WSS, and running without a backend

Service Workers and PWA installation require a secure context: HTTPS or
`localhost`. Opening `dist/index.html` through `file://` is therefore not a
supported browser mode. This is a browser security restriction, not a need for
application server logic.

An `http://*.github.io` URL is automatically replaced with its `https://`
equivalent before the application starts. This is required for Web Crypto,
WebRTC, and Service Workers. If another static host serves the page over plain
HTTP, the network worker stops with an explicit HTTPS diagnostic.

When a manual relay is used from an HTTPS page, it must be available through
WSS. TLS normally terminates at a static reverse proxy or CDN that forwards
WebSocket traffic to port `9091`. The public multiaddr then has this form:

```text
/dns4/p2p.example.com/tcp/443/wss/p2p/12D3KooWEqeQRAJ61HSv9yMPk8yzjke7NxmTFcvFt4GzwXxzVjXW
```

The web application itself accepts no HTTP requests and executes no server
code. After the first load, the UI shell is available offline. A P2P session
still requires network access and at least one browser-dialable route.

## Verification

```bash
cd web
npm test
npm run lint
```
