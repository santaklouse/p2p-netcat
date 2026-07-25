import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { createP2PNode } from '../src/node.js'
import { createProgram } from '../src/cli.js'
import { negotiateSocks, socksProxySession, startLocalForward, tcpForwardSession } from '../src/forwarding.js'
import { PTY_PROTOCOL, createStreamSender, ptyServerSession } from '../src/pty.js'
import { quietRequested, torCommand, torRequested } from '../src/tor.js'
import { protocolForService } from 'p2p-netcat-core'

async function listen (server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address()
}

async function closeServer (server) {
  if (!server.listening) return
  const closed = once(server, 'close')
  server.close()
  for (const socket of server.testSockets ?? []) socket.destroy()
  server.closeAllConnections?.()
  await closed
}

async function timed (promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), 3_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function createLocalNode () {
  return createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    enablePubsub: false,
    enableQuic: false,
    relays: []
  })
}

function tcpAddress (node) {
  return node.getMultiaddrs().find(address => (
    address.toString().includes('/ip4/127.0.0.1/') && address.toString().includes('/tcp/')
  ))
}

function echoServer () {
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', chunk => socket.write(chunk))
    socket.on('end', () => socket.end())
  })
  server.testSockets = new Set()
  server.on('connection', socket => {
    server.testSockets.add(socket)
    socket.once('close', () => server.testSockets.delete(socket))
  })
  return server
}

test('-p и -d создают многослойный TCP forward через отдельный P2P stream', async () => {
  const echo = echoServer()
  const echoAddress = await listen(echo)
  const server = await createLocalNode()
  const client = await createLocalNode()
  const protocol = protocolForService(49200)
  let localForward

  try {
    await server.handle(protocol, stream => tcpForwardSession(stream, {
      host: '127.0.0.1',
      port: echoAddress.port
    }), { maxInboundStreams: 16 })
    const destination = tcpAddress(server)
    assert.ok(destination)
    localForward = await startLocalForward({
      port: 0,
      openStream: () => client.dialProtocol(destination, protocol)
    })

    const socket = createConnection(localForward.address)
    await once(socket, 'connect')
    socket.write('forward-ok')
    const [reply] = await once(socket, 'data')
    assert.equal(reply.toString(), 'forward-ok')
    socket.end()
    await once(socket, 'close')
  } finally {
    await timed(localForward?.close(), 'local forward close')
    await timed(Promise.allSettled([client.stop(), server.stop()]), 'node stop')
    await timed(closeServer(echo), 'echo close')
  }
})

test('-S обслуживает SOCKS5 CONNECT через клиентский -p forward', async () => {
  const echo = echoServer()
  const echoAddress = await listen(echo)
  const server = await createLocalNode()
  const client = await createLocalNode()
  const protocol = protocolForService(49201)
  let localForward

  try {
    await server.handle(protocol, stream => socksProxySession(stream), { maxInboundStreams: 16 })
    const destination = tcpAddress(server)
    assert.ok(destination)
    localForward = await startLocalForward({
      port: 0,
      openStream: () => client.dialProtocol(destination, protocol)
    })
    const socket = createConnection(localForward.address)
    await once(socket, 'connect')

    socket.write(Uint8Array.from([0x05, 0x01, 0x00]))
    assert.deepEqual([...(await once(socket, 'data'))[0]], [0x05, 0x00])
    socket.write(Uint8Array.from([
      0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1,
      (echoAddress.port >> 8) & 0xff, echoAddress.port & 0xff
    ]))
    assert.deepEqual([...(await once(socket, 'data'))[0]], [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
    socket.write('socks-ok')
    assert.equal((await once(socket, 'data'))[0].toString(), 'socks-ok')
    socket.end()
    await once(socket, 'close')
  } finally {
    await localForward?.close()
    await Promise.allSettled([client.stop(), server.stop()])
    await closeServer(echo)
  }
})

function handshakeStream (input) {
  const sent = []
  return {
    sent,
    send (value) {
      sent.push(Uint8Array.from(value))
      return true
    },
    async * [Symbol.asyncIterator] () {
      yield Uint8Array.from(input)
    }
  }
}

test('-S распознаёт SOCKS4 и SOCKS4a requests', async () => {
  const socks4 = handshakeStream([0x04, 0x01, 0x00, 0x16, 127, 0, 0, 1, 0])
  const first = await negotiateSocks(socks4)
  assert.deepEqual({ version: first.version, host: first.host, port: first.port }, {
    version: 4,
    host: '127.0.0.1',
    port: 22
  })

  const domain = [...Buffer.from('example.com'), 0]
  const socks4a = handshakeStream([0x04, 0x01, 0x01, 0xbb, 0, 0, 0, 1, 0, ...domain])
  const second = await negotiateSocks(socks4a)
  assert.deepEqual({ version: second.version, host: second.host, port: second.port }, {
    version: 4,
    host: 'example.com',
    port: 443
  })
})

class MemoryStream {
  status = 'open'
  writeStatus = 'writable'
  #items = []
  #waiters = []
  peer

  send (value) {
    this.peer.#push(Uint8Array.from(value))
    return true
  }

  onDrain () {
    return Promise.resolve()
  }

  async close () {
    if (this.writeStatus !== 'writable') return
    this.writeStatus = 'closed'
    this.peer.#end()
  }

  abort (error) {
    this.writeStatus = 'closed'
    this.status = 'closed'
    this.peer.#fail(error)
  }

  #push (value) {
    const waiter = this.#waiters.shift()
    if (waiter != null) waiter.resolve({ value, done: false })
    else this.#items.push(value)
  }

  #end () {
    this.status = 'closed'
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  #fail (error) {
    this.status = 'closed'
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator] () {
    return {
      next: () => {
        const value = this.#items.shift()
        if (value != null) return Promise.resolve({ value, done: false })
        if (this.status === 'closed') return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
      }
    }
  }
}

