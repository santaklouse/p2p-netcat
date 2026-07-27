import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import {
  pairingProviderCids,
  relayedTargetAddress
} from 'p2p-netcat-core'
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

async function findProviderRecord (node, peerId, cid, signal) {
  for await (const provider of node.contentRouting.findProviders(cid, { signal })) {
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
  reprovideMs = 6 * 60 * 60 * 1000,
  pairingToken
} = {}) {
  while (!signal?.aborted) {
    try {
      const cids = pairingToken == null
        ? [node.peerId.toCID()]
        : await pairingProviderCids(pairingToken, { offsets: [-1, 0, 1] })
      await Promise.all(cids.map(cid => node.contentRouting.provide(cid, {
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(60_000)
        ])
      })))
      if (verbose) {
        const mode = pairingToken == null ? 'PeerId' : 'приватный вращающийся rendezvous'
        process.stderr.write(`[p2p-nc] ${mode} опубликован как provider record в IPFS DHT\n`)
      }
      const nextProvideMs = pairingToken == null ? reprovideMs : Math.min(reprovideMs, 5 * 60 * 1000)
      await sleep(nextProvideMs, undefined, { signal })
    } catch (error) {
      if (signal?.aborted) return
      if (verbose) {
        const mode = pairingToken == null ? 'PeerId' : 'приватного rendezvous'
        process.stderr.write(`[p2p-nc] публикация ${mode} в DHT пока не удалась: ${error.message}\n`)
      }
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
  signal,
  pairingToken
} = {}) {
  if (isMultiaddr(target)) return multiaddr(target)

  const peerId = peerIdFromString(target)

  if (relays.length > 0) {
    if (verbose) process.stderr.write(`[p2p-nc] libp2p: использую заданный Circuit Relay для ${peerId}\n`)
    return relayedTargetAddress(relays[0], peerId)
  }

  const startedAt = Date.now()
  let lastError
  let lastVerboseAt = 0
  if (verbose) {
    const sources = pairingToken == null
      ? 'peer store, IPFS DHT и PubSub discovery'
      : 'peer store и приватных вращающихся IPFS DHT provider records'
    process.stderr.write(`[p2p-nc] libp2p: ищу ${peerId} через ${sources}\n`)
  }

  while (Date.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted()
    const addresses = await knownAddresses(node, peerId)
    if (addresses.length > 0) {
      if (verbose) process.stderr.write(`[p2p-nc] libp2p: найдено адресов в peer store: ${addresses.length}\n`)
      return peerId
    }

    try {
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt))
      try {
        const providerCids = pairingToken == null
          ? [peerId.toCID()]
          : await pairingProviderCids(pairingToken, { offsets: [-1, 0, 1] })
        const providerControllers = providerCids.map(() => new AbortController())
        const found = await Promise.any(providerCids.map(async (cid, index) => {
          const found = await findProviderRecord(node, peerId, cid, AbortSignal.any([
            signal ?? new AbortController().signal,
            providerControllers[index].signal,
            AbortSignal.timeout(Math.min(4_000, remaining))
          ]))
          if (!found) throw new Error('Provider record not found in this rendezvous window')
          return true
        })).catch(() => false).finally(() => {
          for (const controller of providerControllers) {
            controller.abort(new Error('Provider lookup completed in another rendezvous window'))
          }
        })
        if (found) {
          if (verbose) {
            const mode = pairingToken == null ? 'provider record' : 'приватный provider record'
            process.stderr.write(`[p2p-nc] libp2p: PeerId найден через ${mode} в IPFS DHT\n`)
          }
          return peerId
        }
      } catch (error) {
        lastError = error
      }

      if (pairingToken == null) {
        const afterProvider = Math.max(1, timeoutMs - (Date.now() - startedAt))
        const info = await node.peerRouting.findPeer(peerId, {
          signal: AbortSignal.any([
            signal ?? new AbortController().signal,
            AbortSignal.timeout(Math.min(4_000, afterProvider))
          ])
        })

        if (info.multiaddrs.length > 0) {
          await node.peerStore.merge(peerId, { multiaddrs: info.multiaddrs })
          if (verbose) process.stderr.write(`[p2p-nc] libp2p: DHT вернула адресов: ${info.multiaddrs.length}\n`)
          return peerId
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      lastError = error
      if (verbose && Date.now() - lastVerboseAt >= 5_000) {
        lastVerboseAt = Date.now()
        const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        process.stderr.write(`[p2p-nc] libp2p: PeerId пока не найден, поиск продолжается (${elapsed} с): ${error.message}\n`)
      }
    }

    await sleep(500, undefined, { signal })
  }

  const hint = 'Укажите --relay с тем же relay, который использует сервер, либо полный multiaddr.'
  throw new Error(`Не удалось найти PeerId ${peerId} за ${Math.ceil(timeoutMs / 1000)} с. ${hint}`, { cause: lastError })
}
