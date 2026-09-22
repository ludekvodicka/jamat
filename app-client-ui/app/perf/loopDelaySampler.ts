import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

/**
 * How late this process's event loop is running, sampled by the platform rather than by a timer of
 * ours: `monitorEventLoopDelay` records in libuv and costs nothing per tick.
 *
 * Read and reset together, so what comes back is the window since the previous read rather than an
 * average over the life of the process. A window is what a spike is visible in.
 */
export class LoopDelaySampler {
  /** Fine enough to see a 20 ms block, coarse enough to record nothing on an idle loop. */
  private static readonly resolutionMsConst = 20

  private readonly histogram: IntervalHistogram

  constructor() {
    this.histogram = monitorEventLoopDelay({ resolution: LoopDelaySampler.resolutionMsConst })
  }

  start(): void {
    this.histogram.enable()
  }

  stop(): void {
    this.histogram.disable()
  }

  /** The window since the last call, in milliseconds, and the window starts again here. */
  sample(): { p95: number; max: number } {
    const p95 = LoopDelaySampler.millisecondsOf(this.histogram.percentile(95))
    const max = LoopDelaySampler.millisecondsOf(this.histogram.max)
    this.histogram.reset()
    return { p95, max }
  }

  /**
   * The histogram counts in nanoseconds and answers an empty window with values that are not
   * measurements - `max` is `0` or the sentinel a never-recorded histogram carries - so anything
   * that is not a finite number reads as no delay, which is what an idle loop had.
   */
  private static millisecondsOf(nanoseconds: number): number {
    if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0
    return Math.round(nanoseconds / 1_000_000)
  }
}