function memoryStreamPair () {
  const first = new MemoryStream()
  const second = new MemoryStream()
  first.peer = second
  second.peer = first
  return [first, second]
}

test('PTY sender pauses output while the network stream is backpressured', async () => {
  const drainResolvers = []
  const transitions = []
  const stream = {
    status: 'open',
    writeStatus: 'writable',
    send: () => false,
    onDrain: () => new Promise(resolve => drainResolvers.push(resolve))
  }
  const sender = createStreamSender(stream, {
    highWaterMarkBytes: 8,
    lowWaterMarkBytes: 4,
    onPause: () => transitions.push('pause'),
    onResume: () => transitions.push('resume')
  })

  const first = sender.send(Uint8Array.from({ length: 6 }, () => 1))
  const second = sender.send(Uint8Array.from({ length: 6 }, () => 2))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sender.queuedBytes, 12)
  assert.deepEqual(transitions, ['pause'])

  drainResolvers.shift()()
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sender.queuedBytes, 6)
  assert.deepEqual(transitions, ['pause'])

  drainResolvers.shift()()
  await second
  await sender.drain()
  assert.equal(sender.queuedBytes, 0)
  assert.deepEqual(transitions, ['pause', 'resume'])
})

test('-i запускает настоящий PTY, принимает resize и выполняет login shell', async () => {
  if (process.platform === 'win32') return
  const [server, client] = memoryStreamPair()
  const serverTask = ptyServerSession(server, { shell: '/bin/sh', cwd: process.cwd() })
  const outputTask = (async () => {
    const chunks = []
    for await (const encoded of client) {
      const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
      if (encoded[0] === 0) chunks.push(encoded.slice(5, 5 + view.getUint32(1)))
    }
    await client.close()
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString()
  })()

  client.send(PTY_PROTOCOL.encodeResize(100, 40))
  client.send(PTY_PROTOCOL.encodeData(Buffer.from("printf 'pty-ok\\n'; exit\n")))
  const [exitCode, output] = await Promise.all([serverTask, outputTask])
  assert.equal(exitCode, 0)
  assert.match(output, /pty-ok/)
})

test('-T строит изолированный torsocks re-exec и -q включает quiet wrapper', () => {
  const argv = ['/usr/bin/node', '/app/p2p-nc.js', '-Tq', '--relay', '/ip4/203.0.113.1/tcp/443/p2p/peer', 'peer']
  assert.equal(torRequested(argv), true)
  assert.equal(quietRequested(argv), true)
  assert.equal(torRequested(['/usr/bin/node', '/app/p2p-nc.js', '-I/tmp/Token.key']), false)
  assert.equal(quietRequested(['/usr/bin/node', '/app/p2p-nc.js', '-I/tmp/quiet.key']), false)
  const config = torCommand(argv, {
    P2P_NETCAT_TOR_HOST: '127.0.0.2',
    P2P_NETCAT_TOR_PORT: '9150',
    P2P_NETCAT_TORSOCKS_COMMAND: '/usr/bin/torsocks'
  })
  assert.equal(config.command, '/usr/bin/torsocks')
  assert.deepEqual(config.arguments.slice(0, 7), ['-q', '-i', '-a', '127.0.0.2', '-P', '9150', process.execPath])
  assert.equal(config.options.env.P2P_NETCAT_TOR_ACTIVE, '1')
})

test('CLI отдаёт короткие -p -q -i семантике gs-netcat', () => {
  const program = createProgram()
  program.parseOptions(['-q', '-i', '-p', '1080', '--transport-port', '4001'])
  assert.equal(program.opts().quiet, true)
  assert.equal(program.opts().interactive, true)
  assert.equal(program.opts().port, 1080)
  assert.equal(program.opts().transportPort, 4001)
})
