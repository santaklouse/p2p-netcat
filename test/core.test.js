import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, publicKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromPublicKey } from '@libp2p/peer-id'
import { createP2PNode, protectPubsubPeerDiscovery } from '../src/node.js'
import { loadOrCreateIdentity } from '../src/identity.js'
import { startRelay } from 'p2p-netcat/relay'
import { protocolForService as protocolFromCliSubpath } from 'p2p-netcat/core'
import {
  decodeTrysteroAuthResponse,
  encodeTrysteroAuthResponse,
  preferDialAddresses,
  protocolForService,
  relayedTargetAddress,
  trysteroAuthPayload,
  validateService
} from 'p2p-netcat-core'

test('логический порт валидируется и преобразуется в protocol id', () => {
  assert.equal(validateService('8080'), 8080)
  assert.equal(protocolForService(8080), '/p2p-netcat/1.0.0/8080')
  assert.throws(() => validateService(0), /от 1 до 65535/)
  assert.throws(() => validateService(65536), /от 1 до 65535/)
})

test('CLI subpath p2p-netcat/core экспортирует browser-safe ядро', () => {
  assert.equal(protocolFromCliSubpath(31337), '/p2p-netcat/1.0.0/31337')
})

test('ошибка остановки частично запущенного PubSub не скрывает исходную ошибку', () => {
  const stopped = protectPubsubPeerDiscovery(() => ({
    beforeStop () {
      throw new Error('Pubsub is not started')
    }
  }))({})
  assert.doesNotThrow(() => stopped.beforeStop())

  const unexpected = protectPubsubPeerDiscovery(() => ({
    beforeStop () {
      throw new Error('unexpected cleanup failure')
    }
  }))({})
  assert.throws(() => unexpected.beforeStop(), /unexpected cleanup failure/)
})

test('постоянный ключ сохраняет один и тот же PeerId и закрытые права', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p2p-netcat-test-'))
  const keyPath = join(directory, 'identity.key')
  const first = await loadOrCreateIdentity(keyPath)
  const second = await loadOrCreateIdentity(keyPath)

  assert.equal(peerIdFromPrivateKey(first).toString(), peerIdFromPrivateKey(second).toString())
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600)
})

test('relay multiaddr строится из relay и PeerId', async () => {
  const relayId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
  const targetId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
  const relay = `/ip4/127.0.0.1/tcp/9090/p2p/${relayId}`

  assert.equal(
    relayedTargetAddress(relay, targetId).toString(),
    `${relay}/p2p-circuit/p2p/${targetId}`
  )
})

test('публичный relay API запускает и идемпотентно останавливает Circuit Relay v2', async () => {
  const relay = await startRelay({
    identityPath: null,
    localPort: 0,
    websocketPort: null,
    ipVersion: 4,
    enableMdns: false,
    enableQuic: false
  })

  assert.match(relay.peerId, /^12D3KooW/)
  assert.equal(relay.identityPath, null)
  assert.ok(relay.addresses.some(address => address.includes('/ip4/127.0.0.1/tcp/')))
  assert.ok(relay.addresses.every(address => address.endsWith(`/p2p/${relay.peerId}`)))
  assert.equal(relay.node.status, 'started')

  await Promise.all([relay.stop(), relay.stop()])
  assert.equal(relay.node.status, 'stopped')
})

test('QUIC имеет приоритет перед TCP, а relay остаётся последним', () => {
  const address = value => ({ multiaddr: { toString: () => value } })
  const quicAddress = address('/ip4/127.0.0.1/udp/9090/quic-v1')
  const tcpAddress = address('/ip4/127.0.0.1/tcp/9090')
  const relayAddress = address('/ip4/127.0.0.1/tcp/9091/p2p/relay/p2p-circuit')

  assert.ok(preferDialAddresses(quicAddress, tcpAddress) < 0)
  assert.ok(preferDialAddresses(tcpAddress, relayAddress) < 0)
})

test('Trystero challenge криптографически привязан к ожидаемому PeerId', async () => {
  const privateKey = await generateKeyPair('Ed25519')
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const payload = trysteroAuthPayload(peerId, 31337, challenge)
  const frame = encodeTrysteroAuthResponse(
    publicKeyToProtobuf(privateKey.publicKey),
    await privateKey.sign(payload)
  )
  const response = decodeTrysteroAuthResponse(frame)
  const publicKey = publicKeyFromProtobuf(response.publicKey)
  assert.equal(peerIdFromPublicKey(publicKey).toString(), peerId)
  assert.equal(await publicKey.verify(payload, response.signature), true)
  assert.equal(await publicKey.verify(trysteroAuthPayload(peerId, 31338, challenge), response.signature), false)
})

