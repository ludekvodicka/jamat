import type {
  HostDescriptor,
  HostWireConst,
  HostWsClientMsg,
  HostWsServerMsg,
  RuntimeRef,
} from '../../../app-host/app/wire/hostWire.js'
import type { TerminalAttachSocketDeps } from '../../hostClient/terminalAttachSocket'
import type { TerminalFrame } from '../sessionManagerApi.types'
import { TerminalInputChunks } from './terminalInputChunks'

/** All an attachment needs of a socket: one attach, spoken and closed. */
export interface TerminalSocket {
  connect(descriptor: HostDescriptor): void
  send(message: HostWsClientMsg): void
  close(): void
}

export type TerminalSocketFactory = (deps: TerminalAttachSocketDeps) => TerminalSocket

/** Where the ref came from matters to the caller: an ended session and an unknown one differ. */
export type TerminalRefResolution =
  /**
   * `alive` is false for a runtime the Host still HAS and no longer runs. Such a session is worth
   * attaching to: the Host keeps its output, and the last screen a process printed before it died is
   * the whole answer to why it died. It is attached to as an observer, because there is nothing left
   * to type at.
   */
  | { ok: true; ref: RuntimeRef; alive: boolean }
  | { ok: false; code: 'not-live' | 'unknown-session' }

export interface TerminalAttachmentDeps {
  sessionId: string
  descriptorOf: () => HostDescriptor | null
  leaseIdOf: () => string | null
  refOf: (sessionId: string) => TerminalRefResolution
  onFrame: (frame: TerminalFrame) => void
  onError: (message: string) => void
  /**
   * This attach is over, however it ended. Most of them end because the surface went away, but an
   * exit, an unknown runtime and a ref that keeps moving all end one on their own, and the holder
   * would otherwise keep it for the life of the process.
   */
  onEnded: () => void
  socketFactory: TerminalSocketFactory
}

/**
 * One surface attached to one runtime, and everything that answer is allowed to mean.
 *
 * Three things live here and nowhere else, each because it is the only place that knows enough:
 *
 * 1. **The cursor.** A surface renders what it is given and remembers nothing, so the position in
 *    the output stream is held here. It is also what decides whether the next attach asks for a
 *    delta or for a snapshot, which is the difference between a reconnect that does not blink and
 *    one that redraws.
 * 2. **What a resize is worth.** The Host applies every resize it is given, and a resize to the size
 *    the PTY already has still triggers a ConPTY reflow that corrupts wide and box-drawing
 *    characters. Revealing a tab is exactly that case, so the last size actually sent is kept here
 *    rather than in the surface: then it holds for every source of a resize, not just the one that
 *    remembered to check.
 * 3. **Whether writing is possible.** The Host revalidates the controller lease on every write, so
 *    losing it revokes writing without ending the attach. Reading continues, the surface is told,
 *    and the keys pressed meanwhile are dropped rather than queued: replaying a minute of old
 *    keystrokes into an agent is worse than losing them.
 */
export class TerminalAttachment {
  private static readonly backoffMillisecondsConst = [250, 1_000, 2_500, 10_000] as const
  /**
   * What one `terminal.input` frame may carry, mirrored from `HostWireConst` through the type system
   * instead of imported as a value - every path out of this package into `app-host` is `import type`
   * (`CLAUDE.md` rule 1), and `SessionManager.clientProtocolConst` mirrors the protocol version the
   * same way. Move the Host's number and this line stops compiling rather than quietly disagreeing.
   */
  private static readonly inputBytesMaxConst: typeof HostWireConst.maxInputBytes = 4_096

  private socket: TerminalSocket | null = null
  private cursor: { outputEpoch: number; outputSeq: number } | null = null
  private lastSent: { cols: number; rows: number } | null = null
  private sizeSentWithAttach: { cols: number; rows: number } | null = null
  private wantedSize: { cols: number; rows: number } | null = null
  private writer = false
  /** Which lease the current attach named, so a keystroke can tell a new lease from the dead one. */
  private attachedWithLease: string | null = null
  /** Whether the current attach asked for writing at all. An observer never can, so it never retries. */
  private attachedAlive = false
  /**
   * Whether the Host has answered the attach frame. It is what tells a refused ATTACH from a refused
   * later frame: the Host says `bad-request` to both and names neither, and the two deserve opposite
   * answers - one attach can never work, one input frame is a frame.
   */
  private attached = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private conflictRetryUsed = false
  private disposed = false

  constructor(private readonly deps: TerminalAttachmentDeps) {}

