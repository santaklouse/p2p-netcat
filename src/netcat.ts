import type { Libp2p } from 'libp2p'
import type { Stream } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { Uint8ArrayList } from 'uint8arraylist'
import { NETCAT_PROTOCOL } from './netcat-protocol.js'

export interface NetcatSession {
  stream: Stream
  peerId: string
}

function chunkToUint8(chunk: Uint8Array | Uint8ArrayList): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : chunk.subarray()
}

export class P2pNetcat {
  private activeSession: NetcatSession | null = null

  constructor(private readonly node: Libp2p) {}

  getPeerId(): string {
    return this.node.peerId.toString()
  }

  handleIncoming(onSession: (s: NetcatSession) => void | Promise<void>): void {
    void this.node.handle(NETCAT_PROTOCOL, async (stream, connection) => {
      const session: NetcatSession = {
        stream,
        peerId: connection.remotePeer.toString()
      }
      this.activeSession = session
      await onSession(session)
    })
  }

  async dialPeer(remotePeerId: string): Promise<NetcatSession> {
    const remote = peerIdFromString(remotePeerId)
    const stream = await this.node.dialProtocol(remote, NETCAT_PROTOCOL)
    const session: NetcatSession = { stream, peerId: remotePeerId }
    this.activeSession = session
    return session
  }

  async pipeStdinToStream(session: NetcatSession): Promise<void> {
    const { stream } = session
    try {
      for await (const chunk of process.stdin) {
        const buf = chunk as Buffer
        let data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        while (true) {
          if (stream.send(data)) break
          await stream.onDrain()
        }
      }
    } finally {
      await stream.close()
    }
  }

  async pipeStreamToStdout(session: NetcatSession): Promise<void> {
    const { stream } = session
    try {
      for await (const chunk of stream) {
        const u8 = chunkToUint8(chunk)
        await new Promise<void>((resolve, reject) => {
          process.stdout.write(u8, (err) => (err ? reject(err) : resolve()))
        })
      }
    } finally {
      this.activeSession = null
    }
  }

  async close(): Promise<void> {
    this.activeSession = null
    await this.node.stop()
  }
}

export default P2pNetcat
