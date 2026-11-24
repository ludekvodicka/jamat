import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import type { TerminalFrame } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { TerminalHeldOutput } from './terminalHeldOutput'

type OutputFrame = Exclude<TerminalFrame, { type: 'terminal.attached' | 'terminal.status' | 'terminal.exit' }>

export class TerminalOutput {
  private readonly terminal: Pick<Terminal, 'write' | 'reset' | 'resize' | 'cols' | 'rows'>
  private readonly measurable: () => boolean
  private readonly onOverflow: () => void
  private readonly held: TerminalHeldOutput
  private readonly writes: Set<() => void>
  private rendering: Promise<void> | null
  private snapshotId: string | null
  private skippingStream: boolean
  private resyncing: boolean
  private deferredFit: Pick<FitAddon, 'fit' | 'proposeDimensions'> | null
  private fitVisible: boolean
  private visible: boolean
  private disposed: boolean

  constructor(
    terminal: TerminalOutput['terminal'],
    measurable: () => boolean = () => true,
    onOverflow: () => void = () => {},
  ) {
    this.terminal = terminal
    this.measurable = measurable
    this.onOverflow = onOverflow
    this.held = new TerminalHeldOutput()
    this.writes = new Set()
    this.rendering = null
    this.snapshotId = null
    this.skippingStream = false
    this.resyncing = false
    this.deferredFit = null
    this.fitVisible = true
    this.visible = true
    this.disposed = false
  }

  frame(frame: OutputFrame): void | Promise<void> { return this.render(() => this.apply(frame)) }

  setVisible(visible: boolean): void | Promise<void> {
    this.fitVisible = visible
    return this.render(() => {
      if (this.resyncing) return
      this.visible = visible
      if (!visible) return
      const shown = this.show()
      if (this.resyncing) return
      if (shown) return shown.then(() => { if (!this.disposed && !this.resyncing && this.snapshotId === null) this.fitDeferred() })
      if (this.snapshotId === null) this.fitDeferred()
    })
  }

  lost(): void | Promise<void> {
    return this.render(() => {
      this.skippingStream = false
      // A lost surface cannot request a fresh snapshot on its own; drop overflow rather than resyncing.
      if (this.held.isOverflowed) this.held.take()
      return this.complete()
    })
  }

  measure(fit: Pick<FitAddon, 'fit' | 'proposeDimensions'>): { cols: number; rows: number } | null {
    if (this.resyncing) return null
    if (!this.fitVisible || !this.measurable()) { this.deferredFit = fit; return null }
    if (this.snapshotId !== null || this.rendering !== null) {
      this.deferredFit = fit
      const size = fit.proposeDimensions()
      return size ?? null
    }
    this.deferredFit = null
    fit.fit()
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  dispose(): void {
    this.disposed = true
    this.deferredFit = null
    for (const finish of this.writes) finish()
  }

  private apply(frame: OutputFrame): void | Promise<void> {
    if (this.resyncing) return
    if (frame.type === 'terminal.snapshot-start') {
      this.snapshotId = frame.streamId
      if (frame.reset) {
        this.skippingStream = false
        this.held.take()
        this.terminal.reset()
        this.resize(frame.projection.cols, frame.projection.rows)
      } else {
        if (!this.visible && this.held.isOverflowed) {
          this.skippingStream = true
          return
        }
        this.skippingStream = false
        const shown = this.show()
        if (this.resyncing) return
        if (shown) return shown.then(() => { if (!this.disposed && !this.resyncing) this.resize(frame.projection.cols, frame.projection.rows) })
        this.resize(frame.projection.cols, frame.projection.rows)
      }
    } else if (frame.type === 'terminal.snapshot-chunk') {
      if (this.snapshotId !== frame.streamId) throw new Error('Snapshot chunk belongs to a different terminal stream')
      if (this.skippingStream) return
      return this.write(frame.data)
    } else if (frame.type === 'terminal.snapshot-end') {
      if (this.snapshotId !== frame.streamId) throw new Error('Snapshot end belongs to a different terminal stream')
    } else if (frame.type === 'terminal.snapshot-complete') {
      if (this.snapshotId !== frame.streamId) return
      return this.complete()
    } else if (frame.type === 'terminal.snapshot') {
      this.skippingStream = false
      this.held.take()
      this.terminal.reset()
      this.resize(frame.projection.cols, frame.projection.rows)
      return this.write(frame.projection.screen)
    } else if (frame.type === 'terminal.data') {
      if (this.visible) return this.write(frame.delta)
      this.held.holdData(frame.delta)
    } else if (frame.type === 'terminal.delta') {
      if (this.visible) return this.write(frame.data)
      this.held.holdData(frame.data)
    } else if (frame.type === 'terminal.resize') {
      if (!this.visible && this.held.isOverflowed) return
      const shown = this.show()
      if (this.resyncing) return
      if (shown) return shown.then(() => { if (!this.disposed && !this.resyncing) this.resize(frame.cols, frame.rows) })
      this.resize(frame.cols, frame.rows)
    } else throw new Error(`Unknown terminal output frame: ${JSON.stringify(frame)}`)
  }

  private complete(): void | Promise<void> {
    const finish = (): void => { this.skippingStream = false; this.snapshotId = null; this.fitDeferred() }
    if (!this.visible && this.held.isOverflowed) { finish(); return }
    const shown = this.show()
    if (this.resyncing) return
    if (shown) return shown.then(() => { if (!this.disposed && !this.resyncing) finish() })
    finish()
  }

  private resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
  }

  private fitDeferred(): void {
    if (this.disposed || this.resyncing || !this.fitVisible || !this.measurable()) return
    const fit = this.deferredFit
    this.deferredFit = null
    fit?.fit()
  }

  private show(): void | Promise<void> {
    const flush = this.held.take()
    if (flush === null) return
    if (flush.kind === 'overflow') {
      this.resyncing = true
      this.deferredFit = null
      this.onOverflow()
      return
    }
    else if (flush.kind === 'data') {
      if (flush.reset) this.terminal.reset()
      if (flush.size !== null) this.resize(flush.size.cols, flush.size.rows)
      return this.write(flush.data)
    }
    else throw new Error(`Unknown held output flush: ${JSON.stringify(flush satisfies never)}`)
  }

  private write(data: string): void | Promise<void> {
    let completed = false
    const task = new Promise<void>((resolve, reject) => {
      const finish = (): void => { completed = true; this.writes.delete(finish); resolve() }
      this.writes.add(finish)
      try { this.terminal.write(data, finish) }
      catch (error) { this.writes.delete(finish); reject(error) }
    })
    if (!completed) return task
  }

  private render(operation: () => void | Promise<void>): void | Promise<void> {
    const task = this.rendering === null ? (this.disposed ? undefined : operation())
      : this.rendering.then(() => { if (!this.disposed) return operation() })
    if (task === undefined) return
    const settled = task.catch(() => {})
    this.rendering = settled
    void settled.then(() => {
      if (this.rendering !== settled) return
      this.rendering = null
      if (this.snapshotId === null && !this.resyncing) this.fitDeferred()
    })
    return task
  }
}
