import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

test('WebRTC runtime is dependency-free from Trystero while preserving its historical wire domain', async () => {
  const repositoryRoot = new URL('../', import.meta.url)
  const [rootPackage, rootLock, webPackage, webLock, nodeWebRtc, browserClient, core] = await Promise.all([
    readFile(new URL('package.json', repositoryRoot), 'utf8'),
    readFile(new URL('package-lock.json', repositoryRoot), 'utf8'),
    readFile(new URL('web/package.json', repositoryRoot), 'utf8'),
    readFile(new URL('web/package-lock.json', repositoryRoot), 'utf8'),
    readFile(new URL('src/webrtc.js', repositoryRoot), 'utf8'),
    readFile(new URL('web/app/p2p-client.ts', repositoryRoot), 'utf8'),
    readFile(new URL('packages/core/src/index.js', repositoryRoot), 'utf8')
  ])

  for (const manifest of [rootPackage, rootLock, webPackage, webLock]) {
    assert.doesNotMatch(manifest, /@trystero-p2p/)
  }
  assert.doesNotMatch(nodeWebRtc, /@trystero-p2p|enableLegacyFallback/)
  assert.doesNotMatch(browserClient, /@trystero-p2p|legacyWebRtc|nativeOnly/)
  await assert.rejects(access(new URL('src/trystero.js', repositoryRoot)))
  await assert.rejects(access(new URL('web/app/webrtc-client.ts', repositoryRoot)))
  assert.match(core, /p2p-netcat\/trystero-auth\/v1/)
})