test('два локальных узла передают двунаправленный бинарный поток', async () => {
  const server = await createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    relays: []
  })
  const client = await createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    relays: []
  })
  const protocol = protocolForService(49152)
  const received = []

  try {
    await server.handle(protocol, async stream => {
      for await (const chunk of stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray()
        received.push(...bytes)
        stream.send(Uint8Array.from(bytes, byte => byte ^ 0xff))
      }
      await stream.close()
    })

    const target = server.getMultiaddrs().find(address => {
      const value = address.toString()
      return value.includes('/ip4/127.0.0.1/') && value.includes('/tcp/')
    })
    assert.ok(target, 'сервер должен слушать localhost')
    const stream = await client.dialProtocol(target, protocol)
    const payload = Uint8Array.from([0x00, 0x41, 0xff, 0x0a])
    stream.send(payload)
    await stream.close()

    const response = []
    for await (const chunk of stream) {
      response.push(...(chunk instanceof Uint8Array ? chunk : chunk.subarray()))
    }

    assert.deepEqual(received, [...payload])
    assert.deepEqual(response, [...payload].map(byte => byte ^ 0xff))
  } finally {
    await Promise.allSettled([client.stop(), server.stop()])
  }
})

test('GossipSub обнаруживает PeerId через промежуточный совместимый узел', async () => {
  const nodeOptions = async () => ({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    enablePubsub: true,
    pubsubIntervalMs: 200,
    enableQuic: false,
    relays: []
  })
  const hub = await createP2PNode(await nodeOptions())
  const seeker = await createP2PNode(await nodeOptions())
  const target = await createP2PNode(await nodeOptions())

  try {
    const discovered = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PubSub discovery timeout')), 8_000)
      seeker.addEventListener('peer:discovery', event => {
        if (!event.detail.id.equals(target.peerId)) return
        clearTimeout(timeout)
        resolve(event.detail)
      })
    })
    const hubAddress = hub.getMultiaddrs().find(address => (
      address.toString().includes('/ip4/127.0.0.1/') && address.toString().includes('/tcp/')
    ))
    assert.ok(hubAddress, 'промежуточный узел должен слушать localhost TCP')

    await Promise.all([seeker.dial(hubAddress), target.dial(hubAddress)])
    const peer = await discovered

    assert.equal(peer.id.toString(), target.peerId.toString())
    assert.ok(peer.multiaddrs.length > 0)
    assert.ok((await seeker.peerStore.get(target.peerId)).addresses.length > 0)
  } finally {
    await Promise.allSettled([seeker.stop(), target.stop(), hub.stop()])
  }
})

test('два локальных узла передают поток напрямую через QUIC v1', async () => {
  const server = await createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    relays: []
  })
  const client = await createP2PNode({
    privateKey: await generateKeyPair('Ed25519'),
    localPort: 0,
    ipVersion: 4,
    bootstrapPeers: [],
    enableDht: false,
    enableMdns: false,
    relays: []
  })
  const protocol = protocolForService(49153)
  const payload = Uint8Array.from([0x51, 0x55, 0x49, 0x43, 0x0a])
  const received = []

  try {
    await server.handle(protocol, async stream => {
      for await (const chunk of stream) {
        received.push(...(chunk instanceof Uint8Array ? chunk : chunk.subarray()))
      }
      stream.send(Uint8Array.from([0x4f, 0x4b, 0x0a]))
      await stream.close()
    })

    const addresses = server.getMultiaddrs().filter(address => address.toString().includes('/ip4/127.0.0.1/'))
    assert.ok(addresses.some(address => address.toString().includes('/quic-v1')), 'сервер должен слушать QUIC на localhost')
    assert.ok(addresses.some(address => address.toString().includes('/tcp/')), 'сервер должен сохранять TCP fallback')
    await client.peerStore.merge(server.peerId, { multiaddrs: addresses })

    const stream = await client.dialProtocol(server.peerId, protocol)
    assert.match(client.getConnections(server.peerId)[0].remoteAddr.toString(), /\/quic-v1/)
    stream.send(payload)
    await stream.close()

    const response = []
    for await (const chunk of stream) {
      response.push(...(chunk instanceof Uint8Array ? chunk : chunk.subarray()))
    }

    assert.deepEqual(received, [...payload])
    assert.deepEqual(response, [0x4f, 0x4b, 0x0a])
  } finally {
    await Promise.allSettled([client.stop(), server.stop()])
  }
})
