# p2p-netcat-core

**English** | [Русский](README.RU.md)

The interaction between the library, CLI, and browser Worker is documented in
[`docs/ARCHITECTURE.md`](https://github.com/santaklouse/p2p-netcat/blob/main/docs/ARCHITECTURE.md).

The browser-safe shared core of `p2p-netcat`. The package does not use Node.js
APIs and can be imported by the CLI, a Web Worker, and other JavaScript clients.

The package owns:

- logical ports and protocol IDs;
- PeerId and multiaddr normalization;
- relay address validation;
- Circuit Relay dial-plan construction;
- browser-compatible address detection;
- a shared transport preference order;
- the application PubSub discovery topic and interval;
- the common WebRTC STUN pool;
- browser-safe PTY data/resize framing and incremental decoding;
- negotiated Trystero byte-window flow control, acknowledgements, keepalive,
  EOF, and abort semantics.

Creating a libp2p node, querying the DHT, Web Worker RPC, and stdin/stdout remain
in platform-specific packages.

## Exported API

| Function | Purpose |
|---|---|
| `validateService(value)` | Validates a logical port in the `1..65535` range |
| `protocolForService(service)` | Builds `/p2p-netcat/1.0.0/{service}` |
| `encodePtyData(value)` | Frames keyboard or terminal bytes for an interactive session |
| `encodePtyResize(columns, rows)` | Frames terminal dimensions |
| `decodePtyResize(value)` | Decodes and validates terminal dimensions |
| `PtyFrameDecoder` | Incrementally decodes PTY frames split across transport chunks |
| `normalizePeerId(value)` | Validates and canonicalizes a PeerId |
| `normalizeMultiaddr(value)` | Validates and canonicalizes a multiaddr |
| `normalizeRelayAddress(value, options)` | Applies relay, WS/WSS, and secure-context checks |
| `relayedTargetAddress(relay, peerId, options)` | Returns the target Circuit Relay multiaddr |
| `createRelayDialPlan(input)` | Returns an immutable dial plan |
| `browserDialableAddress(address, options)` | Checks whether a browser can dial an address |
| `addressRank(address)` | Returns a numeric transport rank |
| `preferDialAddresses(a, b)` | Comparator for sorting multiaddrs |
| `PUBSUB_DISCOVERY_TOPIC` | App-specific GossipSub discovery topic |
| `PUBSUB_DISCOVERY_INTERVAL_MS` | Announcement repeat interval |
| `DEFAULT_STUN_URLS` | Immutable shared STUN URL list |
| `defaultRtcConfiguration()` | Returns a fresh WebRTC configuration using the shared STUN pool |
| `trysteroRoomId(peerId, service)` | Builds the deterministic WebRTC room |
| `trysteroAuthPayload(...)` | Builds a domain-separated signed challenge |
| `encodeTrysteroAuthResponse(...)` | Encodes the public key and signature |
| `decodeTrysteroAuthResponse(...)` | Validates and decodes the response |
| `TrysteroStream` | Adapts an action channel to backpressure and EOF semantics |

The order is WebRTC Direct, QUIC v1, WebTransport, WSS, WS, TCP, other
addresses, and Circuit Relay. A transport appearing in the common ranking does
not imply that every runtime implements it.

`defaultRtcConfiguration()` returns a fresh object on every call because WebRTC
implementations may normalize or mutate their configuration. The current pool
contains the five Google STUN endpoints plus CounterPath, Sipgate, VoIPBuster,
and InternetCalls. STUN discovers NAT mappings; it is not a TURN relay and
cannot guarantee a direct route through symmetric or restrictive NATs.

`TrysteroStream` advertises flow-control support with `flow:1`. Two current
peers limit unacknowledged data to 256 KiB by default and send `ack:<bytes>`
only when the async consumer advances after processing a chunk. The handshake
is backward compatible: if the remote side does not advertise support, the
stream keeps the legacy transport behavior. A lightweight `ping`/`pong`
control message keeps an otherwise idle data channel active.

`peerDisconnected()` starts a bounded recovery window instead of turning an
unexpected WebRTC peer loss into EOF. While `connectionStatus` is
`reconnecting`, writes remain in the existing bounded queue.
`peerReconnected()` resumes that same logical stream and resets stale flow
credits. The default recovery window used by p2p-netcat is
`TRYSTERO_RECONNECT_GRACE_MS` (120 seconds). Explicit EOF and `abort()` still
close immediately.

Install the standalone browser-safe package when it is the only functionality
needed:

```bash
npm install p2p-netcat-core
```

Code that already installs the Node.js CLI package may use the equivalent
subpath export:

```js
import { createRelayDialPlan } from 'p2p-netcat/core'
```

Using `p2p-netcat-core` directly remains preferable in browser-only projects
because it does not install the CLI's Node-only transports.

Example of constructing a shared dial plan:

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
