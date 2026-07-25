import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("собирается как статическая PWA без серверного бандла", async () => {
  const [html, manifest, files, networkConfig] = await Promise.all([
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/manifest.webmanifest", import.meta.url), "utf8"),
    readdir(new URL("../dist/", import.meta.url)),
    readFile(new URL("../dist/network-config.json", import.meta.url), "utf8"),
  ]);

  assert.match(html, /p2p-netcat web/);
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /%BASE_URL%/);
  assert.ok(files.includes("sw.js"));
  assert.deepEqual(JSON.parse(networkConfig).delegatedRouting, ["https://delegated-ipfs.dev/routing/v1"]);
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.display, "standalone");
  assert.equal(parsedManifest.start_url, parsedManifest.scope);
  assert.ok(parsedManifest.icons.every((icon) => icon.src.startsWith(parsedManifest.scope)));
  await assert.rejects(access(new URL("../dist/server/", import.meta.url)));
});

test("сетевой стек работает в отдельном Web Worker", async () => {
  const [worker, client, trystero, core, page, terminal, main, styles] = await Promise.all([
    readFile(new URL("../app/p2p.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/p2p-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/trystero-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/core/src/index.js", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/browser-terminal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /p2p-netcat-core/);
  assert.doesNotMatch(worker, /const PROTOCOL_PREFIX/);
  assert.match(core, /\/p2p-netcat\/1\.0\.0/);
  assert.match(core, /class PtyFrameDecoder/);
  assert.match(core, /encodePtyData/);
  assert.match(core, /encodePtyResize/);
  assert.match(worker, /circuitRelayTransport\(\)/);
  assert.match(worker, /webSockets\(\)/);
  assert.match(worker, /webTransport\(\)/);
  assert.match(worker, /delegated-ipfs\.dev\/routing\/v1/);
  assert.match(worker, /kadDHT\(/);
  assert.match(worker, /pubsubPeerDiscovery\(/);
  assert.match(worker, /gossipsub\(/);
  assert.match(worker, /PUBSUB_DISCOVERY_TOPIC/);
  assert.match(worker, /indexedDB\.open/);
  assert.match(worker, /workerScope\.crypto\?\.subtle/);
  assert.match(worker, /Откройте приложение по HTTPS/);
  assert.match(client, /new Worker\(new URL/);
  assert.match(client, /Promise\.any/);
  assert.match(trystero, /@trystero-p2p\/torrent/);
  assert.match(trystero, /trysteroAuthPayload/);
  assert.match(trystero, /peerIdFromPublicKey/);
  assert.match(trystero, /defaultRtcConfiguration/);
  assert.match(core, /stun:stun\.l\.google\.com:19302/);
  assert.match(core, /stun:stun\.internetcalls\.com:3478/);
  assert.match(client, /transfer/);
  assert.match(client, /ackData/);
  assert.match(worker, /OUTPUT_HIGH_WATER_MARK/);
  assert.match(worker, /unacknowledgedOutputBytes/);
  assert.match(worker, /connectWithTimeout/);
  assert.match(worker, /libp2p не установил соединение за/);
  assert.match(terminal, /terminal\.write\(bytes, resolve\)/);
  assert.match(trystero, /defaultRelayUrls/);
  assert.match(trystero, /trickleIce: true/);
  assert.match(core, /flowWindowBytes/);
  assert.match(core, /ack:/);
  assert.match(page, /Необязательно · используется автопоиск/);
  assert.doesNotMatch(page, /!targetPeerId \|\| !relayAddress/);
  assert.match(main, /location\.hostname\.endsWith\("\.github\.io"\)/);
  assert.match(main, /window\.location\.replace\(secureUrl\)/);
  assert.match(page, /Показывать отправленное/);
  assert.match(page, /entry\.direction === "received"/);
  assert.match(page, /p2p-netcat-show-sent/);
  assert.match(page, /Интерактивный PTY/);
  assert.match(page, /p2p-netcat-interactive/);
  assert.match(page, /lazy\(\(\) => import\("\.\/browser-terminal"\)\)/);
  assert.match(client, /PtyFrameDecoder/);
  assert.match(client, /encodePtyData/);
  assert.match(client, /encodePtyResize/);
  assert.match(terminal, /@xterm\/xterm/);
  assert.match(terminal, /@xterm\/addon-fit/);
  assert.match(terminal, /character === "q"/);
  assert.match(styles, /\.terminal-echo-toggle/);
  assert.match(styles, /\.terminal-sent/);
  assert.match(styles, /\.browser-terminal/);
});
