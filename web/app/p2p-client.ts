"use client";

import {
  PTY_FRAME_DATA,
  PtyFrameDecoder,
  assertPairingTokenUsable,
  createSignalingPeerId,
  encodePtyData,
  encodePtyResize,
} from "p2p-netcat-core";
import { BrowserNativeWebRtcClient } from "./native-webrtc-client";
import { BrowserWebRtcClient as BrowserLegacyWebRtcClient } from "./webrtc-client";

const LEGACY_WEBRTC_FALLBACK_DELAY_MS = 4_000;

export type ClientEvents = {
  onData: (bytes: Uint8Array) => void | Promise<void>;
  onLog: (message: string, kind?: "info" | "success" | "error") => void;
  onClosed: () => void;
  onReconnecting: () => void;
  onReconnected: () => void;
};

type WorkerRequest = {
  id: number;
  action: "start" | "connect" | "send" | "ackData" | "closeWrite" | "stop";
  payload?: Record<string, unknown>;
};

type WorkerResponse =
  | { type: "result"; id: number; value?: unknown }
  | { type: "error"; id: number; message: string }
  | { type: "data"; bytes: ArrayBuffer }
  | { type: "log"; message: string; kind: "info" | "success" | "error" }
  | { type: "closed" };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

class WorkerP2PClient {
  private readonly worker: Worker;
  private readonly events: ClientEvents;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private stopped = false;
  private outputChain = Promise.resolve();

  constructor(events: ClientEvents) {
    this.events = events;
    this.worker = new Worker(new URL("./p2p.worker.ts", import.meta.url), {
      type: "module",
      name: "p2p-netcat-network",
    });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data));
    this.worker.addEventListener("error", (event) => {
      this.events.onLog(event.message || "Ошибка сетевого Web Worker", "error");
    });
  }

  async start(pairingToken = "") {
    return this.request<string>("start", { privateDiscovery: pairingToken.trim().length > 0 });
  }

  async connect(
    targetPeerId: string,
    logicalPort: number,
    relayAddress: string,
    timeout: number,
    pairingToken: string,
  ) {
    await this.request("connect", { targetPeerId, logicalPort, relayAddress, timeout, pairingToken });
  }

  async send(bytes: Uint8Array) {
    const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice();
    await this.request("send", { bytes: transferable.buffer }, [transferable.buffer]);
  }

  async sendText(text: string) {
    await this.send(new TextEncoder().encode(text));
  }

  async sendFile(file: File, onProgress: (sent: number, total: number) => void) {
    const reader = file.stream().getReader();
    let sent = 0;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await this.send(value);
      sent += value.byteLength;
      onProgress(sent, file.size);
    }
  }

  async closeWrite() {
    await this.request("closeWrite");
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.request("stop");
    } finally {
      this.worker.terminate();
      for (const request of this.pending.values()) request.reject(new Error("Web Worker остановлен"));
      this.pending.clear();
    }
  }

  cancel() {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(new Error("Web Worker остановлен"));
    this.pending.clear();
  }

  private request<T = void>(action: WorkerRequest["action"], payload?: Record<string, unknown>, transfer: Transferable[] = []) {
    if (this.stopped && action !== "stop") return Promise.reject(new Error("Клиент уже остановлен"));
    const id = ++this.requestId;
    const message: WorkerRequest = { id, action, payload };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage(message, transfer);
    });
  }

  private onMessage(message: WorkerResponse) {
    if (message.type === "result" || message.type === "error") {
      const request = this.pending.get(message.id);
      if (request == null) return;
      this.pending.delete(message.id);
      if (message.type === "error") request.reject(new Error(message.message));
      else request.resolve(message.value);
      return;
    }

    if (message.type === "data") {
      const bytes = new Uint8Array(message.bytes);
      this.outputChain = this.outputChain
        .then(() => this.events.onData(bytes))
        .catch((error) => {
          this.events.onLog(error instanceof Error ? error.message : String(error), "error");
        })
        .finally(() => {
          if (!this.stopped) {
            const acknowledgement: WorkerRequest = {
              id: 0,
              action: "ackData",
              payload: { bytes: bytes.byteLength },
            };
            this.worker.postMessage(acknowledgement);
          }
        });
    } else if (message.type === "log") {
      this.events.onLog(message.message, message.kind);
    } else if (message.type === "closed") {
      this.outputChain = this.outputChain.then(() => this.events.onClosed());
    }
  }
}

