"use client";

import {
  PTY_FRAME_DATA,
  PtyFrameDecoder,
  encodePtyData,
  encodePtyResize,
} from "p2p-netcat-core";
import { BrowserWebRtcClient } from "./webrtc-client";

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

  async start() {
    return this.request<string>("start");
  }

  async connect(targetPeerId: string, logicalPort: number, relayAddress: string, timeout: number) {
    await this.request("connect", { targetPeerId, logicalPort, relayAddress, timeout });
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
  private webRtc: BrowserWebRtcClient | null = null;
  private active: "worker" | "webrtc" | null = null;
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

  start() {
    return this.worker.start();
  }

  async connect(targetPeerId: string, logicalPort: number, relayAddress: string, interactive = false, timeout: number) {
    this.interactive = interactive;
    this.ptyDecoder.reset();
    if (relayAddress.trim()) {
      await this.worker.connect(targetPeerId, logicalPort, relayAddress, timeout);
      this.active = "worker";
      this.events.onLog("Выбран указанный libp2p relay", "success");
      return;
    }

    const webRtc = new BrowserWebRtcClient(this.transportEvents);
    this.webRtc = webRtc;
    try {
      const winner = await Promise.any([
        this.worker.connect(targetPeerId, logicalPort, "", timeout).then(() => "worker" as const),
        webRtc.connect(targetPeerId, logicalPort, timeout * 1000).then(() => "webrtc" as const),
      ]);
      this.active = winner;
      if (winner === "worker") {
        await webRtc.stop();
        this.webRtc = null;
        this.events.onLog("Выбран libp2p IPFS-маршрут", "success");
      } else {
        this.worker.cancel();
        this.events.onLog("Выбран прямой WebRTC-канал", "success");
      }
    } catch (error) {
      await webRtc.stop();
      this.webRtc = null;
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
    if (this.active === "webrtc") return this.webRtc!.closeWrite();
    return this.worker.closeWrite();
  }

  async resize(columns: number, rows: number) {
    if (!this.interactive || this.active == null) return;
    await this.sendTransport(encodePtyResize(columns, rows));
  }

  async stop() {
    await Promise.allSettled([this.worker.stop(), this.webRtc?.stop() ?? Promise.resolve()]);
    this.active = null;
    this.webRtc = null;
  }

  private async sendTransport(bytes: Uint8Array) {
    if (this.active === "webrtc") return this.webRtc!.send(bytes);
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
