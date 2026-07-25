import './runtime.js'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { quic } from '@chainsafe/libp2p-quic'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { gossipsub } from '@libp2p/gossipsub'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { bootstrap } from '@libp2p/bootstrap'
import { mdns } from '@libp2p/mdns'
import { kadDHT, removePrivateAddressesMapper } from '@libp2p/kad-dht'
import { multiaddr } from '@multiformats/multiaddr'
import {
  PUBSUB_DISCOVERY_INTERVAL_MS,
  PUBSUB_DISCOVERY_TOPIC,
  normalizeRelayAddress,
  preferDialAddresses
} from 'p2p-netcat-core'
import { APP_VERSION, IPFS_BOOTSTRAP_PEERS } from './constants.js'

export function protectPubsubPeerDiscovery (createDiscovery) {
  return components => {
    const discovery = createDiscovery(components)
    const beforeStop = discovery.beforeStop.bind(discovery)
    discovery.beforeStop = () => {
      try {
        beforeStop()
      } catch (error) {
        // During a partial libp2p startup failure GossipSub may already be
        // stopped. Do not let discovery cleanup hide the original exception.
        const message = error instanceof Error ? error.message : String(error)
        if (!/pubsub (?:is|has) not started/i.test(message)) throw error
      }
    }
    return discovery
  }
}

function safePubsubPeerDiscovery (options) {
  return protectPubsubPeerDiscovery(pubsubPeerDiscovery(options))
}

export async function createP2PNode ({
  privateKey,
  localPort = 0,
  websocketPort,
  ipVersion,
  announce = [],
  relays = [],
  bootstrapPeers = IPFS_BOOTSTRAP_PEERS,
  enableDht = true,
  enableMdns = true,
  enablePubsub = true,
  pubsubIntervalMs = PUBSUB_DISCOVERY_INTERVAL_MS,
  enableQuic = true,
  relayServer = false,
  dhtServer = false,
  listen = true
} = {}) {
  const relayAddresses = relays.map(address => normalizeRelayAddress(address))
  const listenAddresses = []

  if (listen) {
    if (enableQuic && ipVersion !== 6) listenAddresses.push(`/ip4/0.0.0.0/udp/${localPort}/quic-v1`)
    if (enableQuic && ipVersion !== 4) listenAddresses.push(`/ip6/::/udp/${localPort}/quic-v1`)
    if (ipVersion !== 6) listenAddresses.push(`/ip4/0.0.0.0/tcp/${localPort}`)
    if (ipVersion !== 4) listenAddresses.push(`/ip6/::/tcp/${localPort}`)
  }

  if (websocketPort != null) {
    if (ipVersion !== 6) listenAddresses.push(`/ip4/0.0.0.0/tcp/${websocketPort}/ws`)
    if (ipVersion !== 4) listenAddresses.push(`/ip6/::/tcp/${websocketPort}/ws`)
  }

  if (!relayServer) {
    if (relayAddresses.length > 0) {
      listenAddresses.push(...relayAddresses.map(address => `${address}/p2p-circuit`))
    } else if (listen) {
      // Ask suitable connected peers for an automatic Circuit Relay v2 reservation.
      listenAddresses.push('/p2p-circuit')
    }
  }

  const peerDiscovery = []
  if (enableMdns) peerDiscovery.push(mdns())
  if (bootstrapPeers.length > 0) {
    peerDiscovery.push(bootstrap({ list: bootstrapPeers, timeout: 10_000 }))
  }
  if (enablePubsub) {
    peerDiscovery.push(safePubsubPeerDiscovery({
      interval: pubsubIntervalMs,
      topics: [PUBSUB_DISCOVERY_TOPIC]
    }))
  }

  const services = {
    identify: identify({ agentVersion: `p2p-netcat/${APP_VERSION}` }),
    ping: ping()
  }

  if (enablePubsub) {
    services.pubsub = gossipsub({
      // GossipSub uses StrictSign by default, cryptographically binding every
      // announcement to its author before peer-discovery decodes it.
      allowPublishToZeroTopicPeers: true
    })
  }

  if (enableDht) {
    services.aminoDHT = kadDHT({
      protocol: '/ipfs/kad/1.0.0',
      peerInfoMapper: removePrivateAddressesMapper,
      clientMode: !dhtServer
    })
  }

  if (relayServer) {
    services.circuitRelay = circuitRelayServer({
      reservations: {
        maxReservations: 128,
        applyDefaultLimit: true,
        defaultDurationLimit: 2 * 60 * 60 * 1000,
        defaultDataLimit: 128n * 1024n * 1024n
      }
    })
  }

  return createLibp2p({
    privateKey,
    addresses: {
      listen: listenAddresses,
      announce: announce.map(address => multiaddr(address))
    },
    transports: [
      ...(enableQuic ? [quic({
        ipv4: ipVersion !== 6,
        ipv6: ipVersion !== 4
      })] : []),
      tcp({
        // Netcat sessions may legitimately stay silent for a long time.
        inboundSocketInactivityTimeout: 0,
        outboundSocketInactivityTimeout: 0
      }),
      webSockets(),
      circuitRelayTransport()
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services,
    connectionGater: {
      // Private addresses are necessary for localhost and LAN netcat sessions.
      denyDialMultiaddr: () => false
    },
    connectionManager: {
      maxConnections: relayServer ? 512 : 128,
      addressSorter: preferDialAddresses
    }
  })
}
