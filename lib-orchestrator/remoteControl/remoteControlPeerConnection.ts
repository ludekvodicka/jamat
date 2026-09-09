import { WebSocket, type RawData } from 'ws'

import type {
  RemoteControlPeerApplicationMessage,
  RemoteControlPeerCapability,
  RemoteControlPeerEncryptedMessage,
  RemoteControlPeerInboundApplicationMessage,
  RemoteControlPeerIdentity,
} from './remoteControlPeerApi.types'
import type { RemoteControlPeerCodecResult } from './remoteControlPeerCodec'

export interface RemoteControlPeerConnectionOptions {
  heartbeatIntervalMilliseconds?: number
  heartbeatTimeoutMilliseconds?: number
  now?: () => number
  onError?: (message: string) => void
}

export class RemoteControlPeerConnection {
  private static readonly heartbeatIntervalMillisecondsConst = 10_000
  private static readonly heartbeatTimeoutMillisecondsConst = 30_000

  readonly connectionId: string
  readonly remoteIdentity: RemoteControlPeerIdentity
  readonly capabilities: readonly RemoteControlPeerCapability[]
  private readonly messageListeners =
    new Set<(message: RemoteControlPeerInboundApplicationMessage) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly now: () => number
  private readonly heartbeatTimeoutMilliseconds: number
  private readonly heartbeat: ReturnType<typeof setInterval>
  private lastReceivedAt: number
  private closed = false

  constructor(
    private readonly socket: WebSocket,
    private readonly codec: RemoteControlPeerCodecResult,
    options?: RemoteControlPeerConnectionOptions,
  ) {
    this.connectionId = codec.connectionId
    this.remoteIdentity = structuredClone(codec.remoteIdentity)
    this.capabilities = [...codec.capabilities]
    this.now = options?.now ?? Date.now
    this.lastReceivedAt = this.now()
    this.heartbeatTimeoutMilliseconds = options?.heartbeatTimeoutMilliseconds
      ?? RemoteControlPeerConnection.heartbeatTimeoutMillisecondsConst
    const interval = options?.heartbeatIntervalMilliseconds
      ?? RemoteControlPeerConnection.heartbeatIntervalMillisecondsConst
    if (interval <= 0 || this.heartbeatTimeoutMilliseconds <= interval)
      throw new Error('Remote peer heartbeat timing is invalid')
    this.socket.on('message', (data, isBinary) => this.receive(data, isBinary, options?.onError))
    this.socket.once('close', () => this.finishClose())
    this.socket.once('error', () => this.finishClose())
    this.heartbeat = setInterval(() => this.heartbeatTick(), interval)
    this.heartbeat.unref?.()
  }

  isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN
  }

  send(message: RemoteControlPeerApplicationMessage): boolean {
    return this.sendEncrypted(message)
  }

  onMessage(listener: (message: RemoteControlPeerInboundApplicationMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    try { this.socket.close(1000) } catch {}
    this.finishClose()
  }

  private receive(data: RawData, isBinary: boolean, report?: (message: string) => void): void {
    if (this.closed) return
    try {
      if (isBinary) throw new Error('Remote peer sent a binary frame')
      const message = this.codec.inbound.open(JSON.parse(data.toString()))
      this.lastReceivedAt = this.now()
      if (message.type === 'heartbeat-ping')
        this.sendEncrypted({ type: 'heartbeat-pong', sentAt: message.sentAt })
      else if (message.type === 'heartbeat-pong') return
      else
        for (const listener of this.messageListeners) listener(message)
    } catch (error) {
      try { report?.(`Remote peer frame refused: ${error instanceof Error ? error.message : String(error)}`) }
      catch {}
      try { this.socket.close(1008) } catch {}
      this.finishClose()
    }
  }

  private heartbeatTick(): void {
    if (!this.isOpen()) {
      this.finishClose()
      return
    }
    const now = this.now()
    if (now - this.lastReceivedAt > this.heartbeatTimeoutMilliseconds) {
      try { this.socket.close(4000) } catch {}
      this.finishClose()
      return
    }
    this.sendEncrypted({ type: 'heartbeat-ping', sentAt: now })
  }

  private sendEncrypted(message: RemoteControlPeerEncryptedMessage): boolean {
    if (!this.isOpen()) return false
    try {
      this.socket.send(JSON.stringify(this.codec.outbound.seal(message)))
      return true
    } catch {
      this.finishClose()
      return false
    }
  }

  private finishClose(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    for (const listener of this.closeListeners) {
      try { listener() } catch {}
    }
    this.closeListeners.clear()
    this.messageListeners.clear()
  }
}
