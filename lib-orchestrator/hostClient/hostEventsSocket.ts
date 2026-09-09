import { WebSocket } from 'ws'

import type {
  HostDescriptor,
  HostEvent,
  HostWsClientMsg,
  HostWsServerMsg,
} from '../../app-host/app/wire/hostWire.js'
import type { HostDebugStatus } from '../sessionManager/sessionManagerApi.types'
import { ErrorText } from '../shared/errorText'

export interface HostEventsSocketDeps {
  onEvent: (event: HostEvent) => void
  /** The cursor cannot be resumed: the caller reloads the whole listing before believing anything. */
  onResync: () => void
  onConnected: () => void
  onDisconnected: () => void
  onError: (message: string) => void
}

/**
 * The single socket this client keeps on a Host, subscribed to `runtime.*` events and nothing else.
 * The terminal frames the same wire carries belong to an attach, and an attach has a socket of its
 * own: `TerminalAttachSocket`, one per attach, because the Host serves one attach per connection.
 */
export class HostEventsSocket {
  private static readonly backoffMillisecondsConst = [250, 1_000, 2_500, 10_000] as const
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private descriptor: HostDescriptor | null = null
  private hostInstanceId: string | null = null
  private cursor: number | null = null
  private resyncOwed = false
  private attempt = 0
  private connectedValue = false
  private lastSubscribed: HostDebugStatus['eventsSocket']['lastSubscribed'] = null

  constructor(private readonly deps: HostEventsSocketDeps) {}

  /**
   * A different Host process invalidates the cursor: revisions restart at zero there, so resuming
   * after one would skip everything the new Host has already published. The first connect of all
   * counts as such a change, which is what makes the caller take a full listing before it trusts an
   * event.
   */
  connect(descriptor: HostDescriptor): void {
    if (descriptor.hostInstanceId !== this.hostInstanceId) {
      this.hostInstanceId = descriptor.hostInstanceId
      this.cursor = null
      this.resyncOwed = true
    }
    this.descriptor = descriptor
    this.attempt = 0
    this.open()
  }

  /** Detach: the Host keeps every runtime, and this client simply stops listening. */
  close(): void {
    this.clearTimer()
    this.descriptor = null
    this.dropSocket()
    this.setConnected(false)
  }

  connected(): boolean {
    return this.connectedValue
  }

  /** Why this socket is where it is: the cursor it holds, what it owes, and its last subscribe. */
  debugView(): HostDebugStatus['eventsSocket'] {
    return {
      connected: this.connectedValue,
      cursor: this.cursor,
      resyncOwed: this.resyncOwed,
      reconnectAttempt: this.attempt,
      lastSubscribed: this.lastSubscribed,
    }
  }

  private open(): void {
    const descriptor = this.descriptor
    if (descriptor === null) return
    this.clearTimer()
    this.dropSocket()
    const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
    })
    this.socket = socket
    socket.on('open', () => this.onOpen(socket))
    socket.on('message', (raw: Buffer) => {
      // An unknown frame is a defect worth failing loudly on, but this runs on the socket's emitter
      // in the client's main process, where an escaping throw takes the whole client down.
      try { this.onMessage(socket, raw) }
      catch (error) { this.deps.onError(`The Host events socket: ${ErrorText.of(error)}`) }
    })
    socket.on('error', (error: Error) =>
      this.onFailure(socket, `the events socket failed (${ErrorText.of(error)})`))
    socket.on('close', () => this.onFailure(socket, 'the Host closed the events socket'))
  }

  private onOpen(socket: WebSocket): void {
    if (socket !== this.socket) return
    const frame: HostWsClientMsg = { type: 'events.subscribe', afterRevision: this.cursor ?? 0 }
    socket.send(JSON.stringify(frame))
  }

  private onMessage(socket: WebSocket, raw: Buffer): void {
    if (socket !== this.socket) return
    let frame: HostWsServerMsg
    try {
      frame = JSON.parse(raw.toString('utf8')) as HostWsServerMsg
    } catch (error) {
      this.deps.onError(`The Host sent an unreadable events frame (${ErrorText.of(error)})`)
      return
    }
    if (frame.type === 'events.subscribed')
      this.onSubscribed(frame)
    else if (frame.type === 'event')
      this.onHostEvent(frame.event)
    else if (frame.type === 'error')
      this.deps.onError(`The Host refused an events frame: ${frame.code} - ${frame.message}`)
    else if (frame.type === 'terminal.attached'
      || frame.type === 'terminal.snapshot'
      || frame.type === 'terminal.delta'
      || frame.type === 'terminal.data'
      || frame.type === 'terminal.resize'
      || frame.type === 'terminal.exit'
      || frame.type === 'terminal.stream-truncated')
      // This socket never attaches, so a terminal frame is not ours to read. `TerminalAttachment`
      // consumes them, on the connection its own attach opened.
      return
    else
      throw new Error(`Unknown Host frame: ${JSON.stringify((frame as { type: unknown }).type)}`)
  }

  private onSubscribed(frame: Extract<HostWsServerMsg, { type: 'events.subscribed' }>): void {
    this.attempt = 0
    this.lastSubscribed = {
      at: Date.now(),
      throughRevision: frame.throughRevision,
      replayed: frame.replay.length,
      truncated: frame.truncated,
    }
    for (const event of frame.replay) this.onHostEvent(event)
    this.cursor = Math.max(this.cursor ?? 0, frame.throughRevision)
    // One signal for both reasons: a cursor dropped with the old Host and a replay window that no
    // longer reaches it are the same answer, and the caller must not reload twice for one reconnect.
    const owed = this.resyncOwed || frame.truncated
    this.resyncOwed = false
    this.setConnected(true)
    if (owed) this.deps.onResync()
  }

  private onHostEvent(event: HostEvent): void {
    if (this.cursor !== null && event.revision <= this.cursor) return
    this.cursor = event.revision
    this.deps.onEvent(event)
  }

  private onFailure(socket: WebSocket, detail: string): void {
    if (socket !== this.socket) return
    this.socket = null
    try { socket.close() } catch { /* already gone */ }
    const wasConnected = this.connectedValue
    this.setConnected(false)
    if (this.descriptor === null) return
    if (wasConnected) this.deps.onError(`The Host events socket dropped: ${detail}`)
    const ladder = HostEventsSocket.backoffMillisecondsConst
    const delay = ladder[Math.min(this.attempt, ladder.length - 1)]
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, delay)
    this.timer.unref()
  }

  private setConnected(value: boolean): void {
    if (value === this.connectedValue) return
    this.connectedValue = value
    if (value) this.deps.onConnected()
    else this.deps.onDisconnected()
  }

  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    // The listeners stay attached: removing them from a socket that is still connecting leaves an
    // `error` with no listener, which an EventEmitter turns into a throw. They no-op on identity.
    try { socket.close() } catch { /* already closing */ }
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
