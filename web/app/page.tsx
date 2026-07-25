import { FormEvent, Suspense, lazy, useEffect, useRef, useState } from "react";
import type { BrowserTerminalHandle } from "./browser-terminal";
import { BrowserP2PClient } from "./p2p-client";

const BrowserTerminal = lazy(() => import("./browser-terminal"));
const INSTALL_COMMAND = "npm install --global p2p-netcat@latest";
const INSTALLATION_RU_URL = "https://github.com/santaklouse/p2p-netcat/blob/main/docs/INSTALLATION.RU.md";
const INSTALLATION_EN_URL = "https://github.com/santaklouse/p2p-netcat/blob/main/docs/INSTALLATION.md";

type ConnectionState = "idle" | "starting" | "connecting" | "connected" | "reconnecting" | "closed" | "error";
type LogEntry = { id: number; time: string; message: string; kind: "info" | "success" | "error" };
type TerminalEntry = { id: number; direction: "sent" | "received"; text: string };

const stateLabels: Record<ConnectionState, string> = {
  idle: "Готов",
  starting: "Запуск узла",
  connecting: "Соединение",
  connected: "В сети",
  reconnecting: "Переподключение",
  closed: "Закрыто",
  error: "Ошибка",
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

export default function Home() {
  const [targetPeerId, setTargetPeerId] = useState("");
  const [relayAddress, setRelayAddress] = useState("");
  const [logicalPort, setLogicalPort] = useState(31337);
  const [timeout, setTimeout] = useState(30);
  const [interactive, setInteractive] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [localPeerId, setLocalPeerId] = useState("");
  const [message, setMessage] = useState("");
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [showSentText, setShowSentText] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [sentBytes, setSentBytes] = useState(0);
  const [fileProgress, setFileProgress] = useState("");
  const [installCopied, setInstallCopied] = useState(false);
  const clientRef = useRef<BrowserP2PClient | null>(null);
  const receivedChunks = useRef<ArrayBuffer[]>([]);
  const decoder = useRef(new TextDecoder());
  const transcriptRef = useRef<HTMLPreElement | null>(null);
  const browserTerminalRef = useRef<BrowserTerminalHandle | null>(null);
  const terminalSequence = useRef(0);

  const addLog = (text: string, kind: "info" | "success" | "error" = "info") => {
    setLogs((current) => [
      ...current.slice(-99),
      { id: Date.now() + Math.random(), time: new Date().toLocaleTimeString("ru-RU"), message: text, kind },
    ]);
  };

  useEffect(() => {
    const savedRelay = window.localStorage.getItem("p2p-netcat-relay");
    if (savedRelay) setRelayAddress(savedRelay);
    setShowSentText(window.localStorage.getItem("p2p-netcat-show-sent") === "true");
    setInteractive(window.localStorage.getItem("p2p-netcat-interactive") === "true");
    return () => {
      void clientRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [terminalEntries, showSentText]);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (connectionState === "connecting" || connectionState === "starting" || connectionState === "reconnecting") return;

    await clientRef.current?.stop();
    clientRef.current = null;
    setConnectionState("starting");
    setTerminalEntries([]);
    setReceivedBytes(0);
    setSentBytes(0);
    receivedChunks.current = [];
    decoder.current = new TextDecoder();
    terminalSequence.current = 0;
    browserTerminalRef.current?.clear();

    const client = new BrowserP2PClient({
      onData: async (bytes) => {
        setReceivedBytes((value) => value + bytes.byteLength);
        if (interactive) {
          await browserTerminalRef.current?.write(bytes);
          return;
        }
        receivedChunks.current.push(bytes.slice().buffer as ArrayBuffer);
        const text = decoder.current.decode(bytes, { stream: true });
        if (text) {
          setTerminalEntries((current) => [
            ...current,
            { id: ++terminalSequence.current, direction: "received", text },
          ]);
        }
      },
      onLog: addLog,
      onReconnecting: () => setConnectionState("reconnecting"),
      onReconnected: () => setConnectionState("connected"),
      onClosed: () => setConnectionState((state) => state === "error" ? state : "closed"),
    });
    clientRef.current = client;

    try {
      setLocalPeerId(await client.start());
      setConnectionState("connecting");
      if (relayAddress.trim()) window.localStorage.setItem("p2p-netcat-relay", relayAddress.trim());
      else window.localStorage.removeItem("p2p-netcat-relay");
      window.localStorage.setItem("p2p-netcat-interactive", String(interactive));
      await client.connect(targetPeerId, logicalPort, relayAddress, interactive, timeout);
      setConnectionState("connected");
      if (interactive) addLog("PTY-протокол включён; ввод передаётся напрямую с клавиатуры", "success");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      addLog(text, "error");
      setConnectionState("error");
      await client.stop();
      clientRef.current = null;
    }
  };

  const disconnect = async () => {
    await clientRef.current?.stop();
    clientRef.current = null;
    setConnectionState("closed");
    addLog("Соединение закрыто");
  };

  const exitInteractive = async () => {
    try {
      await clientRef.current?.closeWrite();
      addLog("PTY EOF отправлен; ожидаем завершение удалённой оболочки");
    } catch (error) {
      addLog(error instanceof Error ? error.message : String(error), "error");
      await disconnect();
    }
  };

  const sendMessage = async () => {
    if (!message || connectionState !== "connected") return;
    const payload = `${message}\n`;
    const entryId = ++terminalSequence.current;
    setTerminalEntries((current) => [...current, { id: entryId, direction: "sent", text: payload }]);
    try {
      await clientRef.current?.sendText(payload);
      setSentBytes((value) => value + new TextEncoder().encode(payload).byteLength);
      setMessage("");
    } catch (error) {
      setTerminalEntries((current) => current.filter((entry) => entry.id !== entryId));
      addLog(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const sendTerminalInput = (bytes: Uint8Array) => {
    void clientRef.current?.send(bytes).then(() => {
      setSentBytes((value) => value + bytes.byteLength);
    }).catch((error) => {
      addLog(error instanceof Error ? error.message : String(error), "error");
    });
  };

  const resizeTerminal = (columns: number, rows: number) => {
    void clientRef.current?.resize(columns, rows).catch((error) => {
      addLog(error instanceof Error ? error.message : String(error), "error");
    });
  };

  const sendFile = async (file: File | undefined) => {
    if (!file || connectionState !== "connected") return;
    setFileProgress(`Отправка ${file.name}: 0 / ${formatBytes(file.size)}`);
    try {
      await clientRef.current?.sendFile(file, (sent, total) => {
        setFileProgress(`Отправка ${file.name}: ${formatBytes(sent)} / ${formatBytes(total)}`);
      });
      setSentBytes((value) => value + file.size);
      setFileProgress(`${file.name} отправлен · ${formatBytes(file.size)}`);
      addLog(`Файл ${file.name} отправлен`, "success");
    } catch (error) {
      setFileProgress("");
      addLog(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const downloadReceived = () => {
    const blob = new Blob(receivedChunks.current, { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `p2p-netcat-${new Date().toISOString().replaceAll(":", "-")}.bin`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyInstallCommand = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setInstallCopied(true);
      window.setTimeout(() => setInstallCopied(false), 2_000);
    } catch (error) {
      addLog(
        `Не удалось скопировать команду: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const connected = connectionState === "connected";
  const sessionActive = connected || connectionState === "reconnecting";
  const visibleTerminalEntries = showSentText
    ? terminalEntries
    : terminalEntries.filter((entry) => entry.direction === "received");

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="p2p netcat — начало страницы">
          <span className="brand-mark" aria-hidden="true">p2p</span>
          <span>netcat<span className="brand-cursor">_</span></span>
        </a>
        <div className={`connection-pill state-${connectionState}`}>
          <span className="status-dot" aria-hidden="true" />
          {stateLabels[connectionState]}
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">Зашифрованный поток · без IP-адреса сервера</p>
          <h1>Терминал между двумя узлами.<br /><span>Прямо из браузера.</span></h1>
        </div>
        <p className="hero-copy">
          Введите PeerId — клиент сам найдёт браузерный маршрут через IPFS.
          Circuit Relay можно указать вручную только как резервный маршрут.
        </p>
      </section>

      <section className="install-strip" aria-labelledby="install-title">
        <div className="install-heading">
          <span className="step-number">CLI</span>
          <div>
            <p>Node.js 22+</p>
            <h2 id="install-title">Установить консольную утилиту</h2>
          </div>
        </div>
        <div className="install-command">
          <code>{INSTALL_COMMAND}</code>
          <button type="button" onClick={() => void copyInstallCommand()}>
            {installCopied ? "Скопировано" : "Копировать"}
          </button>
        </div>
        <nav className="install-links" aria-label="Документация по установке">
          <a href={INSTALLATION_RU_URL} target="_blank" rel="noreferrer">
            Инструкция по установке ↗
          </a>
          <a href={INSTALLATION_EN_URL} target="_blank" rel="noreferrer">
            English ↗
          </a>
        </nav>
      </section>

      <section className="workspace" aria-label="P2P-клиент">
        <aside className="connection-panel">
          <div className="panel-heading">
            <span className="step-number">01</span>
            <div><p>Маршрут</p><h2>Новое соединение</h2></div>
          </div>

          <form onSubmit={connect} className="connection-form">
            <label>
              <span>PeerId сервера</span>
              <input
                value={targetPeerId}
                onChange={(event) => setTargetPeerId(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                required
                disabled={sessionActive}
                aria-describedby="peer-help"
              />
              <small id="peer-help">Значение печатает команда <code>p2p-nc -l</code></small>
            </label>

            <details className="relay-options">
              <summary>
                <span>Дополнительный relay</span>
                <small>{relayAddress ? "Маршрут задан вручную" : "Необязательно · используется автопоиск"}</small>
              </summary>
              <label>
                <span>WebSocket relay multiaddr</span>
                <input
                  value={relayAddress}
                  onChange={(event) => setRelayAddress(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={sessionActive}
                  placeholder="Оставьте пустым для автоматического поиска"
                  aria-describedby="relay-help"
                />
                <small id="relay-help">Если автопоиск не сработал: <code>/dns4/relay.example/tcp/443/wss/p2p/…</code></small>
              </label>
            </details>

            <label className="port-field">
              <span>Логический порт</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={logicalPort}
                onChange={(event) => setLogicalPort(Number(event.target.value))}
                required
                disabled={sessionActive}
              />
            </label>

            <label className="timeout-field">
              <span>Таймаут подключения (поиск узла)</span>
              <input
                  type="number"
                  min="5"
                  max="65535"
                  value={timeout}
                  onChange={(event) => setTimeout(Number(event.target.value))}
                  required
                  disabled={sessionActive}
              />
            </label>

            <label className="interactive-mode">
              <input
                type="checkbox"
                checked={interactive}
                onChange={(event) => setInteractive(event.target.checked)}
                disabled={connectionState === "starting" || connectionState === "connecting" || sessionActive}
              />
              <span>
                Интерактивный PTY <code>-i</code>
                <small>Включите, если сервер запущен командой <code>p2p-nc -l -i</code></small>
              </span>
            </label>

            {!sessionActive ? (
              <button className="primary-button" type="submit" disabled={!targetPeerId || connectionState === "starting" || connectionState === "connecting"}>
                <span>Подключиться</span><span aria-hidden="true">↗</span>
              </button>
            ) : (
              <button className="secondary-button danger" type="button" onClick={disconnect}>Отключиться</button>
            )}
          </form>

          <div className="identity-card">
            <span>Браузерный PeerId</span>
            <code>{localPeerId || "Будет создан при подключении"}</code>
          </div>

          <div className="security-note">
            <span className="lock-icon" aria-hidden="true">◆</span>
            <p><strong>Сквозное шифрование</strong>Службы поиска видят запрос PeerId, но содержимое канала защищено Noise.</p>
          </div>
        </aside>

        <div className="terminal-panel">
          <div className="terminal-toolbar">
            <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
            <span className="terminal-address">p2p://{targetPeerId ? `${targetPeerId}` : "not-connected"}:{logicalPort}</span>
            {interactive ? (
              <span className="pty-mode-label">PTY · Ctrl-E Q — выход</span>
            ) : (
              <label className="terminal-echo-toggle">
                <input
                  type="checkbox"
                  checked={showSentText}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setShowSentText(checked);
                    window.localStorage.setItem("p2p-netcat-show-sent", String(checked));
                  }}
                />
                <span className="toggle-track" aria-hidden="true"><span /></span>
                <span>Показывать отправленное</span>
              </label>
            )}
            <div className="traffic-stats">
              <span>↑ {formatBytes(sentBytes)}</span><span>↓ {formatBytes(receivedBytes)}</span>
            </div>
          </div>

          {interactive ? (
            <Suspense fallback={<div className="browser-terminal-loading">Загрузка PTY-терминала…</div>}>
              <BrowserTerminal
                ref={browserTerminalRef}
                connected={connected}
                onInput={sendTerminalInput}
                onResize={resizeTerminal}
                onExit={() => void exitInteractive()}
              />
            </Suspense>
          ) : (
            <>
              <pre className="terminal-output" ref={transcriptRef} aria-live="polite">
                {visibleTerminalEntries.length > 0
                  ? visibleTerminalEntries.map((entry) => (
                    <span key={entry.id} className={`terminal-${entry.direction}`}>{entry.text}</span>
                  ))
                  : <span className="terminal-empty">Ожидание данных…{`\n`}После соединения вывод удалённого процесса появится здесь.</span>}
              </pre>

              <div className="composer">
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  disabled={!connected}
                  aria-label="Данные для отправки"
                  rows={3}
                />
                <button type="button" className="send-button" disabled={!connected || !message} onClick={() => void sendMessage()}>
                  Отправить <kbd>⌘↵</kbd>
                </button>
              </div>
            </>
          )}

          <div className="transfer-bar">
            {!interactive && (
              <label className={`file-button ${!connected ? "disabled" : ""}`}>
                <input type="file" disabled={!connected} onChange={(event) => void sendFile(event.target.files?.[0])} />
                <span aria-hidden="true">＋</span> Отправить файл
              </label>
            )}
            <button type="button" disabled={!connected} onClick={() => void clientRef.current?.closeWrite()}>Отправить EOF</button>
            <button type="button" disabled={receivedBytes === 0} onClick={downloadReceived}>Скачать приём</button>
            {interactive && <span className="pty-help">Кликните терминал и печатайте; Enter и управляющие клавиши передаются напрямую</span>}
            {fileProgress && <span className="file-progress">{fileProgress}</span>}
          </div>
        </div>
      </section>

      <section className="event-log" aria-label="Журнал соединения">
        <div className="log-header"><span className="step-number">02</span><h2>Журнал событий</h2><button type="button" onClick={() => setLogs([])}>Очистить</button></div>
        <div className="log-list">
          {logs.length === 0 ? <p className="empty-log">Событий пока нет.</p> : logs.map((entry) => (
            <p key={entry.id} className={`log-${entry.kind}`}><time>{entry.time}</time><span>{entry.message}</span></p>
          ))}
        </div>
      </section>

      <footer>
        <p>p2p-netcat web <span>v0.4.0</span></p>
        <p>Delegated Routing · IPFS DHT · WSS · Noise · Yamux</p>
      </footer>
    </main>
  );
}