  start(): void {
    this.open()
  }

  input(data: string): boolean {
    if (this.disposed) return false
    if (!this.writer) {
      // The keystroke is the ask. A lease that came back under a new id is the one case where
      // writing can be had again, and noticing it here is what keeps this class free of a timer.
      // The cursor is kept, so the answer is a delta and the screen does not move.
      // Only an attach that asked for a lease can get one back. An observer attach on a runtime the
      // Host no longer runs asked for none by design, so its lease is null forever and comparing it
      // with the live controller lease would reopen the socket on every single keystroke.
      if (this.attachedAlive && this.deps.leaseIdOf() !== this.attachedWithLease) this.open()
      return false
    }
    const socket = this.socket
    if (socket === null) return false
    // A paste is one string and the wire takes it in frames. Split here rather than at whichever
    // surface produced it: every keystroke, every paste and every clipboard escape passes through
    // this one call, and a copy of the limit in each of them is a copy that drifts.
    for (const chunk of TerminalInputChunks.of(data, TerminalAttachment.inputBytesMaxConst))
      socket.send({ type: 'terminal.input', data: chunk })
    return true
  }

  setGeometry(size: { cols: number; rows: number } | null): void {
    if (this.disposed) return
    this.wantedSize = size
    if (size === null) {
      this.lastSent = null
      return
    }
    if (!this.writer) return
    if (this.lastSent?.cols === size.cols && this.lastSent?.rows === size.rows) return
    this.lastSent = { ...size }
    this.socket?.send({ type: 'terminal.resize', cols: size.cols, rows: size.rows })
  }

