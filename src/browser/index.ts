import '../runtime-polyfills.js'
import { createLibp2p, type Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { mplex } from '@libp2p/mplex'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { floodsub } from '@libp2p/floodsub'
import { NETCAT_PROTOCOL } from '../netcat-protocol.js'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { Stream } from '@libp2p/interface'
import { Uint8ArrayList } from 'uint8arraylist'

export interface BrowserNetcatOptions {
  /** Custom multiaddresses to listen on (default: ['/ip4/0.0.0.0/tcp/0/ws']) */
  listen?: string[]
  /** Bootstrap peers to connect to */
  bootstrap?: string[]
}

export interface NetcatSession {
  /** The stream for data transfer */
  stream: Stream
  /** Remote peer ID */
  peerId: string
}

export interface PubSubMessage {
  topic: string
  data: Uint8Array
  from?: string
  timestamp?: number
}

type PubSubMessageEventDetail = {
  topic: string
  data: Uint8Array
}

type PubSubService = {
  subscribe: (topic: string) => void
  unsubscribe: (topic: string) => void
  publish: (topic: string, data: Uint8Array) => Promise<unknown>
  getSubscribers: (topic: string) => Array<{ toString(): string }>
  addEventListener: (type: 'message', listener: (evt: CustomEvent<PubSubMessageEventDetail>) => void) => void
  removeEventListener: (type: 'message', listener: (evt: CustomEvent<PubSubMessageEventDetail>) => void) => void
}

/**
 * Browser-compatible P2P Netcat utility
 * 
 * Provides peer-to-peer communication and pub/sub messaging in the browser
 * using WebSockets and libp2p.
 */
export class BrowserP2pNetcat {
  private node: Libp2p | null = null
  private activeSession: NetcatSession | null = null
  private subscriptions = new Map<string, (msg: PubSubMessage) => void>()

  constructor(private options: BrowserNetcatOptions = {}) {}

  /**
   * Initialize and start the libp2p node
   */
  async start(): Promise<void> {
    if (this.node) {
      throw new Error('Node is already started')
    }

    this.node = await createLibp2p({
      addresses: {
        listen: this.options.listen ?? ['/ip4/0.0.0.0/tcp/0/ws']
      },
      transports: [webSockets()],
      streamMuxers: [mplex()],
      connectionEncrypters: [noise()],
      services: {
        identify: identify(),
        pubsub: floodsub()
      }
    })

    await this.node.start()

    // Connect to bootstrap peers if provided
    if (this.options.bootstrap) {
      for (const addr of this.options.bootstrap) {
        try {
          await this.node.dial(multiaddr(addr))
          console.log(`Connected to bootstrap peer: ${addr}`)
        } catch (err) {
          console.warn(`Failed to connect to bootstrap peer ${addr}:`, err)
        }
      }
    }
  }

  /**
   * Stop the libp2p node and clean up resources
   */
  async stop(): Promise<void> {
    if (!this.node) return

    try {
      if (this.activeSession) {
        await this.activeSession.stream.close()
        this.activeSession = null
      }

      // Unsubscribe from all topics
      const pubsub = this.node.services.pubsub as PubSubService
      for (const [topic] of this.subscriptions) {
        pubsub.unsubscribe(topic)
      }
      this.subscriptions.clear()

      await this.node.stop()
    } finally {
      this.node = null
    }
  }

  /**
   * Get the current peer ID
   */
  getPeerId(): string {
    if (!this.node) {
      throw new Error('Node is not started')
    }
    return this.node.peerId.toString()
  }

  /**
   * Get current listening addresses
   */
  getListenAddresses(): string[] {
    if (!this.node) {
      throw new Error('Node is not started')
    }
    return this.node.getMultiaddrs().map((m) => m.toString())
  }

  /**
   * Connect to a peer by multiaddress
   */
  async connect(address: string): Promise<void> {
    if (!this.node) {
      throw new Error('Node is not started')
    }

    await this.node.dial(multiaddr(address))
  }

  /**
   * Handle incoming netcat connections
   */
  handleIncoming(onSession: (session: NetcatSession) => void | Promise<void>): void {
    if (!this.node) {
      throw new Error('Node is not started')
    }

    this.node.handle(NETCAT_PROTOCOL, async (stream, connection) => {
      const session: NetcatSession = {
        stream,
        peerId: connection.remotePeer.toString()
      }
      this.activeSession = session
      await onSession(session)
    })
  }

  /**
   * Connect to a remote peer for netcat communication
   */
  async dialNetcat(remotePeerId: string): Promise<NetcatSession> {
    if (!this.node) {
      throw new Error('Node is not started')
    }

    const remote = peerIdFromString(remotePeerId)
    const stream = await this.node.dialProtocol(remote, NETCAT_PROTOCOL)
    const session: NetcatSession = { stream, peerId: remotePeerId }
    this.activeSession = session
    return session
  }

  /**
   * Send data through the active netcat session
   */
  async sendNetcat(data: string | Uint8Array): Promise<void> {
    if (!this.activeSession) {
      throw new Error('No active netcat session')
    }

    const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data
    while (!this.activeSession.stream.send(payload)) {
      await this.activeSession.stream.onDrain()
    }
  }

  /**
   * Read data from the active netcat session
   */
  async *readNetcat(): AsyncGenerator<Uint8Array> {
    if (!this.activeSession) {
      throw new Error('No active netcat session')
    }

    for await (const chunk of this.activeSession.stream) {
      yield chunk instanceof Uint8Array ? chunk : chunk.subarray()
    }
  }

  /**
   * Subscribe to a PubSub topic
   */
  async subscribe(topic: string, onMessage: (msg: PubSubMessage) => void): Promise<() => void> {
    if (!this.node) {
      throw new Error('Node is not started')
    }

    const pubsub = this.node.services.pubsub as PubSubService
    if (!pubsub) {
      throw new Error('PubSub service is not configured on this node')
    }

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
    this.subscriptions.set(topic, onMessage)

    return () => {
      pubsub.removeEventListener('message', listener)
      pubsub.unsubscribe(topic)
      this.subscriptions.delete(topic)
    }
  }

  /**
   * Publish a message to a PubSub topic
   */
  async publish(topic: string, data: string | Uint8Array): Promise<void> {
    if (!this.node) {
      throw new Error('Node is not started')
    }

    const pubsub = this.node.services.pubsub as PubSubService
    if (!pubsub) {
      throw new Error('PubSub service is not configured on this node')
    }

    const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await pubsub.publish(topic, payload)
  }

  /**
   * Get the number of subscribers for a topic
   */
  getSubscriberCount(topic: string): number {
    if (!this.node) {
      throw new Error('Node is not started')
    }

    const pubsub = this.node.services.pubsub as PubSubService
    if (!pubsub) return 0

    try {
      return pubsub.getSubscribers(topic).length
    } catch {
      return 0
    }
  }

  /**
   * Check if the node is started
   */
  isStarted(): boolean {
    return this.node !== null
  }

  /**
   * Get the current active session
   */
  getActiveSession(): NetcatSession | null {
    return this.activeSession
  }

  /**
   * Close the current active session
   */
  async closeSession(): Promise<void> {
    if (this.activeSession) {
      await this.activeSession.stream.close()
      this.activeSession = null
    }
  }
}

/**
 * Utility function to convert Uint8Array to string safely
 */
export function uint8ArrayToString(data: Uint8Array): string {
  try {
    return new TextDecoder().decode(data)
  } catch {
    return Buffer.from(data).toString('hex')
  }
}

/**
 * Utility function to convert string to Uint8Array
 */
export function stringToUint8Array(data: string): Uint8Array {
  return new TextEncoder().encode(data)
}

export default BrowserP2pNetcat
