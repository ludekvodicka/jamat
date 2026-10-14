import type { HostHealthResult, HostMemorySample } from '../wire/hostWire.js'

export type HostMemoryUsage = Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'external'>

export interface HostMemorySamplerDeps {
  startedAt: number
  now?: () => number
  memoryUsage?: () => HostMemoryUsage
}

/**
 * The Host's memory over its last day, kept by the Host itself because it outlives every client: a
 * client that restarts still reads the growth since this process began. The history is a bounded
 * ring in memory and nothing more; a new Host starts it again, which is what its numbers describe.
 */
export class HostMemorySampler {
  static readonly sampleEveryMillisecondsConst = 10 * 60_000
  static readonly keepMillisecondsConst = 25 * 60 * 60_000
  /** The kept span holds 151 samples on time; the cap is what bounds a clock that jumps back. */
  static readonly maxSamplesConst = 160
  private readonly startedAt: number
  private readonly now: () => number
  private readonly memoryUsage: () => HostMemoryUsage
  private readonly samples: HostMemorySample[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: HostMemorySamplerDeps) {
    this.startedAt = deps.startedAt
    this.now = deps.now ?? (() => Date.now())
    this.memoryUsage = deps.memoryUsage ?? (() => process.memoryUsage())
  }

  start(): void {
    if (this.timer !== null) return
    this.record()
    this.timer = setInterval(() => this.record(), HostMemorySampler.sampleEveryMillisecondsConst)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** The sample taken for the answer is not kept, so a frequent reader does not shorten the history. */
  reading(): HostHealthResult {
    return {
      startedAt: this.startedAt,
      sampleEveryMs: HostMemorySampler.sampleEveryMillisecondsConst,
      samples: [...this.samples, this.sample()],
    }
  }

  private record(): void {
    const sample = this.sample()
    this.samples.push(sample)
    const oldest = sample.at - HostMemorySampler.keepMillisecondsConst
    while (this.samples.length > HostMemorySampler.maxSamplesConst || this.samples[0].at < oldest)
      this.samples.shift()
  }

  private sample(): HostMemorySample {
    const usage = this.memoryUsage()
    return {
      at: this.now(),
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
    }
  }
}