export class BrowserP2PClient {
  private readonly events: ClientEvents;
  private readonly transportEvents: ClientEvents;
  private readonly worker: WorkerP2PClient;
  private nativeWebRtc: BrowserNativeWebRtcClient | null = null;
  private legacyWebRtc: BrowserLegacyWebRtcClient | null = null;
  private active: "worker" | "native-webrtc" | "legacy-webrtc" | null = null;
  private interactive = false;
  private readonly ptyDecoder = new PtyFrameDecoder();

  constructor(events: ClientEvents) {
    this.events = events;
    this.transportEvents = {
      onData: (bytes) => this.receive(bytes),
      onLog: events.onLog,
      onReconnecting: events.onReconnecting,
      onReconnected: events.onReconnected,
      onClosed: () => {
        if (this.interactive) {
          try {
            this.ptyDecoder.finish();
          } catch (error) {
            this.events.onLog(error instanceof Error ? error.message : String(error), "error");
          }
        }
        events.onClosed();
      },
    };
    this.worker = new WorkerP2PClient(this.transportEvents);
  }

  start(pairingToken = "") {
    return this.worker.start(pairingToken);
  }

  async connect(
    targetPeerId: string,
    logicalPort: number,
    relayAddress: string,
    interactive = false,
    timeout: number,
    pairingTokenValue = "",
    nativeOnly = false,
  ) {
    this.interactive = interactive;
    this.ptyDecoder.reset();
    const pairingToken = pairingTokenValue.trim();
    if (pairingToken.length > 0) {
      assertPairingTokenUsable(pairingToken, {
        peerId: targetPeerId,
        service: logicalPort,
      });
      this.events.onLog("Приватный pairing-token режим включён");
    }
    if (relayAddress.trim()) {
      await this.worker.connect(targetPeerId, logicalPort, relayAddress, timeout, pairingToken);
      this.active = "worker";
      this.events.onLog("Выбран указанный libp2p relay", "success");
      return;
    }

    const nativeWebRtc = new BrowserNativeWebRtcClient(this.transportEvents);
    const legacyWebRtc = pairingToken.length === 0 && !nativeOnly
      ? new BrowserLegacyWebRtcClient(this.transportEvents)
      : null;
    const signalingPeerId = createSignalingPeerId();
    this.nativeWebRtc = nativeWebRtc;
    this.legacyWebRtc = legacyWebRtc;
    let legacyTimer: number | null = null;
    let rejectDelayedLegacy: ((error: Error) => void) | null = null;
    const fallbackDelayMs = Math.min(
      LEGACY_WEBRTC_FALLBACK_DELAY_MS,
      Math.max(500, Math.floor(timeout * 250)),
    );
    const legacyPromise = legacyWebRtc == null
      ? null
      : new Promise<"legacy-webrtc">((resolve, reject) => {
          rejectDelayedLegacy = reject;
          legacyTimer = window.setTimeout(() => {
            legacyTimer = null;
            this.events.onLog("WebRTC: собственный signaling пока не нашёл пир; запускаем Trystero fallback");
            void legacyWebRtc
              .connect(
                targetPeerId,
                logicalPort,
                Math.max(1_000, timeout * 1000 - fallbackDelayMs),
                signalingPeerId,
              )
              .then(() => resolve("legacy-webrtc"), reject);
          }, fallbackDelayMs);
        });
    legacyPromise?.catch(() => {});
    if (pairingToken.length > 0) {
      this.events.onLog("WebRTC: pairing token отключает публичный Trystero fallback");
    } else if (nativeOnly) {
      this.events.onLog("WebRTC native-only: Trystero fallback отключён");
    }
    const cancelDelayedLegacy = () => {
      if (legacyTimer == null) return;
      window.clearTimeout(legacyTimer);
      legacyTimer = null;
      rejectDelayedLegacy?.(new Error("Trystero fallback отменён"));
    };

    try {
      const winner = await Promise.any([
        this.worker.connect(targetPeerId, logicalPort, "", timeout, pairingToken).then(() => "worker" as const),
        nativeWebRtc
          .connect(targetPeerId, logicalPort, timeout * 1000, signalingPeerId, pairingToken)
          .then(() => "native-webrtc" as const),
        ...(legacyPromise == null ? [] : [legacyPromise]),
      ]);
      this.active = winner;
      if (winner === "worker") {
        cancelDelayedLegacy();
        await Promise.allSettled([nativeWebRtc.stop(), legacyWebRtc?.stop() ?? Promise.resolve()]);
        this.nativeWebRtc = null;
        this.legacyWebRtc = null;
        this.events.onLog("Выбран libp2p IPFS-маршрут", "success");
      } else if (winner === "native-webrtc") {
        cancelDelayedLegacy();
        this.worker.cancel();
        await legacyWebRtc?.stop();
        this.legacyWebRtc = null;
        this.events.onLog("Выбран собственный прямой WebRTC-канал", "success");
      } else {
        this.worker.cancel();
        await nativeWebRtc.stop();
        this.nativeWebRtc = null;
        this.events.onLog("Выбран WebRTC через Trystero fallback", "success");
      }
    } catch (error) {
      cancelDelayedLegacy();
      await Promise.allSettled([nativeWebRtc.stop(), legacyWebRtc?.stop() ?? Promise.resolve()]);
      this.nativeWebRtc = null;
      this.legacyWebRtc = null;
      const reasons = error instanceof AggregateError
        ? error.errors.map((item) => item instanceof Error ? item.message : String(item)).join("; ")
        : error instanceof Error ? error.message : String(error);
      throw new Error(`Ни один транспорт не установил соединение: ${reasons}`, { cause: error });
    }
  }

