import { WebSocket } from 'ws'

import type {
  HostDescriptor,
  HostWsClientMsg,
  HostWsServerMsg,
} from '../../app-host/app/wire/hostWire.js'
import { ErrorText } from '../shared/errorText'

export interface TerminalAttachSocketDeps {
  onFrame: (frame: HostWsServerMsg) => void
  /** Closed, dropped, unreadable, or a handler that threw. Reconnecting is the caller's policy. */
  onClosed: (detail: string) => void
}

/**
 * One socket is one attach. The Host serves a single attach per connection and a second
 * `terminal.attach` on the same one silently detaches the first, so nothing here multiplexes.
 *
 * It speaks the wire and holds no policy: which runtime, which lease, when to reconnect and what a
 * cursor means all belong to the caller. It never subscribes to events either, which is what keeps
 * it apart from `HostEventsSocket` on the same wire.
 */
export class TerminalAttachSocket {
  private socket: WebSocket | null = null
  private pending: string[] = []
  private opened = false

  constructor(private readonly deps: TerminalAttachSocketDeps) {}

  connect(descriptor: HostDescriptor): void {
    this.dropSocket()
    this.pending = []
    this.opened = false
    const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
    })
    this.socket = socket
    socket.on('open', () => this.onOpen(socket))
    socket.on('message', (raw: Buffer) => this.onMessage(socket, raw))
    socket.on('error', (error: Error) =>
      this.onClosed(socket, `the attach socket failed (${ErrorText.of(error)})`))
    socket.on('close', () => this.onClosed(socket, 'the Host closed the attach socket'))
  }

  /**
   * Queued while the socket is still connecting rather than dropped. The attach frame is sent the
   * moment the caller has one, which is before any `open` event, and the V1 host proof of concept
   * measured what dropping it instead costs: a frame written to a CONNECTING socket is lost without
   * a word, and the attach that carries the geometry is exactly the frame that must not be.
   */
  send(message: HostWsClientMsg): void {
    const socket = this.socket
    if (socket === null) return
    const payload = JSON.stringify(message)
    if (!this.opened) {
      this.pending.push(payload)
      return
    }
    socket.send(payload)
  }

  /** The caller is done: no `onClosed`, because nobody is being told about their own decision. */
  close(): void {
    this.dropSocket()
    this.pending = []
    this.opened = false
  }

  private onOpen(socket: WebSocket): void {
    if (socket !== this.socket) return
    this.opened = true
    for (const payload of this.pending.splice(0)) socket.send(payload)
  }

  private onMessage(socket: WebSocket, raw: Buffer): void {
    if (socket !== this.socket) return
    let frame: HostWsServerMsg
    try {
      frame = JSON.parse(raw.toString('utf8')) as HostWsServerMsg
    } catch (error) {
      this.onClosed(socket, `the Host sent an unreadable attach frame (${ErrorText.of(error)})`)
      return
    }
    // The handler runs on the socket's emitter in the client's main process, where an escaping throw
    // takes the whole client down. It is also where the exhaustive frame branching lives, so a frame
    // that belongs to no attach reaches us as a throw: that ends this attach and nothing else.
    try {
      this.deps.onFrame(frame)
    } catch (error) {
      this.onClosed(socket, `an attach frame could not be handled (${ErrorText.of(error)})`)
    }
  }

  private onClosed(socket: WebSocket, detail: string): void {
    if (socket !== this.socket) return
    this.socket = null
    this.opened = false
    this.pending = []
    try { socket.close() } catch { /* already gone */ }
    this.deps.onClosed(detail)
  }

  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    // The listeners stay attached: removing them from a socket that is still connecting leaves an
    // `error` with no listener, which an EventEmitter turns into a throw. They no-op on identity.
    try { socket.close() } catch { /* already closing */ }
  }
}
