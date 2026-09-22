import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import xtermHeadless from '@xterm/headless'
import type { Terminal as XtermTerminal } from '@xterm/headless'

import type { TerminalProjectionSnapshot, TerminalProjectionView } from '../wire/hostWire.js'
import { computeRingDelta } from './ringDelta.js'

export interface TerminalProjectionDelta {
  data: string
  outputSeq: number
  outputEpoch: number
  truncated: boolean
}

/**
 * How much of itself one snapshot composes, which is the Host's own vocabulary rather than the
 * wire's: `TerminalProjectionView` is what a CALLER may ask for, and the attach path is not a
 * caller - it is this Host deciding that nothing has ever read a ring from an attach.
 */
export interface TerminalSnapshotOptions {
  /** Characters of the ring from its end; `null` sends none and `'all'` sends the whole ring. */
  rawTailChars: number | 'all' | null
  /** Scrollback rows above the viewport; `null` serializes every row the buffer holds. */
  screenScrollbackRows: number | null
  maxScreenChars: number
}

export class TerminalProjection {
  private static readonly maxRingCharsConst = 512 * 1_024
  private static readonly maxPendingCharsConst = 4 * 1_024 * 1_024
  /**
   * Five seconds until 2026-09-21, which is how long an attach to a flooded terminal showed nothing
   * at all: `pendingChars` reaches zero only between writes, so under a flood this always ran to the
   * end of the timeout, and `sendInitialProjection` holds every arriving byte in `terminalBuffer`
   * while it waits. Waiting buys a tidier picture and never correctness - what the buffer has not
   * taken yet goes out as `tail` and the client writes exactly the same characters either way - so
   * the ceiling is now short enough to be invisible instead of long enough to be reported as a
   * frozen terminal.
   */
  private static readonly syncTimeoutMsConst = 500
  /**
   * The ceiling on what one snapshot may carry, for the case that has no natural one: a ring delta
   * the ring itself has lost means `screen` IS the ring, and the ring is half a megabyte. A client
   * writes it into a terminal holding 10 000 rows of scrollback, so this is the part of that history
   * it can still show, not a limit on what it draws.
   */
  private static readonly maxSnapshotScreenCharsConst = 256 * 1_024
  /** The same ceiling for a `view`ed snapshot, whose caller reads a tail and not a history. */
  private static readonly maxViewScreenCharsConst = 64 * 1_024
  /**
   * How much history the buffer itself holds, and therefore what "every row" means to the serializer.
   * Named because two things read it: the terminal that is constructed with it, and a snapshot that
   * asks for all of it.
   */
  private static readonly scrollbackRowsConst = 1_000
  /**
   * An attach: the whole screen, and no ring. The renderer writes `screen` into a reset terminal and
   * the remote peek reads `screen` alone, so the ring was half a megabyte crossing a socket, an IPC
   * structured clone and a peer channel to be dropped at both ends.
   */
  static readonly attachOptionsConst: TerminalSnapshotOptions = {
    rawTailChars: null,
    screenScrollbackRows: null,
    maxScreenChars: TerminalProjection.maxSnapshotScreenCharsConst,
  }
  /** A `runtime.inspect` that named no view: everything, which is what it answered before views. */
  static readonly wholeOptionsConst: TerminalSnapshotOptions = {
    rawTailChars: 'all',
    screenScrollbackRows: null,
    maxScreenChars: TerminalProjection.maxSnapshotScreenCharsConst,
  }
  /**
   * The width table every screen in this tree is measured with, and the client's terminal registers
   * the same one. xterm ships Unicode 6, where an emoji is one cell wide; every agent, every shell
   * and the Windows console measure it at two. A line with one in it then ends a cell short of the
   * right edge, the first character of the next line is pulled onto its tail, and a box-drawn frame
   * walks one column further left with every emoji until something forces a full repaint.
   *
   * It has to hold on BOTH sides: what is serialized out of this buffer is written into the
   * client's, so a version only one of them registers moves the damage rather than fixing it.
   */
  private static readonly unicodeVersionConst = '11'
  private readonly terminal: XtermTerminal
  private readonly serializer = new SerializeAddon()
  private ring = ''
  private outputSeqValue = 0
  /**
   * How far the SCREEN has been written, as against `outputSeqValue`, which is how far the ring has.
   * xterm takes a write asynchronously, so under a flood the two are apart most of the time, and a
   * snapshot has to say which of them it is describing.
   */
  private writtenSeqValue = 0
  private lastOutputAtValue: number | null = null
  private pendingChars = 0
  private screenStale = false
  private syncWaiters: Array<() => void> = []
  private disposed = false

