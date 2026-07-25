import type { Multiaddr } from "@multiformats/multiaddr";

export const APP_NAME: "p2p-netcat";
export const PROTOCOL_PREFIX: "/p2p-netcat/1.0.0";
export const DEFAULT_SERVICE: 31337;
export const TRYSTERO_APP_ID: "io.github.santaklouse.p2p-netcat.v1";
export const TRYSTERO_AUTH_VERSION: 1;
export const PUBSUB_DISCOVERY_TOPIC: "io.github.santaklouse.p2p-netcat.peer-discovery.v1";
export const PUBSUB_DISCOVERY_INTERVAL_MS: 10000;
export const TRYSTERO_RECONNECT_GRACE_MS: 120000;
export const PTY_FRAME_DATA: 0;
export const PTY_FRAME_RESIZE: 1;
export const PTY_FRAME_HEADER_LENGTH: 5;
export const PTY_MAX_FRAME_LENGTH: 1048576;
export const DEFAULT_STUN_URLS: readonly string[];

export type P2PNetcatRtcConfiguration = {
  iceServers: Array<{ urls: string[] }>;
};

export function defaultRtcConfiguration(): P2PNetcatRtcConfiguration;

export type RelayValidationOptions = {
  requireWebSocket?: boolean;
  secureContext?: boolean;
};

export type RelayDialPlan = Readonly<{
  peerId: string;
  service: number;
  protocol: string;
  relay: string;
  destination: string;
}>;

export type AddressLike = string | { toString(): string } | { multiaddr: { toString(): string } };

export function validateService(value?: unknown): number;
export function protocolForService(service: unknown): string;
export function encodePtyData(value: ArrayBuffer | ArrayBufferView): Uint8Array;
export function encodePtyResize(columns: unknown, rows: unknown): Uint8Array;
export function decodePtyResize(value: ArrayBuffer | ArrayBufferView): Readonly<{ columns: number; rows: number }>;

export type PtyFrame = Readonly<{ type: number; data: Uint8Array }>;

export class PtyFrameDecoder {
  push(value: ArrayBuffer | ArrayBufferView): PtyFrame[];
  finish(): void;
  reset(): void;
}
export function normalizePeerId(value: unknown): string;
export function normalizeMultiaddr(value: unknown): string;
export function isWebSocketAddress(value: unknown): boolean;
export function isSecureWebSocketAddress(value: unknown): boolean;
export function normalizeRelayAddress(value: unknown, options?: RelayValidationOptions): string;
export function relayedTargetAddress(relay: unknown, peerId: unknown, options?: RelayValidationOptions): Multiaddr;
export function createRelayDialPlan(input: {
  peerId: unknown;
  service?: unknown;
  relay: unknown;
  requireWebSocket?: boolean;
  secureContext?: boolean;
}): RelayDialPlan;
export function addressRank(address: AddressLike): number;
export function preferDialAddresses(a: AddressLike, b: AddressLike): number;
export function browserDialableAddress(address: AddressLike, options?: { secureContext?: boolean }): boolean;
export function trysteroRoomId(peerId: unknown, service?: unknown): string;
export function trysteroAuthPayload(peerId: unknown, service: unknown, challenge: ArrayBuffer | ArrayBufferView): Uint8Array;
export function encodeTrysteroAuthResponse(publicKey: ArrayBuffer | ArrayBufferView, signature: ArrayBuffer | ArrayBufferView): Uint8Array;
export function decodeTrysteroAuthResponse(value: ArrayBuffer | ArrayBufferView): Readonly<{ publicKey: Uint8Array; signature: Uint8Array }>;

export class TrysteroStream implements AsyncIterable<Uint8Array> {
  status: "open" | "closed";
  writeStatus: "writable" | "closing" | "closed";
  connectionStatus: "connected" | "reconnecting" | "disconnected";
  constructor(options: {
    sendData: (bytes: Uint8Array) => void | Promise<void>;
    sendControl: (control: string) => void | Promise<void>;
    onFinalize?: () => void;
    flowWindowBytes?: number;
    keepAliveIntervalMs?: number;
  });
  send(chunk: ArrayBuffer | ArrayBufferView): boolean;
  onDrain(): Promise<void>;
  close(): Promise<void>;
  abort(error?: Error): void;
  receiveData(chunk: ArrayBuffer | ArrayBufferView): void;
  receiveControl(control: string): void;
  peerDisconnected(graceMs?: number): void;
  peerReconnected(): boolean;
  peerLeft(): void;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}
