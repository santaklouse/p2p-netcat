"use client";

import { publicKeyFromProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { defaultRelayUrls, joinRoom, type Room } from "@trystero-p2p/torrent";
import {
  TRYSTERO_APP_ID,
  TRYSTERO_RECONNECT_GRACE_MS,
  TrysteroStream,
  decodeTrysteroAuthResponse,
  defaultRtcConfiguration,
  trysteroAuthPayload,
  trysteroRoomId,
} from "p2p-netcat-core";
import type { ClientEvents } from "./p2p-client";

const DATA_ACTION = "pnc-data-v1";
const CONTROL_ACTION = "pnc-ctl-v1";

function bytes(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("Trystero вернул данные неизвестного типа");
}

export class BrowserTrysteroClient {
  private readonly events: ClientEvents;
  private room: Room | null = null;
  private stream: TrysteroStream | null = null;
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
    const roomId = trysteroRoomId(targetPeerId, logicalPort);

    const room = joinRoom({
      appId: TRYSTERO_APP_ID,
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
        const response = decodeTrysteroAuthResponse(bytes((await receive()).data));
        const publicKey = publicKeyFromProtobuf(response.publicKey);
        const authenticatedPeerId = peerIdFromPublicKey(publicKey).toString();
        if (authenticatedPeerId !== targetPeerId) throw new Error(`WebRTC peer предъявил другой PeerId: ${authenticatedPeerId}`);
        const valid = await publicKey.verify(trysteroAuthPayload(targetPeerId, logicalPort, challenge), response.signature);
        if (!valid) throw new Error("Некорректная подпись WebRTC PeerId");
        this.events.onLog(`WebRTC: PeerId ${targetPeerId} подтверждён`, "success");
      },
      onJoinError: ({ error }) => this.events.onLog(`Trystero handshake отклонён: ${error}`),
    });
    this.room = room;
    const data = room.makeAction<ArrayBufferView>(DATA_ACTION);
    const control = room.makeAction<string>(CONTROL_ACTION);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      this.rejectConnect = reject;
      this.connectTimer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Trystero/WebRTC не нашёл ${targetPeerId}:${logicalPort} за ${Math.ceil(timeoutMs / 1000)} с`));
      }, timeoutMs);

      room.onPeerJoin = (remoteId) => {
        if (this.stopped) return;
        if (settled) {
          if (
            remoteId === this.remoteId
            && this.stream?.connectionStatus === "reconnecting"
            && this.stream.peerReconnected()
          ) {
            this.watchPeerConnection(room, remoteId);
            this.events.onLog("WebRTC-канал восстановлен; продолжаем прежнюю сессию", "success");
            this.events.onReconnected();
          }
          return;
        }
        settled = true;
        if (this.connectTimer != null) window.clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.rejectConnect = null;
        this.remoteId = remoteId;
        const stream = new TrysteroStream({
          sendData: (chunk) => data.send(chunk, { target: remoteId }),
          sendControl: (value) => control.send(value, { target: remoteId }),
          onFinalize: () => void room.leave(),
        });
        this.stream = stream;
        data.onMessage = (chunk, context) => {
          if (context.peerId === remoteId) stream.receiveData(bytes(chunk));
        };
        control.onMessage = (value, context) => {
          if (context.peerId === remoteId) stream.receiveControl(String(value));
        };
        room.onPeerLeave = (peerId) => {
          if (peerId !== remoteId || stream.status === "closed") return;
          stream.peerDisconnected(TRYSTERO_RECONNECT_GRACE_MS);
          this.removePeerStateListeners?.();
          this.removePeerStateListeners = null;
          this.events.onLog(
            `WebRTC-канал временно потерян; сохраняем PTY и ждём переподключение до ${TRYSTERO_RECONNECT_GRACE_MS / 1000} с`,
          );
          this.events.onReconnecting();
        };
        this.watchPeerConnection(room, remoteId);
        this.receiveTask = this.receiveLoop(stream);
        resolve();
      };
    });
  }

  async send(chunk: Uint8Array) {
    if (this.stream == null) throw new Error("Trystero/WebRTC-канал не открыт");
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
    this.rejectConnect?.(new Error("Trystero/WebRTC-подключение отменено"));
    this.rejectConnect = null;
    this.removePeerStateListeners?.();
    this.removePeerStateListeners = null;
    if (this.stream?.status !== "closed") this.stream?.abort(new Error("WebRTC-соединение закрыто пользователем"));
    await this.receiveTask?.catch(() => {});
    await this.room?.leave().catch(() => {});
    this.room = null;
    this.stream = null;
    this.remoteId = null;
  }

  private async receiveLoop(stream: TrysteroStream) {
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
