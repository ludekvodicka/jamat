import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import xtermHeadless from '@xterm/headless'
import type { Terminal as XtermTerminal } from '@xterm/headless'

import type { TerminalProjectionSnapshot } from '../wire/hostWire.js'
import { computeRingDelta } from './ringDelta.js'

export interface TerminalProjectionDelta {
  data: string
  outputSeq: number
  outputEpoch: number
  truncated: boolean
}

export class TerminalProjection {
  private static readonly maxRingCharsConst = 512 * 1_024
  private static readonly maxPendingCharsConst = 4 * 1_024 * 1_024
  private static readonly syncTimeoutMsConst = 5_000
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
      scrollback: 1_000,
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
   */
  async snapshot(alive: boolean): Promise<TerminalProjectionSnapshot> {
    await this.waitUntilSynchronized()
    const screen = this.serializer.serialize()
    const tail = this.writtenSeqValue >= this.outputSeqValue
      ? { data: '', truncated: false }
      : computeRingDelta(this.ring, this.outputSeqValue, this.writtenSeqValue)
    return {
      runtimeSessionId: this.runtimeSessionId,
      generation: this.generation,
      outputEpoch: this.outputEpoch,
      outputSeq: this.outputSeqValue,
      raw: this.ring,
      screen: tail.truncated ? this.ring : screen + tail.data,
      cols: this.colsValue,
      rows: this.rowsValue,
      alive,
      lastOutputAt: this.lastOutputAtValue,
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

  private static clamp(value: number, minimum: number, maximum: number, fallback: number): number {
    const integer = Math.trunc(value)
    return Number.isFinite(integer)
      ? Math.max(minimum, Math.min(integer || fallback, maximum))
      : fallback
  }
}
