import type { PerfEvent } from '../../../lib-orchestrator/perfMonitor/perfRecord.types'
import type { TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

export type RendererPerfEvent = Extract<PerfEvent, { kind: 'sample' | 'stall' | 'inputToFrame' }> & { at: number }

export class RendererPerf {
  static readonly current = new RendererPerf()
  private readonly clock: () => number
  private readonly wall: () => number
  private readonly pending: Map<string, number>
  private inputs: number[]
  private delays: number[]
  private batch: RendererPerfEvent[]
  private timer: ReturnType<typeof setInterval> | null
  private observer: PerformanceObserver | null
  private fallback: ReturnType<typeof setInterval> | null
  private minute: number
  private previousWall: number
  private previousMono: number

  constructor(clock = () => performance.now(), wall = Date.now) {
    this.clock = clock
    this.wall = wall
    this.pending = new Map()
    this.inputs = []
    this.delays = []
    this.batch = []
    this.timer = null
    this.observer = null
    this.fallback = null
    this.minute = clock()
    this.previousWall = wall()
    this.previousMono = clock()
  }

  start(send: (batch: RendererPerfEvent[]) => void): void {
    if (this.timer !== null) return
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      this.observer = new PerformanceObserver(entries => {
        if (this.slept()) return
        for (const entry of entries.getEntries()) this.longTask(entry.duration)
      })
      this.observer.observe({ type: 'longtask' })
    } else {
      let previous = this.clock()
      this.fallback = setInterval(() => {
        const now = this.clock()
        if (!this.slept() && now - previous - 50 >= 100) this.longTask(now - previous - 50)
        previous = now
      }, 50)
    }
    this.timer = setInterval(() => {
      this.slept()
      if (this.clock() - this.minute >= 60_000) this.sample()
      const batch = this.batch.splice(0)
      if (batch.length > 0) send(batch)
    }, 10_000)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.fallback !== null) clearInterval(this.fallback)
    this.observer?.disconnect()
    this.timer = null
    this.fallback = null
    this.pending.clear()
  }

  input(attachId: string): void {
    if (this.pending.size < 1024 && !this.pending.has(attachId)) this.pending.set(attachId, this.clock())
  }

  detach(attachId: string): void { this.pending.delete(attachId) }

  frame(attachId: string, frame: TerminalFrame): void {
    switch (frame.type) {
      case 'terminal.data': case 'terminal.delta': {
        const started = this.pending.get(attachId)
        this.pending.delete(attachId)
        if (started !== undefined && this.inputs.length < 4096) this.inputs.push(Math.max(0, this.clock() - started))
        break
      }
      case 'terminal.snapshot-start': case 'terminal.snapshot-chunk': case 'terminal.snapshot-end': case 'terminal.snapshot-complete':
      case 'terminal.attached': case 'terminal.snapshot': case 'terminal.resize': case 'terminal.exit': case 'terminal.status': break
      default: throw new Error('Unknown terminal frame')
    }
  }

  longTask(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    if (this.delays.length < 4096) this.delays.push(ms)
    if (this.batch.length < 256) this.batch.push({ kind: 'stall', ms, covered: [], at: this.wall() })
  }

  sample(): void {
    const at = this.wall()
    this.delays.sort((a, b) => a - b)
    this.inputs.sort((a, b) => a - b)
    this.batch.push({ kind: 'sample', at, elu: null, heapMb: null,
      loopP50: RendererPerf.percentile(this.delays, 0.5), loopP99: RendererPerf.percentile(this.delays, 0.99),
      loopMax: this.delays.at(-1) ?? null })
    if (this.inputs.length > 0) this.batch.push({ kind: 'inputToFrame', at, count: this.inputs.length,
      p50: RendererPerf.percentile(this.inputs, 0.5)!, p99: RendererPerf.percentile(this.inputs, 0.99)! })
    this.inputs = []
    this.delays = []
    this.minute = this.clock()
    for (const [id, started] of this.pending)
      if (this.minute - started > 60_000) this.pending.delete(id)
  }

  private slept(): boolean {
    const wall = this.wall()
    const mono = this.clock()
    const slept = wall - this.previousWall - (mono - this.previousMono) > 5_000
    this.previousWall = wall
    this.previousMono = mono
    if (slept) {
      this.pending.clear()
      this.inputs = []
      this.delays = []
      this.minute = mono
    }
    return slept
  }

  private static percentile(values: number[], fraction: number): number | null {
    return values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null
  }
}
