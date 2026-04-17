import type { Libp2p } from 'libp2p'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

export interface PubSubMessage {
  topic: string
  data: Uint8Array
  from?: string
  timestamp?: number
}

export interface WaitForSubscribersOptions {
  minSubscribers?: number
  timeoutMs?: number
  pollIntervalMs?: number
}

/** Событие pubsub: detail — сообщение с полями topic/data (см. @libp2p/pubsub). */
type PubSubMessageEventDetail = {
  topic: string
  data: Uint8Array
  type?: string
}

type PubSubService = {
  subscribe: (topic: string) => void
  unsubscribe: (topic: string) => void
  publish: (topic: string, data: Uint8Array) => Promise<unknown>
  getSubscribers: (topic: string) => Array<{ toString(): string }>
  addEventListener: (type: 'message', listener: (evt: CustomEvent<PubSubMessageEventDetail>) => void) => void
  removeEventListener: (type: 'message', listener: (evt: CustomEvent<PubSubMessageEventDetail>) => void) => void
}

export class PubSubManager {
  constructor(private readonly node: Libp2p) {}

  async subscribe(topic: string, onMessage: (msg: PubSubMessage) => void): Promise<() => void> {
    const pubsub = this.node.services.pubsub as PubSubService
    if (!pubsub) throw new Error('PubSub service is not configured on this node')

    const listener = (evt: CustomEvent<PubSubMessageEventDetail>) => {
      const msg = evt.detail
      if (msg.topic !== topic) return

      onMessage({
        topic: msg.topic,
        data: msg.data,
        timestamp: Date.now()
      })
    }

    pubsub.subscribe(topic)
    pubsub.addEventListener('message', listener)

    return () => {
      pubsub.removeEventListener('message', listener)
      pubsub.unsubscribe(topic)
    }
  }

  async publish(topic: string, data: string | Uint8Array): Promise<void> {
    const pubsub = this.node.services.pubsub as PubSubService
    if (!pubsub) throw new Error('PubSub service is not configured on this node')

    const payload = typeof data === 'string' ? uint8ArrayFromString(data) : data
    await pubsub.publish(topic, payload)
  }

  getSubscriberCount(topic: string): number {
    const pubsub = this.node.services.pubsub as PubSubService
    if (!pubsub) return 0
    try {
      return pubsub.getSubscribers(topic).length
    } catch {
      // PubSub can be temporarily unavailable during startup/shutdown.
      return 0
    }
  }

  async waitForSubscribers(topic: string, options: WaitForSubscribersOptions = {}): Promise<boolean> {
    const minSubscribers = options.minSubscribers ?? 1
    const timeoutMs = options.timeoutMs ?? 5000
    const pollIntervalMs = options.pollIntervalMs ?? 250
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      if (this.getSubscriberCount(topic) >= minSubscribers) {
        return true
      }
      await sleep(pollIntervalMs)
    }

    return this.getSubscriberCount(topic) >= minSubscribers
  }

  static formatData(data: Uint8Array): string {
    try {
      return uint8ArrayToString(data)
    } catch {
      return Buffer.from(data).toString('hex')
    }
  }
}

export default PubSubManager

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
