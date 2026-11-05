import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import type { TerminalFrame } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { TerminalHeldOutput } from './terminalHeldOutput'

type OutputFrame = Exclude<TerminalFrame, { type: 'terminal.attached' | 'terminal.status' | 'terminal.exit' }>

export class TerminalOutput {
  private readonly terminal: Pick<Terminal, 'write' | 'reset' | 'resize' | 'cols' | 'rows'>
  private readonly measurable: () => boolean
  private readonly held: TerminalHeldOutput
  private readonly writes: Set<() => void>
  private rendering: Promise<void> | null
  private snapshotId: string | null
  private deferredFit: Pick<FitAddon, 'fit' | 'proposeDimensions'> | null
  private fitVisible: boolean
  private visible: boolean
  private disposed: boolean

  constructor(terminal: TerminalOutput['terminal'], measurable: () => boolean = () => true) {
    this.terminal = terminal
    this.measurable = measurable
    this.held = new TerminalHeldOutput()
    this.writes = new Set()
    this.rendering = null
    this.snapshotId = null
    this.deferredFit = null
    this.fitVisible = true
    this.visible = true
    this.disposed = false
  }

  frame(frame: OutputFrame): void | Promise<void> { return this.render(() => this.apply(frame)) }

  setVisible(visible: boolean): void | Promise<void> {
    this.fitVisible = visible
    return this.render(() => {
      this.visible = visible
      if (!visible) return
      const shown = this.show()
      if (shown) return shown.then(() => { if (this.snapshotId === null) this.fitDeferred() })
      if (this.snapshotId === null) this.fitDeferred()
    })
  }

  lost(): void | Promise<void> {
    return this.render(() => this.complete())
  }

  measure(fit: Pick<FitAddon, 'fit' | 'proposeDimensions'>): { cols: number; rows: number } | null {
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
    if (frame.type === 'terminal.snapshot-start') {
      this.snapshotId = frame.streamId
      if (frame.reset) {
        this.held.take()
        this.terminal.reset()
        this.resize(frame.projection.cols, frame.projection.rows)
      } else {
        const shown = this.show()
        if (shown) return shown.then(() => { if (!this.disposed) this.resize(frame.projection.cols, frame.projection.rows) })
        this.resize(frame.projection.cols, frame.projection.rows)
      }
    } else if (frame.type === 'terminal.snapshot-chunk') {
      if (this.snapshotId !== frame.streamId) throw new Error('Snapshot chunk belongs to a different terminal stream')
      return this.write(frame.data)
    } else if (frame.type === 'terminal.snapshot-end') {
      if (this.snapshotId !== frame.streamId) throw new Error('Snapshot end belongs to a different terminal stream')
    } else if (frame.type === 'terminal.snapshot-complete') {
      if (this.snapshotId !== frame.streamId) return
      return this.complete()
    } else if (frame.type === 'terminal.snapshot') {
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
      const shown = this.show()
      if (shown) return shown.then(() => { if (!this.disposed) this.resize(frame.cols, frame.rows) })
      this.resize(frame.cols, frame.rows)
    } else throw new Error(`Unknown terminal output frame: ${JSON.stringify(frame)}`)
  }

  private complete(): void | Promise<void> {
    const finish = (): void => { this.snapshotId = null; this.fitDeferred() }
    const shown = this.show()
    if (shown) return shown.then(() => { if (!this.disposed) finish() })
    finish()
  }

  private resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
  }

  private fitDeferred(): void {
    if (this.disposed || !this.fitVisible || !this.measurable()) return
    const fit = this.deferredFit
    this.deferredFit = null
    fit?.fit()
  }

  private show(): void | Promise<void> {
    const flush = this.held.take()
    if (flush === null) return
    if (flush.reset) this.terminal.reset()
    if (flush.size !== null) this.resize(flush.size.cols, flush.size.rows)
    return this.write(flush.data)
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
      if (this.snapshotId === null) this.fitDeferred()
    })
    return task
  }
}
