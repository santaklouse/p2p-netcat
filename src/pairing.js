import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  assertPairingTokenUsable,
  decodePairingToken
} from 'p2p-netcat-core'

export async function loadPairingToken (options = {}, expected = {}) {
  const inline = String(options.pairingToken ?? '').trim()
  const file = String(options.pairingTokenFile ?? '').trim()
  const environment = String(process.env.P2P_NETCAT_TOKEN ?? '').trim()
  const sources = [
    inline.length > 0 ? { label: '--pairing-token', value: inline } : null,
    file.length > 0
      ? { label: '--pairing-token-file', value: String(await readFile(resolve(file), 'utf8')).trim() }
      : null,
    environment.length > 0 ? { label: 'P2P_NETCAT_TOKEN', value: environment } : null
  ].filter(Boolean)

  if (sources.length === 0) return null
  const distinct = [...new Set(sources.map(source => source.value))]
  if (distinct.length > 1) {
    throw new Error(`Pairing token differs between ${sources.map(source => source.label).join(', ')}`)
  }
  const token = decodePairingToken(distinct[0])
  return assertPairingTokenUsable(token, expected)
}
