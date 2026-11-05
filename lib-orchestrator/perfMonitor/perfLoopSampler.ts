import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { PerfEvent } from './perfRecord.types'

export class PerfLoopSampler {
  private readonly emit: (event: PerfEvent) => void
  private readonly now: () => number
  private readonly monotonic: () => number
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>
  private timer: ReturnType<typeof setInterval> | null
  private wall: number
  private mono: number
  private sampleAt: number
  private utilization: ReturnType<typeof performance.eventLoopUtilization>
  private triggerAt: number
  private triggerUtilization: ReturnType<typeof performance.eventLoopUtilization>
  private readonly observe: ((elu: number | null, elapsedMs: number) => void) | undefined

  constructor(emit: (event: PerfEvent) => void, now = Date.now, monotonic = () => performance.now(),
    observe?: (elu: number | null, elapsedMs: number) => void) {
    this.emit = emit
    this.now = now
    this.monotonic = monotonic
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.timer = null
    this.wall = 0
    this.mono = 0
    this.sampleAt = 0
    this.utilization = performance.eventLoopUtilization()
    this.triggerAt = 0
    this.triggerUtilization = this.utilization
    this.observe = observe
  }

  start(): void {
    if (this.timer !== null) return
    this.wall = this.now()
    this.mono = this.monotonic()
    this.sampleAt = this.mono
    this.utilization = performance.eventLoopUtilization()
    this.triggerAt = this.mono
    this.triggerUtilization = this.utilization
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
      this.utilization = performance.eventLoopUtilization()
      this.triggerAt = mono
      this.triggerUtilization = this.utilization
      this.observe?.(null, 0)
      return
    }
    if (gap - 50 >= 100) this.emit({ kind: 'stall', ms: gap - 50, covered: [] })
    if (mono - this.triggerAt >= 1_000) {
      const utilization = performance.eventLoopUtilization()
      this.observe?.(performance.eventLoopUtilization(utilization, this.triggerUtilization).utilization, mono - this.triggerAt)
      this.triggerAt = mono
      this.triggerUtilization = utilization
    }
    if (mono - this.sampleAt < 60_000) return
    const utilization = performance.eventLoopUtilization()
    const elapsed = performance.eventLoopUtilization(utilization, this.utilization)
    const measured = this.histogram.count > 0
    this.emit({ kind: 'sample', elu: elapsed.utilization,
      loopP50: measured ? this.histogram.percentile(50) / 1e6 : null,
      loopP99: measured ? this.histogram.percentile(99) / 1e6 : null,
      loopMax: measured ? this.histogram.max / 1e6 : null, heapMb: process.memoryUsage().heapUsed / 1024 / 1024 })
    this.sampleAt = mono
    this.utilization = utilization
    this.histogram.reset()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.histogram.disable()
  }
}