  async send(bytes: Uint8Array) {
    const payload = this.interactive ? encodePtyData(bytes) : bytes;
    return this.sendTransport(payload);
  }

  async sendText(text: string) {
    await this.send(new TextEncoder().encode(text));
  }

  async sendFile(file: File, onProgress: (sent: number, total: number) => void) {
    const reader = file.stream().getReader();
    let sent = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await this.send(value);
      sent += value.byteLength;
      onProgress(sent, file.size);
    }
  }

  async closeWrite() {
    if (this.active === "native-webrtc") return this.nativeWebRtc!.closeWrite();
    if (this.active === "legacy-webrtc") return this.legacyWebRtc!.closeWrite();
    return this.worker.closeWrite();
  }

  async resize(columns: number, rows: number) {
    if (!this.interactive || this.active == null) return;
    await this.sendTransport(encodePtyResize(columns, rows));
  }

  async stop() {
    await Promise.allSettled([
      this.worker.stop(),
      this.nativeWebRtc?.stop() ?? Promise.resolve(),
      this.legacyWebRtc?.stop() ?? Promise.resolve(),
    ]);
    this.active = null;
    this.nativeWebRtc = null;
    this.legacyWebRtc = null;
  }

  private async sendTransport(bytes: Uint8Array) {
    if (this.active === "native-webrtc") return this.nativeWebRtc!.send(bytes);
    if (this.active === "legacy-webrtc") return this.legacyWebRtc!.send(bytes);
    if (this.active === "worker") return this.worker.send(bytes);
    throw new Error("P2P-канал ещё не открыт");
  }

  private async receive(bytes: Uint8Array) {
    if (!this.interactive) {
      await this.events.onData(bytes);
      return;
    }

    try {
      for (const frame of this.ptyDecoder.push(bytes)) {
        if (frame.type === PTY_FRAME_DATA) await this.events.onData(frame.data);
      }
    } catch (error) {
      this.events.onLog(`Ошибка PTY-протокола: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}
