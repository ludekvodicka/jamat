import { WebSocket } from 'ws'

import { ControllerLeaseManager } from '../controller/controllerLeaseManager.js'
import { EventHub } from '../events/eventHub.js'
import type { EventSocket } from '../events/eventHub.js'
import { SessionError } from '../sessions/sessionError.js'
import type { SessionErrorCode } from '../sessions/sessionError.js'
import { SessionManager } from '../sessions/sessionManager.js'
import type { TerminalInstanceEvent } from '../terminal/terminal.types.js'
import {
  HostWireConst,
  type HostWsClientMsg,
  type HostWsErrorCode,
  type HostWsServerMsg,
  type RuntimeRef,
} from '../wire/hostWire.js'

export interface AttachSocket extends EventSocket {
  readonly bufferedAmount: number
  readonly readyState: number
  /** How an attach that cannot be served is ended: one socket is one attach, so it goes with it. */
  close(): void
}

/** One client attached to one terminal. Owns its writer authority and its own backpressure. */
export class AttachConnection {
  private static readonly backpressureBytesConst = 1 * 1_024 * 1_024
  private attachedRef: RuntimeRef | null = null
  private controllerLeaseId: string | null = null
  private writer = false
  private unsubscribeTerminal: (() => void) | null = null
  private truncated: Extract<HostWsServerMsg, { type: 'terminal.stream-truncated' }> | null = null
  private truncationTimer: ReturnType<typeof setTimeout> | null = null
  private terminalBuffer: TerminalInstanceEvent[] | null = null

  constructor(
    private readonly webSocket: AttachSocket,
    private readonly sessions: SessionManager,
    private readonly leases: ControllerLeaseManager,
    private readonly events: EventHub,
  ) {}

  async onMessage(raw: Buffer): Promise<void> {
    let parsed: unknown
    try { parsed = JSON.parse(raw.toString('utf8')) }
    catch {
      this.error('bad-request', 'invalid JSON frame')
      return
    }
    if (!parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || typeof (parsed as { type?: unknown }).type !== 'string') {
      this.error('bad-request', 'frame must be an object with a string type')
      return
    }
    try { await this.dispatch(parsed as HostWsClientMsg) }
    catch (error) { this.report(error) }
  }

  /** What a thrown failure is called on the wire. A `SessionError` names itself; nothing else does. */
  private report(error: unknown): void {
    if (error instanceof SessionError) {
      this.error(AttachConnection.wsCodeFor(error.code), error.message)
      return
    }
    this.error('bad-request', error instanceof Error ? error.message : String(error))
  }

  /**
   * A stale ref must not read as a malformed frame. Collapsing `conflict` into `bad-request` left a
   * client that attached to a superseded generation unable to tell "resolve a fresh ref and re-attach"
   * from "your JSON is broken", while the HTTP surface has always distinguished 400 from 409.
   */
  private static wsCodeFor(code: SessionErrorCode): HostWsErrorCode {
    if (code === 'not-found') return 'unknown-runtime'
    else if (code === 'conflict') return 'conflict'
    else if (code === 'invalid-request' || code === 'limit-exceeded') return 'bad-request'
    else
      throw new Error(`Unknown session error code: ${JSON.stringify(code)}`)
  }

  teardown(): void {
    this.detach()
    this.events.unsubscribe(this.webSocket)
  }

  private async dispatch(message: HostWsClientMsg): Promise<void> {
    if (message.type === 'terminal.attach')
      await this.attach(message)
    else if (message.type === 'terminal.detach')
      this.detach()
    else if (message.type === 'terminal.input')
      this.input(message.data)
    else if (message.type === 'terminal.resize')
      this.resize(message.cols, message.rows)
    else if (message.type === 'events.subscribe')
      this.subscribeEvents(message.afterRevision)
    else
      throw new Error(`Unknown frame type: ${JSON.stringify((message as { type: unknown }).type)}`)
  }

