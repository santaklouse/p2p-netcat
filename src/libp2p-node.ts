import { createLibp2p, type Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { mdns } from '@libp2p/mdns'
import { mplex } from '@libp2p/mplex'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { floodsub } from '@libp2p/floodsub'
export interface Libp2pNodeOptions {
  listen?: string[]
}

export async function createNode(options: Libp2pNodeOptions = {}): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: {
      listen:
        options.listen ??
        [
          '/ip4/0.0.0.0/tcp/0',
          '/ip4/0.0.0.0/tcp/0/ws'
        ]
    },
    transports: [tcp(), webSockets()],
    streamMuxers: [mplex()],
    connectionEncrypters: [noise()],
    services: {
      identify: identify(),
      pubsub: floodsub(),
      mdns: mdns()
    }
  })

  enableAutoDialOnDiscovery(node)
  return node
}

export function nodeInfo(node: Libp2p): { peerId: string; listenAddrs: string[] } {
  return {
    peerId: node.peerId.toString(),
    listenAddrs: node.getMultiaddrs().map((m) => m.toString())
  }
}

function enableAutoDialOnDiscovery(node: Libp2p): void {
  const pendingDials = new Set<string>()

  node.addEventListener('peer:discovery', (evt: CustomEvent<{ id: { toString(): string } }>) => {
    const peer = evt.detail.id as any
    const peerId = peer.toString()

    if (pendingDials.has(peerId)) return
    if (node.getConnections(peer).length > 0) return

    pendingDials.add(peerId)
    void node
      .dial(peer)
      .catch(() => {})
      .finally(() => {
        pendingDials.delete(peerId)
      })
  })
}
