# WebRTC migration away from Trystero

**English** | [Русский](WEBRTC_MIGRATION.RU.md)

The goal is to remove the `@trystero-p2p/torrent` and
`@trystero-p2p/nostr` runtime dependencies while preserving direct WebRTC
connections between the CLI and browser, transparent discovery over public
infrastructure, and recovery of long-lived PTY sessions.

Removing the dependency does not remove the need for external signaling nodes.
Two computers behind NAT cannot exchange SDP and ICE candidates from a PeerId
alone without a rendezvous channel. p2p-netcat will continue to use public
WebTorrent trackers and Nostr relays transparently, while owning the client
protocol and WebRTC state machine.

## Already moved into core

`p2p-netcat-core` now owns:

- the stable room ID derived from PeerId and logical port;
- the signed PeerId challenge/response;
- the shared STUN server list;
- the binary `WebRtcStream`;
- the 256 KiB backpressure window and `ack:<bytes>`;
- `ping`/`pong`, EOF, and abort;
- the 120-second recovery window;
- the `pnc-data-v1` and `pnc-ctl-v1` namespaces;
- `createWebRtcActionHub()`, which connects an action room to streams.

The new public API names are independent of the signaling implementation:

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

The old `TrysteroStream`, `trysteroRoomId()`, and other Trystero-prefixed
exports remain as aliases during the transition. Existing library users can
upgrade without an immediate breaking change.

## What Trystero still does

After the first migration stage, Trystero retains only four responsibilities:

1. opening WebSockets to public WebTorrent/Nostr signaling nodes;
2. publishing and receiving SDP offers, answers, and ICE candidates;
3. managing `RTCPeerConnection` and `RTCDataChannel`;
4. preserving the wire format used by already published CLI/web versions.

User data transfer, flow control, EOF, keepalive, session recovery, and PeerId
authentication no longer need to depend on these responsibilities.

## Next stages

### 1. Native signaling interface

Core will expose one transport-independent contract:

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

An adapter cannot access PTY state or user traffic. It only carries short-lived
signaling messages.

### 2. Native WebRTC session controller

The controller creates `RTCPeerConnection`, handles glare with the perfect
negotiation pattern, orders trickle ICE candidates, opens one reliable ordered
`RTCDataChannel`, and connects it to `WebRtcStream`.

Node.js will continue to supply the WebRTC runtime through `@roamhq/wrtc`; the
browser uses its native `RTCPeerConnection`.

### 3. WebTorrent tracker adapter

The adapter implements WebSocket tracker announce:

- a SHA-1 info hash from a versioned room namespace;
- an offer pool and unique `offer_id` values;
- addressed answers;
- bounded periodic re-announcement;
- deduplication across several trackers;
- reconnect with exponential backoff.

This is the required path for the static GitHub Pages PWA.

### 4. Nostr adapter

Nostr remains an independent parallel rendezvous path:

- an ephemeral Schnorr identity;
- signed NIP-01 events;
- a versioned room tag;
- short-lived signaling events;
- event-ID deduplication;
- simultaneous connections to several relays.

### 5. Dual stack and dependency removal

During migration, the native implementation and current Trystero adapter will
run in parallel. The first authenticated channel wins and the others close.
The dependency is removed from `package.json` and the web bundle only after
soak testing.

Before removal, the matrix covers:

- browser ↔ Linux CLI and macOS CLI ↔ Linux CLI;
- different countries and NAT types;
- Chrome, Firefox, and Safari;
- background tabs and sleep/wake;
- sustained high-volume PTY output;
- temporary network loss for up to 120 seconds;
- clean EOF/abort without orphaned processes;
- no duplicate sessions when Nostr and tracker discovery succeed together.

## Why this is not a one-commit replacement

WebRTC signaling is sensitive to ICE races, repeated offers, WebSocket
reconnection, and browser-specific behavior. Replacing a working
implementation without a dual-stack period conflicts with p2p-netcat's primary
stability requirement. Staging the migration allows the new transport to be
compared on real networks and lets only the signaling adapter be rolled back
without sacrificing the PTY session.