  /** The surface is gone. The runtime is not touched: closing a tab is not a decision about a PTY. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.dropSocket()
    this.deps.onEnded()
  }

  private open(): void {
    if (this.disposed) return
    this.clearTimer()
    const descriptor = this.deps.descriptorOf()
    if (descriptor === null) {
      this.emitStatus('connecting', 'no Host descriptor is published')
      this.scheduleReopen()
      return
    }
    // Resolved on every attempt rather than once: a reopened session runs under a new generation, and
    // a Host that restarted has no runtime of ours at all.
    const resolution = this.deps.refOf(this.deps.sessionId)
    if (!resolution.ok) {
      if (resolution.code === 'unknown-session')
        this.emitStatus('lost', 'this session is no longer known', 'unknown-session')
      else if (resolution.code === 'not-live')
        this.emitStatus('lost', 'this session has no live runtime', 'not-live')
      else
        throw new Error(`Unknown terminal ref refusal: ${JSON.stringify(resolution)}`)
      this.dispose()
      return
    }
    this.dropSocket()
    const socket = this.deps.socketFactory({
      onFrame: (frame) => this.onFrame(frame),
      onClosed: (detail) => this.onClosed(detail),
    })
    this.socket = socket
    socket.connect(descriptor)
    socket.send(this.attachFrame(resolution.ref, resolution.alive))
  }

  private attachFrame(ref: RuntimeRef, alive: boolean): HostWsClientMsg {
    // Nothing to type at, so nothing is asked for: an interactive attach on a dead runtime would
    // take the lease and claim a writer that has nowhere to write.
    const leaseId = alive ? this.deps.leaseIdOf() : null
    this.attachedWithLease = leaseId
    this.attachedAlive = alive
    this.attached = false
    this.sizeSentWithAttach = this.wantedSize === null ? null : { ...this.wantedSize }
    return {
      type: 'terminal.attach',
      target: ref,
      // Always asked for while it runs. Without a lease the Host serves the attach read-only and
      // says so, which is a better answer than never asking and never finding out.
      role: alive ? 'interactive' : 'observer',
      ...(leaseId === null ? {} : { controllerLeaseId: leaseId }),
      ...(this.cursor === null
        ? {}
        : { outputEpoch: this.cursor.outputEpoch, sinceSeq: this.cursor.outputSeq }),
      ...(this.sizeSentWithAttach === null
        ? {}
        : { cols: this.sizeSentWithAttach.cols, rows: this.sizeSentWithAttach.rows }),
    }
  }

  private onFrame(frame: HostWsServerMsg): void {
    if (this.disposed) return
    if (frame.type === 'terminal.attached') {
      this.attempt = 0
      this.conflictRetryUsed = false
      this.attached = true
      this.writer = frame.writer
      // The Host applies the attach frame's geometry only for a writer, so that is the only case
      // where the size travelled. A newer measurement may have arrived while the socket connected.
      this.lastSent = frame.writer ? this.sizeSentWithAttach : null
      if (frame.writer && this.wantedSize !== null)
        this.setGeometry(this.wantedSize)
      this.deps.onFrame(frame)
      if (!frame.writer)
        this.emitStatus('read-only', 'another controller holds the Host, or this client has no lease')
    }
    else if (frame.type === 'terminal.snapshot') {
      this.cursor = {
        outputEpoch: frame.projection.outputEpoch,
        outputSeq: frame.projection.outputSeq,
      }
      this.deps.onFrame(frame)
    }
    else if (frame.type === 'terminal.data') {
      this.cursor = { outputEpoch: frame.outputEpoch, outputSeq: frame.outputSeq }
      this.deps.onFrame(frame)
    }
    else if (frame.type === 'terminal.delta') {
      if (frame.truncated) this.restart()
      else {
        this.cursor = { outputEpoch: frame.outputEpoch, outputSeq: frame.outputSeq }
        this.deps.onFrame(frame)
      }
    }
    // The bytes it names are gone from the Host too, so there is nothing to ask for except the
    // screen as it stands now.
    else if (frame.type === 'terminal.stream-truncated') this.restart()
    else if (frame.type === 'terminal.resize') {
      // What the PTY actually is, which is what the next resize is compared against.
      this.lastSent = { cols: frame.cols, rows: frame.rows }
      this.deps.onFrame(frame)
    }
    else if (frame.type === 'terminal.exit') {
      this.deps.onFrame(frame)
      this.dispose()
    }
    else if (frame.type === 'error') this.onWireError(frame)
    else
      throw new Error(`A frame that belongs to no attach: ${JSON.stringify(frame.type)}`)
  }

  private onWireError(frame: Extract<HostWsServerMsg, { type: 'error' }>): void {
    if (frame.code === 'not-writer' || frame.code === 'controller-required') {
      this.writer = false
      this.lastSent = null
      this.emitStatus('read-only', frame.message)
    }
    // A superseded generation means re-resolve and re-attach, which `open` does on its own. Twice is
    // no longer a race: something is handing out a ref this Host does not have.
    else if (frame.code === 'conflict') {
      if (this.conflictRetryUsed) {
        this.emitStatus('lost', frame.message)
        this.dispose()
        return
      }
      this.conflictRetryUsed = true
      this.restart()
    }
    else if (frame.code === 'unknown-runtime') {
      this.emitStatus('lost', frame.message)
      this.dispose()
    }
    // A frame this attach never recovers from and a frame it merely lost both arrive as this one
    // code, so the difference is read off whether the attach ever completed. Before it did, the only
    // frame the Host has been given is the attach itself, and re-sending it would be refused again.
    // After it did, one refused frame - an input past the wire's size, a resize with a bad number -
    // is not a reason to lose a working screen and leave the session running with nothing on it.
    else if (frame.code === 'bad-request') {
      if (!this.attached) {
        this.deps.onError(`The Host refused an attach frame: ${frame.message}`)
        this.emitStatus('lost', frame.message)
        this.dispose()
        return
      }
      this.deps.onError(`The Host refused a terminal frame: ${frame.message}`)
    }
    else
      throw new Error(`Unknown Host error code: ${JSON.stringify(frame.code)}`)
  }

  /** The cursor is worthless: drop it and ask for the screen as it stands. */
  private restart(): void {
    this.cursor = null
    this.open()
  }

  private onClosed(detail: string): void {
    if (this.disposed) return
    this.socket = null
    this.writer = false
    this.emitStatus('connecting', detail)
    this.scheduleReopen()
  }

  private scheduleReopen(): void {
    this.clearTimer()
    const ladder = TerminalAttachment.backoffMillisecondsConst
    const delay = ladder[Math.min(this.attempt, ladder.length - 1)]
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, delay)
    this.timer.unref()
  }

  /**
   * The code travels beside the sentence so a surface can act on the refusal without reading English
   * back out of it. Only a refused resolution has one; a status that came from the Host carries none.
   */
  private emitStatus(
    status: 'connecting' | 'read-only' | 'lost',
    detail: string | null,
    code?: 'not-live' | 'unknown-session',
  ): void {
    this.deps.onFrame(code === undefined
      ? { type: 'terminal.status', status, detail }
      : { type: 'terminal.status', status, detail, code })
  }

  /**
   * A socket that dropped has already cleared itself, so this only ever runs on a live one, and the
   * Host is told before it is closed: it frees the attach at once rather than waiting for a socket
   * to fall over.
   */
  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    socket.send({ type: 'terminal.detach' })
    socket.close()
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
