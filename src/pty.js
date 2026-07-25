import { once } from 'node:events'
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import process from 'node:process'
import pty from 'node-pty'
import {
  PTY_FRAME_DATA,
  PTY_FRAME_RESIZE,
  PtyFrameDecoder,
  decodePtyResize,
  encodePtyData,
  encodePtyResize
} from 'p2p-netcat-core'

const require = createRequire(import.meta.url)

function ensureSpawnHelperExecutable () {
  if (process.platform === 'win32') return
  const packageDirectory = dirname(require.resolve('node-pty/package.json'))
  const candidates = [
    join(packageDirectory, 'build', 'Release', 'spawn-helper'),
    join(packageDirectory, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      chmodSync(candidate, 0o755)
    } catch {}
  }
}

function asBytes (value) {
  return value instanceof Uint8Array ? value : value.subarray()
}

async function * decodeFrames (source) {
  const decoder = new PtyFrameDecoder()
  for await (const value of source) {
    yield * decoder.push(asBytes(value))
  }
  decoder.finish()
}

function createSender (stream) {
  let pending = Promise.resolve()
  return {
    send (value) {
      pending = pending.then(async () => {
        if (!stream.send(value) && typeof stream.onDrain === 'function') await stream.onDrain()
      })
      return pending
    },
    drain () {
      return pending
    }
  }
}

function interactiveBytes (chunk, state) {
  const output = []
  let quit = false
  for (const byte of asBytes(chunk)) {
    if (state.escape) {
      state.escape = false
      if (byte === 0x71) {
        quit = true
        break
      }
      output.push(0x05, byte)
    } else if (byte === 0x05) {
      state.escape = true
    } else {
      output.push(byte)
    }
  }
  return { bytes: Uint8Array.from(output), quit }
}

export async function interactiveClientSession (stream, {
  input = process.stdin,
  output = process.stdout
} = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Интерактивный режим -i требует TTY на stdin')
  }

  const sender = createSender(stream)
  const state = { escape: false }
  let quitting = false
  const wasRaw = input.isRaw
  const sendResize = () => {
    void sender.send(encodePtyResize(output.columns, output.rows)).catch(() => {})
  }
  const onData = chunk => {
    if (quitting) return
    const parsed = interactiveBytes(chunk, state)
    if (parsed.bytes.byteLength > 0) void sender.send(encodePtyData(parsed.bytes)).catch(() => {})
    if (parsed.quit) {
      quitting = true
      input.pause()
      void sender.drain().then(() => stream.close()).catch(() => {})
    }
  }

  input.setRawMode(true)
  input.resume()
  input.on('data', onData)
  output.on?.('resize', sendResize)
  sendResize()

  try {
    for await (const message of decodeFrames(stream)) {
      if (message.type === PTY_FRAME_DATA && !output.write(Buffer.from(message.data))) await once(output, 'drain')
    }
  } finally {
    input.off('data', onData)
    output.off?.('resize', sendResize)
    input.setRawMode(Boolean(wasRaw))
    input.pause()
    if (stream.writeStatus === 'writable') await stream.close().catch(() => {})
  }
}

export async function ptyServerSession (stream, {
  shell = process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'),
  cwd = process.env.HOME ?? process.cwd(),
  env = process.env,
  verbose = false
} = {}) {
  ensureSpawnHelperExecutable()
  const shellArguments = process.platform === 'win32' ? [] : ['-l']
  const terminal = pty.spawn(shell, shellArguments, {
    name: env.TERM ?? 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env
  })
  const sender = createSender(stream)
  const decoder = new StringDecoder('utf8')
  const outputSubscription = terminal.onData(data => {
    void sender.send(encodePtyData(Buffer.from(data, 'utf8'))).catch(() => {})
  })
  const exitPromise = new Promise(resolve => {
    terminal.onExit(event => resolve(event.exitCode))
  })

  if (verbose) process.stderr.write(`[p2p-nc] PTY login shell запущен, pid=${terminal.pid}: ${shell}\n`)

  const receiveTask = (async () => {
    for await (const message of decodeFrames(stream)) {
      if (message.type === PTY_FRAME_DATA) {
        terminal.write(decoder.write(Buffer.from(message.data)))
      } else if (message.type === PTY_FRAME_RESIZE) {
        const { columns, rows } = decodePtyResize(message.data)
        terminal.resize(columns, rows)
      }
    }
  })()

  let exitCode = 0
  try {
    const result = await Promise.race([
      receiveTask.then(() => ({ source: 'remote' })),
      exitPromise.then(code => ({ source: 'pty', code }))
    ])
    if (result.source === 'remote') {
      if (verbose) process.stderr.write(`terminal should be killed?!\n`)
      terminal.kill()
      exitCode = await exitPromise
    } else {
      exitCode = result.code
    }
    await sender.drain()
    if (stream.writeStatus === 'writable') await stream.close()
    await receiveTask.catch(() => {})
  } finally {
    outputSubscription.dispose()
    try {
      terminal.kill()
    } catch {}
  }

  if (verbose) process.stderr.write(`[p2p-nc] PTY login shell завершён с кодом ${exitCode}\n`)
  return exitCode
}

export const PTY_PROTOCOL = Object.freeze({
  FRAME_DATA: PTY_FRAME_DATA,
  FRAME_RESIZE: PTY_FRAME_RESIZE,
  encodeData: encodePtyData,
  encodeResize: encodePtyResize
})
