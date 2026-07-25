"use client";

import { publicKeyFromProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { defaultRelayUrls, joinRoom, type Room } from "@trystero-p2p/torrent";
import {
  WEBRTC_APP_ID,
  WEBRTC_RECONNECT_GRACE_MS,
  WebRtcStream,
  createWebRtcActionHub,
  decodeWebRtcAuthResponse,
  defaultRtcConfiguration,
  webRtcAuthPayload,
  webRtcRoomId,
} from "p2p-netcat-core";
import type { ClientEvents } from "./p2p-client";

function bytes(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("WebRTC signaling вернул данные неизвестного типа");
}

export class BrowserWebRtcClient {
  private readonly events: ClientEvents;
  private room: Room | null = null;
  private hub: ReturnType<typeof createWebRtcActionHub> | null = null;
  private stream: WebRtcStream | null = null;
  private receiveTask: Promise<void> | null = null;
  private connectTimer: number | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private remoteId: string | null = null;
  private removePeerStateListeners: (() => void) | null = null;
  private stopped = false;

  constructor(events: ClientEvents) {
    this.events = events;
  }

  async connect(targetPeerId: string, logicalPort: number, timeoutMs = 30_000) {
    if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC не поддерживается этим браузером");
    const roomId = webRtcRoomId(targetPeerId, logicalPort);

    const room = joinRoom({
      appId: WEBRTC_APP_ID,
      trickleIce: true,
      rtcConfig: defaultRtcConfiguration(),
      relayConfig: {
        urls: [...defaultRelayUrls],
        warnOnRelayFailure: false,
      },
    }, roomId, {
      handshakeTimeoutMs: 12_000,
      onPeerHandshake: async (remoteId, send, receive) => {
        this.events.onLog(`WebRTC: найден кандидат ${remoteId}, проверяем PeerId`);
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        await send(challenge);
        const response = decodeWebRtcAuthResponse(bytes((await receive()).data));
        const publicKey = publicKeyFromProtobuf(response.publicKey);
        const authenticatedPeerId = peerIdFromPublicKey(publicKey).toString();
        if (authenticatedPeerId !== targetPeerId) throw new Error(`WebRTC peer предъявил другой PeerId: ${authenticatedPeerId}`);
        const valid = await publicKey.verify(webRtcAuthPayload(targetPeerId, logicalPort, challenge), response.signature);
        if (!valid) throw new Error("Некорректная подпись WebRTC PeerId");
        this.events.onLog(`WebRTC: PeerId ${targetPeerId} подтверждён`, "success");
      },
      onJoinError: ({ error }) => this.events.onLog(`WebRTC handshake отклонён: ${error}`),
    });
    this.room = room;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      this.rejectConnect = reject;
      this.connectTimer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        void this.hub?.close();
        reject(new Error(`WebRTC не нашёл ${targetPeerId}:${logicalPort} за ${Math.ceil(timeoutMs / 1000)} с`));
      }, timeoutMs);

      this.hub = createWebRtcActionHub(room, {
        leaveAfterStream: true,
        reconnectGraceMs: WEBRTC_RECONNECT_GRACE_MS,
        onPeerDisconnected: (remoteId) => {
          if (remoteId !== this.remoteId || this.stream?.status === "closed") return;
          this.removePeerStateListeners?.();
          this.removePeerStateListeners = null;
          this.events.onLog(
            `WebRTC-канал временно потерян; сохраняем PTY и ждём переподключение до ${WEBRTC_RECONNECT_GRACE_MS / 1000} с`,
          );
          this.events.onReconnecting();
        },
        onPeerReconnected: (remoteId) => {
          if (remoteId !== this.remoteId) return;
          this.watchPeerConnection(room, remoteId);
          this.events.onLog("WebRTC-канал восстановлен; продолжаем прежнюю сессию", "success");
          this.events.onReconnected();
        },
        onStream: (stream, remoteId) => {
          if (this.stopped || settled) {
            stream.abort(new Error("WebRTC-подключение уже завершено"));
            return;
          }
          settled = true;
          if (this.connectTimer != null) window.clearTimeout(this.connectTimer);
          this.connectTimer = null;
          this.rejectConnect = null;
          this.remoteId = remoteId;
          this.stream = stream;
          this.watchPeerConnection(room, remoteId);
          this.receiveTask = this.receiveLoop(stream);
          resolve();
        },
      });
    });
  }

  async send(chunk: Uint8Array) {
    if (this.stream == null) throw new Error("WebRTC-канал не открыт");
    this.stream.send(chunk);
    await this.stream.onDrain();
  }

  async closeWrite() {
    await this.stream?.close();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.connectTimer != null) window.clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.rejectConnect?.(new Error("WebRTC-подключение отменено"));
    this.rejectConnect = null;
    this.removePeerStateListeners?.();
    this.removePeerStateListeners = null;
    if (this.stream?.status !== "closed") this.stream?.abort(new Error("WebRTC-соединение закрыто пользователем"));
    await this.receiveTask?.catch(() => {});
    await this.hub?.close().catch(() => {});
    this.hub = null;
    this.room = null;
    this.stream = null;
    this.remoteId = null;
  }

  private async receiveLoop(stream: WebRtcStream) {
    try {
      for await (const chunk of stream) await this.events.onData(chunk);
    } catch (error) {
      if (!this.stopped) this.events.onLog(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (!this.stopped && stream.writeStatus === "writable") {
        await stream.close().catch(() => {});
      }
      if (!this.stopped) this.events.onClosed();
    }
  }

  private watchPeerConnection(room: Room, remoteId: string) {
    this.removePeerStateListeners?.();
    const connection = room.getPeers()[remoteId];
    if (connection == null) return;

    let previous = "";
    const reportState = () => {
      const state = `connection=${connection.connectionState}, ICE=${connection.iceConnectionState}`;
      if (state === previous) return;
      previous = state;
      this.events.onLog(`WebRTC state: ${state}`);
    };
    connection.addEventListener("connectionstatechange", reportState);
    connection.addEventListener("iceconnectionstatechange", reportState);
    this.removePeerStateListeners = () => {
      connection.removeEventListener("connectionstatechange", reportState);
      connection.removeEventListener("iceconnectionstatechange", reportState);
    };
    reportState();
  }
}