  private async attach(
    message: Extract<HostWsClientMsg, { type: 'terminal.attach' }>,
  ): Promise<void> {
    if (message.role !== undefined
      && message.role !== 'interactive'
      && message.role !== 'observer')
      throw new Error('role must be interactive or observer')
    if (message.sinceSeq !== undefined
      && (!Number.isInteger(message.sinceSeq) || message.sinceSeq < 0))
      throw new Error('sinceSeq must be a non-negative integer')
    if (message.outputEpoch !== undefined
      && (!Number.isInteger(message.outputEpoch) || message.outputEpoch < 1))
      throw new Error('outputEpoch must be a positive integer')
    const session = this.sessions.session(message.target)

    this.detach()
    this.attachedRef = { ...message.target }
    this.writer = message.role !== 'observer'
    if (this.writer) {
      if (typeof message.controllerLeaseId !== 'string') {
        this.writer = false
        this.error('controller-required', 'Interactive attach requires controllerLeaseId')
      } else {
        try {
          this.leases.require(message.controllerLeaseId)
          this.controllerLeaseId = message.controllerLeaseId
        }
        catch (error) {
          this.writer = false
          this.error('controller-required', error instanceof Error ? error.message : String(error))
        }
      }
    }
    if (this.writer
      && session.alive
      && Number.isFinite(message.cols)
      && Number.isFinite(message.rows))
      this.sessions.terminalResize(this.attachedRef, message.cols!, message.rows!)
    this.send({
      type: 'terminal.attached',
      writer: this.writer,
      session: this.sessions.session(this.attachedRef),
    })

    this.terminalBuffer = []
    this.unsubscribeTerminal = this.sessions.subscribeTerminal((event) => this.onTerminalEvent(event))
    // Past the ack the connection is subscribed and buffering, so a throw here would leave it
    // half-attached: every later event of this generation, `terminal.exit` included, would be buffered
    // forever and the client would sit on an attach that never produces a snapshot or an exit.
    try { await this.sendInitialProjection(message, session.generation) }
    catch (error) {
      /*
       * The socket goes with the attach, and that is the whole point of closing it here.
       *
       * The ack is already out, so the client believes it is attached AND a writer. Everything it
       * sends afterwards is answered `bad-request: not attached` - which a client is right to read
       * as one bad frame rather than as the end of an attach, because that is what the code means
       * everywhere else. So it kept a dead attach for the life of the panel: every keystroke
       * reported as sent, every resize as applied, the screen frozen on the last frame that got
       * through, and nothing said on either side. Measured on 2026-09-07 with two surfaces on one
       * remote session: 123 keystrokes accepted by the client after the Host had stopped listening.
       *
       * One socket is one attach, so ending the socket is a signal both sides already agree on and
       * it needs no new error code. The client's own reconnect ladder then asks again, with the
       * cursor it kept, which is the recovery this failure never had.
       */
      this.detach()
      this.report(error)
      this.webSocket.close()
    }
  }

  private async sendInitialProjection(
    message: Extract<HostWsClientMsg, { type: 'terminal.attach' }>,
    generation: number,
  ): Promise<void> {
    if (!this.attachedRef) return
    let throughSeq: number
    let throughEpoch: number
    if (message.sinceSeq === undefined || message.outputEpoch === undefined) {
      const projection = await this.sessions.terminalSnapshot(this.attachedRef)
      this.send({
        type: 'terminal.snapshot',
        projection,
      })
      throughSeq = projection.outputSeq
      throughEpoch = projection.outputEpoch
    } else {
      const delta = this.sessions.terminalDelta(
        this.attachedRef,
        message.outputEpoch,
        message.sinceSeq,
      )
      this.send({
        type: 'terminal.delta',
        runtimeSessionId: this.attachedRef.runtimeSessionId,
        generation,
        outputEpoch: delta.outputEpoch,
        data: delta.data,
        outputSeq: delta.outputSeq,
        truncated: delta.truncated,
      })
      throughSeq = delta.outputSeq
      throughEpoch = delta.outputEpoch
    }
    // a close or detach during the awaits above already dropped this attach, buffer included
    const buffered: TerminalInstanceEvent[] | null = this.terminalBuffer
    if (buffered === null) return
    this.terminalBuffer = null
    for (const event of buffered) {
      if (event.type === 'data'
        && event.outputEpoch === throughEpoch
        && event.outputSeq <= throughSeq)
        continue
      this.deliverTerminalEvent(event)
    }
  }

  private input(data: string): void {
    const target = this.requireWriter()
    if (!target) return
    if (typeof data !== 'string')
      throw new Error('input data must be a string')
    if (Buffer.byteLength(data) > HostWireConst.maxInputBytes)
      throw new Error(`input exceeds ${HostWireConst.maxInputBytes} bytes`)
    try { this.sessions.terminalWrite(target, data) }
    catch (error) {
      if (error instanceof SessionError) {
        this.revokeWriter(error.message)
        return
      }
      throw error
    }
  }

  private resize(cols: number, rows: number): void {
    const target = this.requireWriter()
    if (!target) return
    if (!Number.isFinite(cols) || !Number.isFinite(rows))
      throw new Error('cols and rows must be numbers')
    try { this.sessions.terminalResize(target, cols, rows) }
    catch (error) {
      if (error instanceof SessionError) {
        this.revokeWriter(error.message)
        return
      }
      throw error
    }
  }