  constructor(
    readonly runtimeSessionId: string,
    readonly generation: number,
    readonly outputEpoch: number,
    private colsValue: number,
    private rowsValue: number,
  ) {
    const { Terminal } = xtermHeadless
    this.terminal = new Terminal({
      cols: colsValue,
      rows: rowsValue,
      scrollback: TerminalProjection.scrollbackRowsConst,
      // `terminal.unicode` sits behind the proposed API, and the width table is what the option is
      // taken for: without it the registration below throws rather than being ignored.
      allowProposedApi: true,
    })
    this.terminal.loadAddon(this.serializer)
    this.terminal.loadAddon(new Unicode11Addon())
    this.terminal.unicode.activeVersion = TerminalProjection.unicodeVersionConst
  }

  get outputSeq(): number {
    return this.outputSeqValue
  }

  get lastOutputAt(): number | null {
    return this.lastOutputAtValue
  }

  get cols(): number {
    return this.colsValue
  }

  get rows(): number {
    return this.rowsValue
  }

  append(data: string, timestamp = Date.now()): number {
    if (this.disposed) throw new Error('Terminal projection is disposed')
    this.ring += data
    this.outputSeqValue += data.length
    this.lastOutputAtValue = timestamp
    this.trimRing()
    if (this.pendingChars + data.length > TerminalProjection.maxPendingCharsConst) {
      this.screenStale = true
      if (this.pendingChars === 0)
        this.rebuild()
      return this.outputSeqValue
    }
    this.pendingChars += data.length
    const through = this.outputSeqValue
    this.terminal.write(data, () => this.onWriteComplete(data.length, through))
    return this.outputSeqValue
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) throw new Error('Terminal projection is disposed')
    this.colsValue = TerminalProjection.clamp(cols, 1, 500, 80)
    this.rowsValue = TerminalProjection.clamp(rows, 1, 200, 24)
    this.terminal.resize(this.colsValue, this.rowsValue)
  }

  deltaSince(outputEpoch: number, sinceSeq: number): TerminalProjectionDelta {
    if (outputEpoch !== this.outputEpoch)
      return {
        data: this.ring,
        outputSeq: this.outputSeqValue,
        outputEpoch: this.outputEpoch,
        truncated: true,
      }
    const delta = computeRingDelta(this.ring, this.outputSeqValue, sinceSeq)
    return {
      data: delta.data,
      outputSeq: this.outputSeqValue,
      outputEpoch: this.outputEpoch,
      truncated: delta.truncated,
    }
  }

  /**
   * The screen as it stands, and it always answers.
   *
   * It used to REJECT when the buffer had not caught up within the timeout, and a terminal under a
   * flood - which is what a ConPTY repaint after a resize is - never catches up: `pendingChars`
   * reaches zero only between writes, and while output keeps arriving there is no such moment. The
   * one thing that asks for a snapshot is an attach, so a busy terminal was a terminal nobody could
   * attach to.
   *
   * The serialized screen and the tail the buffer has not taken yet are read in the SAME tick, so
   * what goes out is one consistent picture up to `outputSeq`: the screen, plus the raw bytes that
   * came after it, which is exactly what the client writes into a reset terminal anyway. A tail the
   * ring itself has lost means the ring IS the screen, the way a delta across an epoch is.
   *
   * `view` is what the caller says it reads. Null is an attach, which takes the whole screen and no
   * ring at all; a view cuts both to what asked for them, which is the difference between a
   * megabyte and a few kilobytes on every pass of the work-state monitor.
   */
  async snapshot(
    alive: boolean,
    options: TerminalSnapshotOptions,
  ): Promise<TerminalProjectionSnapshot> {
    await this.waitUntilSynchronized()
    const screen = this.serializer.serialize(options.screenScrollbackRows === null
      ? undefined
      : { scrollback: Math.max(0, options.screenScrollbackRows) })
    const tail = this.writtenSeqValue >= this.outputSeqValue
      ? { data: '', truncated: false }
      : computeRingDelta(this.ring, this.outputSeqValue, this.writtenSeqValue)
    return {
      runtimeSessionId: this.runtimeSessionId,
      generation: this.generation,
      outputEpoch: this.outputEpoch,
      outputSeq: this.outputSeqValue,
      ...this.rawFor(options.rawTailChars),
      // The cap is the truncated arm's alone. A serialized screen is bounded by the buffer that
      // made it, and cutting one at a raw character index can split the `ESC[?1049h ESC[H` the
      // serializer writes in front of an alternate screen - which a client then draws into its
      // normal buffer, in the wrong place, until the agent repaints.
      screen: tail.truncated
        ? TerminalProjection.tailOf(this.ring, options.maxScreenChars)
        : screen + tail.data,
      cols: this.colsValue,
      rows: this.rowsValue,
      alive,
      lastOutputAt: this.lastOutputAtValue,
    }
  }

  /** What a wire `view` means to this projection. Absent is the whole of it, as it always was. */
  static optionsOf(view: TerminalProjectionView | null): TerminalSnapshotOptions {
    if (view === null) return TerminalProjection.wholeOptionsConst
    return {
      rawTailChars: view.rawTailChars,
      screenScrollbackRows: Math.max(0, view.screenScrollbackRows),
      maxScreenChars: TerminalProjection.maxViewScreenCharsConst,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.terminal.dispose()
    this.resolveWaiters()
  }

  private onWriteComplete(length: number, through: number): void {
    if (this.disposed) return
    this.writtenSeqValue = Math.max(this.writtenSeqValue, through)
    this.pendingChars = Math.max(0, this.pendingChars - length)
    if (this.pendingChars !== 0) return
    if (this.screenStale) {
      this.rebuild()
      return
    }
    this.resolveWaiters()
  }

  private rebuild(): void {
    this.screenStale = false
    this.terminal.reset()
    if (!this.ring) {
      this.resolveWaiters()
      return
    }
    const content = this.ring
    const through = this.outputSeqValue
    this.pendingChars = content.length
    this.terminal.write(content, () => this.onWriteComplete(content.length, through))
  }

  /**
   * Best effort, and deliberately not a deadline anything fails on: the caller reads how far the
   * screen actually got and carries the rest itself, so waiting longer buys a tidier picture and
   * never correctness.
   */
  private waitUntilSynchronized(): Promise<void> {
    if (this.pendingChars === 0 && !this.screenStale) return Promise.resolve()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const index = this.syncWaiters.indexOf(done)
        if (index >= 0) this.syncWaiters.splice(index, 1)
        resolve()
      }, TerminalProjection.syncTimeoutMsConst)
      const done = (): void => {
        clearTimeout(timeout)
        resolve()
      }
      this.syncWaiters.push(done)
    })
  }

  private resolveWaiters(): void {
    for (const resolve of this.syncWaiters.splice(0)) resolve()
  }

  private trimRing(): void {
    if (this.ring.length <= TerminalProjection.maxRingCharsConst) return
    let cut = this.ring.length - TerminalProjection.maxRingCharsConst
    const newline = this.ring.indexOf('\n', cut)
    if (newline >= 0 && newline - cut < 4_096) cut = newline + 1
    this.ring = this.ring.slice(cut)
  }

  /** A caller reading no ring gets no field: absence is the answer, not an empty string. */
  private rawFor(rawTailChars: TerminalSnapshotOptions['rawTailChars']): { raw?: string } {
    if (rawTailChars === null) return {}
    if (rawTailChars === 'all') return { raw: this.ring }
    return { raw: TerminalProjection.tailOf(this.ring, rawTailChars) }
  }

  /** A non-positive or unreadable count asks for nothing, which is what a caller reading nothing gets. */
  private static tailOf(text: string, chars: number): string {
    const limit = Math.trunc(chars)
    if (!Number.isFinite(limit) || limit <= 0) return ''
    return text.length <= limit ? text : text.slice(-limit)
  }

  private static clamp(value: number, minimum: number, maximum: number, fallback: number): number {
    const integer = Math.trunc(value)
    return Number.isFinite(integer)
      ? Math.max(minimum, Math.min(integer || fallback, maximum))
      : fallback
  }
}
