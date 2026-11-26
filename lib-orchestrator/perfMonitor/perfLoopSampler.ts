import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { PerfEvent } from './perfRecord.types'

/**
 * Busy milliseconds of this thread so far. Node's event-loop utilization when it counts; in Electron's
 * main and utility processes it stays 0 (Chromium runs the loop), so there the thread's CPU time stands
 * in: on 2026-11-25 all 3,511 samples of main, orchestrator and gateway read 0 and no load profile was
 * ever taken. A blocking spawn or SQLite open counts in both, since it holds the thread.
 */
export type PerfBusyClock = () => number

export class PerfLoopSampler {
  private readonly emit: (event: PerfEvent) => void
  private readonly now: () => number
  private readonly monotonic: () => number
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>
  private timer: ReturnType<typeof setInterval> | null
  private wall: number
  private mono: number
  private sampleAt: number
  private readonly busy: PerfBusyClock
  private busySample: number
  private triggerAt: number
  private busyTrigger: number
  private readonly observe: ((elu: number | null, elapsedMs: number) => void) | undefined

  constructor(emit: (event: PerfEvent) => void, now = Date.now, monotonic = () => performance.now(),
    observe?: (elu: number | null, elapsedMs: number) => void, busy: PerfBusyClock = PerfLoopSampler.busyClock()) {
    this.emit = emit
    this.now = now
    this.monotonic = monotonic
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.timer = null
    this.wall = 0
    this.mono = 0
    this.sampleAt = 0
    this.busy = busy
    this.busySample = busy()
    this.triggerAt = 0
    this.busyTrigger = this.busySample
    this.observe = observe
  }

  /** Event-loop active time where Node runs the loop, otherwise this thread's CPU time. */
  static busyClock(): PerfBusyClock {
    const loop = performance.eventLoopUtilization()
    if (loop.active + loop.idle > 0) return () => performance.eventLoopUtilization().active
    // Node 23.9+ (Electron 43 runs 24); the typings this tree pins predate it. Without it, the process
    // total stands in, which also counts the worker threads.
    const thread = (process as NodeJS.Process & { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage
    const read = thread ? () => thread.call(process) : () => process.cpuUsage()
    return () => { const cpu = read(); return (cpu.user + cpu.system) / 1_000 }
  }

  start(): void {
    if (this.timer !== null) return
    this.wall = this.now()
    this.mono = this.monotonic()
    this.sampleAt = this.mono
    this.busySample = this.busy()
    this.triggerAt = this.mono
    this.busyTrigger = this.busySample
    this.histogram.enable()
    this.timer = setInterval(() => this.poll(), 50)
    this.timer.unref()
  }

  poll(): void {
    const wall = this.now()
    const mono = this.monotonic()
    const gap = mono - this.mono
    const sleep = wall - this.wall - gap > 5_000
    this.wall = wall
    this.mono = mono
    if (sleep) {
      this.histogram.reset()
      this.sampleAt = mono
      this.busySample = this.busy()
      this.triggerAt = mono
      this.busyTrigger = this.busySample
      this.observe?.(null, 0)
      return
    }
    if (gap - 50 >= 100) this.emit({ kind: 'stall', ms: gap - 50, covered: [] })
    if (mono - this.triggerAt >= 1_000) {
      const busy = this.busy()
      this.observe?.(PerfLoopSampler.share(busy - this.busyTrigger, mono - this.triggerAt), mono - this.triggerAt)
      this.triggerAt = mono
      this.busyTrigger = busy
    }
    if (mono - this.sampleAt < 60_000) return
    const busy = this.busy()
    const measured = this.histogram.count > 0
    this.emit({ kind: 'sample', elu: PerfLoopSampler.share(busy - this.busySample, mono - this.sampleAt),
      loopP50: measured ? this.histogram.percentile(50) / 1e6 : null,
      loopP99: measured ? this.histogram.percentile(99) / 1e6 : null,
      loopMax: measured ? this.histogram.max / 1e6 : null, heapMb: process.memoryUsage().heapUsed / 1024 / 1024 })
    this.sampleAt = mono
    this.busySample = busy
    this.histogram.reset()
  }

  private static share(busyMs: number, elapsedMs: number): number {
    return elapsedMs > 0 ? Math.min(1, Math.max(0, busyMs / elapsedMs)) : 0
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.histogram.disable()
  }
}