  private subscribeEvents(afterRevision: number | undefined): void {
    if (afterRevision !== undefined
      && (!Number.isInteger(afterRevision) || afterRevision < 0))
      throw new Error('afterRevision must be a non-negative integer')
    const replay = this.events.subscribe(this.webSocket, afterRevision ?? 0)
    this.send({ type: 'events.subscribed', ...replay })
  }

  private onTerminalEvent(event: TerminalInstanceEvent): void {
    if (event.runtimeSessionId !== this.attachedRef?.runtimeSessionId
      || event.generation !== this.attachedRef.generation)
      return
    if (this.terminalBuffer) {
      this.terminalBuffer.push(event)
      return
    }
    this.deliverTerminalEvent(event)
  }

  private deliverTerminalEvent(event: TerminalInstanceEvent): void {
    if (event.type === 'data') {
      if (this.webSocket.bufferedAmount > AttachConnection.backpressureBytesConst) {
        this.truncated = {
          type: 'terminal.stream-truncated',
          runtimeSessionId: event.runtimeSessionId,
          generation: event.generation,
          outputEpoch: event.outputEpoch,
          outputSeq: event.outputSeq,
        }
        this.scheduleTruncationFlush()
        return
      }
      this.flushTruncation()
      this.send({
        type: 'terminal.data',
        runtimeSessionId: event.runtimeSessionId,
        generation: event.generation,
        outputEpoch: event.outputEpoch,
        delta: event.delta,
        outputSeq: event.outputSeq,
        lastOutputAt: event.lastOutputAt,
      })
    } else if (event.type === 'resize')
      this.send({
        type: 'terminal.resize',
        runtimeSessionId: event.runtimeSessionId,
        generation: event.generation,
        cols: event.cols,
        rows: event.rows,
      })
    else if (event.type === 'exit') {
      // detach() below drops a pending marker, so the last thing a client hears about the missing tail
      // has to be said before the exit rather than after it.
      this.flushTruncation()
      this.send({
        type: 'terminal.exit',
        runtimeSessionId: event.runtimeSessionId,
        generation: event.generation,
        exitCode: event.exitCode,
      })
      this.detach()
    }
    else
      throw new Error(`Unknown terminal event: ${JSON.stringify(event)}`)
  }

  /** Revalidated on every write: an expired or replaced lease revokes the writer, it does not queue. */
  private requireWriter(): RuntimeRef | null {
    if (!this.attachedRef) {
      this.error('bad-request', 'not attached')
      return null
    }
    if (!this.writer) {
      this.error('not-writer', 'read-only attach')
      return null
    }
    if (!this.controllerLeaseId) {
      this.revokeWriter('Controller lease is missing')
      return null
    }
    try { this.leases.require(this.controllerLeaseId) }
    catch (error) {
      this.revokeWriter(error instanceof Error ? error.message : String(error))
      return null
    }
    return { ...this.attachedRef }
  }

  private detach(): void {
    this.unsubscribeTerminal?.()
    this.unsubscribeTerminal = null
    this.attachedRef = null
    this.controllerLeaseId = null
    this.writer = false
    this.truncated = null
    if (this.truncationTimer)
      clearTimeout(this.truncationTimer)
    this.truncationTimer = null
    this.terminalBuffer = null
  }

  private scheduleTruncationFlush(): void {
    if (this.truncationTimer)
      return
    this.truncationTimer = setTimeout(() => {
      this.truncationTimer = null
      if (!this.truncated || this.webSocket.readyState !== WebSocket.OPEN)
        return
      if (this.webSocket.bufferedAmount > AttachConnection.backpressureBytesConst) {
        this.scheduleTruncationFlush()
        return
      }
      this.flushTruncation()
    }, 25)
    this.truncationTimer.unref()
  }

  private flushTruncation(): void {
    if (!this.truncated)
      return
    if (this.truncationTimer)
      clearTimeout(this.truncationTimer)
    this.truncationTimer = null
    this.send(this.truncated)
    this.truncated = null
  }

  private send(message: HostWsServerMsg): void {
    try { this.webSocket.send(JSON.stringify(message)) } catch {}
  }

  private error(code: HostWsErrorCode, message: string): void {
    this.send({ type: 'error', code, message })
  }

  private revokeWriter(message: string): void {
    this.writer = false
    this.controllerLeaseId = null
    this.error('not-writer', message)
  }
}
