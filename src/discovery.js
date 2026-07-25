import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { relayedTargetAddress } from 'p2p-netcat-core'
import { setTimeout as sleep } from 'node:timers/promises'

function isMultiaddr (target) {
  return target.startsWith('/')
}

async function knownAddresses (node, peerId) {
  try {
    const peer = await node.peerStore.get(peerId)
    return peer.addresses.map(entry => entry.multiaddr)
  } catch {
    return []
  }
}

async function findProviderRecord (node, peerId, signal) {
  for await (const provider of node.contentRouting.findProviders(peerId.toCID(), { signal })) {
    // Anyone can announce a provider record for this CID. Only accept the peer
    // whose authenticated identity is exactly the requested PeerId.
    if (!provider.id.equals(peerId) || provider.multiaddrs.length === 0) continue
    await node.peerStore.merge(peerId, { multiaddrs: provider.multiaddrs })
    return true
  }

  return false
}

export async function advertiseSelf (node, {
  signal,
  verbose = false,
  retryMs = 5_000,
  reprovideMs = 6 * 60 * 60 * 1000
} = {}) {
  while (!signal?.aborted) {
    try {
      await node.contentRouting.provide(node.peerId.toCID(), {
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(60_000)
        ])
      })
      if (verbose) process.stderr.write('[p2p-nc] PeerId опубликован как provider record в IPFS DHT\n')
      await sleep(reprovideMs, undefined, { signal })
    } catch (error) {
      if (signal?.aborted) return
      if (verbose) process.stderr.write(`[p2p-nc] публикация PeerId в DHT пока не удалась: ${error.message}\n`)
      try {
        await sleep(retryMs, undefined, { signal })
      } catch {
        return
      }
    }
  }
}

export async function resolveTarget (node, target, {
  relays = [],
  timeoutMs = 30_000,
  verbose = false,
  signal
} = {}) {
  if (isMultiaddr(target)) return multiaddr(target)

  const peerId = peerIdFromString(target)

  if (relays.length > 0) {
    return relayedTargetAddress(relays[0], peerId)
  }

  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted()
    const addresses = await knownAddresses(node, peerId)
    if (addresses.length > 0) return peerId

    try {
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt))
      const providerSignal = AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(Math.min(4_000, remaining))
      ])

      try {
        if (await findProviderRecord(node, peerId, providerSignal)) return peerId
      } catch (error) {
        lastError = error
      }

      const afterProvider = Math.max(1, timeoutMs - (Date.now() - startedAt))
      const info = await node.peerRouting.findPeer(peerId, {
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(Math.min(4_000, afterProvider))
        ])
      })

      if (info.multiaddrs.length > 0) {
        await node.peerStore.merge(peerId, { multiaddrs: info.multiaddrs })
        return peerId
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      lastError = error
      if (verbose) process.stderr.write(`[p2p-nc] PeerId пока не найден, повтор поиска: ${error.message}\n`)
    }

    await sleep(500, undefined, { signal })
  }

  const hint = 'Укажите --relay с тем же relay, который использует сервер, либо полный multiaddr.'
  throw new Error(`Не удалось найти PeerId ${peerId} за ${Math.ceil(timeoutMs / 1000)} с. ${hint}`, { cause: lastError })
}
