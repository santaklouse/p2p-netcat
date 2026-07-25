const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)

// Current js-libp2p releases rely on Node.js 22 runtime primitives. Polyfilling
// only CustomEvent or Promise.withResolvers lets startup continue but can cause
// unbounded internal task creation on older runtimes, so fail before libp2p is
// imported and provide an actionable message.
if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
  throw new Error(
    `p2p-netcat требует Node.js 22 или новее; обнаружен Node.js ${process.versions.node}. ` +
    'Обновите Node.js (например, через nvm: nvm install 22 && nvm use 22).'
  )
}
