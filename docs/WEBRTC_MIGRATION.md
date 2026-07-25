# WebRTC migration away from Trystero

**English** | [Русский](WEBRTC_MIGRATION.RU.md)

`p2p-netcat-core` now owns the WebRTC protocol, connection controller, and two
public-infrastructure signaling adapters. Trystero is no longer the primary
path. It remains a delayed compatibility fallback while the native path is
soak-tested between browsers, Linux, and macOS.

Removing Trystero does not remove the need for rendezvous infrastructure. Two
computers behind NAT cannot exchange SDP from a PeerId alone. The new code uses
public Nostr relays and WebTorrent WebSocket trackers transparently, but no
p2p-netcat server processes or server-side scripts are required.

## Current status

| Stage | Status |
|---|---|
| Signaling-independent byte stream, flow control, EOF, keepalive, and reconnect | Implemented in core |
| Native `RTCPeerConnection` and ordered reliable `RTCDataChannel` controller | Implemented in core |
| Signed Nostr signaling adapter | Implemented in core |
| WebTorrent WebSocket tracker signaling adapter | Implemented in core |
| CLI and static PWA integration | Native first, Trystero delayed by four seconds |
| Removal of Trystero npm dependencies | Pending real-network soak tests |

The browser still consists only of static assets suitable for GitHub Pages.
Node.js supplies `RTCPeerConnection` through `@roamhq/wrtc`; browsers use their
built-in implementation.

## Native connection algorithm

1. The listener derives a deterministic room from its persistent PeerId and
   logical port.
2. Both sides hash the versioned room into a non-reversible signaling topic.
3. Each process creates one random 20-character signaling identity shared by
   its Nostr and tracker adapters.
4. The initiator creates one non-trickle SDP offer per adapter. Full SDP is used
   because WebTorrent trackers carry offers and answers rather than arbitrary
   candidate messages.
5. The first answer that opens `p2p-netcat-v2` starts a 32-byte challenge.
6. The server signs a domain-separated payload with its persistent libp2p
   Ed25519 key. The client reconstructs the PeerId and verifies that it is
   exactly the requested PeerId.
7. Only after successful verification does the client send `AUTH_READY`.
   Therefore an unverified candidate cannot start a PTY or application stream
   on the listener.
8. The first authenticated adapter wins. Losing Nostr/tracker peer connections
   are closed before application data is exposed.
9. A temporary data-channel loss keeps the same `WebRtcStream` and PTY for up
   to 120 seconds. Reconnection rebinds a new data channel to that stream.

There is no offer glare in this protocol: clients create offers and listeners
only answer them. Each retry has a unique session ID, and tracker/Nostr
duplicates are filtered before reaching the endpoint controller.

## Native wire protocol

Every `RTCDataChannel` message is binary:

```text
+---------+------------+--------------------------+
| version | frame type | payload                  |
+---------+------------+--------------------------+
| 0x02    | 0x00       | application bytes        |
| 0x02    | 0x01       | UTF-8 stream control     |
| 0x02    | 0x02       | authentication challenge |
| 0x02    | 0x03       | public key + signature   |
| 0x02    | 0x04       | authentication accepted  |
+---------+------------+--------------------------+
```

The stream control payload supports `flow:1`, `ack:<bytes>`, `resume`,
`ping`/`pong`, `eof`, and `abort`. `RTCDataChannel.bufferedAmount` provides the
first backpressure boundary; `WebRtcStream` adds a 256 KiB end-to-end window so
a fast PTY cannot grow browser memory without bound.

## Signaling adapters

### Nostr

The adapter opens several public relay WebSockets, creates an ephemeral Schnorr
key, and publishes signed kind `25050` events. Events contain a versioned room
tag, have a 120-second acceptance window, and are checked for canonical event
ID and signature before their SDP is accepted. The server PeerId is still
authenticated inside WebRTC; the ephemeral Nostr key authenticates only the
integrity of a signaling event.

### WebTorrent trackers

The adapter derives a deterministic 20-byte tracker `info_hash`, maintains a
bounded offer pool, routes answers with `offer_id` and `to_peer_id`, announces
periodically, deduplicates tracker replies, and reconnects with exponential
backoff. User traffic never passes through a tracker.

## Public core API

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

The same exports are available from the standalone `p2p-netcat-core` package.
The signaling functions accept injected `WebSocket` and
`RTCPeerConnection` constructors, which makes them browser-safe and testable
without Node.js globals.

## Compatibility phase

CLI listeners currently open native adapters and legacy Trystero rooms. Clients
try native signaling immediately and start Trystero only if no native channel
has won after four seconds. A shared client-session identity lets a new listener
reject duplicate native/legacy channels from the same new client.

Trystero dependencies will be removed after this matrix passes sustained tests:

- browser to Linux CLI and macOS CLI to Linux CLI across countries;
- Chrome, Firefox, and Safari;
- common, symmetric, and restrictive NAT;
- background tabs and sleep/wake;
- high-volume PTY output for several hours;
- repeated network loss and recovery inside the 120-second window;
- old published client to new listener and new client to old listener.

STUN discovers NAT mappings but is not a relay. Symmetric NAT or blocked UDP
can still require TURN or a configured libp2p Circuit Relay. Public relays and
trackers are third-party infrastructure: they can observe signaling topics,
timing, and SDP/ICE candidates, but not application bytes in the encrypted
peer-to-peer channel. They cannot provide a 100% availability guarantee.
