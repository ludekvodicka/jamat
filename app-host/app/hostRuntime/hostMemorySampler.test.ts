import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HostMemorySampler, type HostMemoryUsage } from './hostMemorySampler.js'

describe('app-host/app/hostRuntime/hostMemorySampler', () => {
  const minute = 60_000
  const startedAt = Date.UTC(2026, 9, 13, 8, 0, 0)
  let rss = 100

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(startedAt)
    rss = 100
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function sampler(): HostMemorySampler {
    return new HostMemorySampler({
      startedAt,
      memoryUsage: (): HostMemoryUsage => ({ rss, heapUsed: rss / 2, external: rss / 4 }),
    })
  }

  it('samples once at start and every ten minutes after it', () => {
    const memory = sampler()
    memory.start()
    rss = 200
    vi.advanceTimersByTime(9 * minute)
    expect(memory.reading().samples.map((sample) => sample.at)).toEqual([startedAt, startedAt + 9 * minute])

    vi.advanceTimersByTime(minute)
    expect(memory.reading().samples.map((sample) => sample.rssBytes)).toEqual([100, 200, 200])
    memory.stop()
  })

  it('answers the history and a fresh sample with its start and cadence', () => {
    const memory = sampler()
    memory.start()
    vi.advanceTimersByTime(10 * minute)
    rss = 300
    vi.advanceTimersByTime(minute)

    expect(memory.reading()).toEqual({
      startedAt,
      sampleEveryMs: 10 * minute,
      samples: [
        { at: startedAt, rssBytes: 100, heapUsedBytes: 50, externalBytes: 25 },
        { at: startedAt + 10 * minute, rssBytes: 100, heapUsedBytes: 50, externalBytes: 25 },
        { at: startedAt + 11 * minute, rssBytes: 300, heapUsedBytes: 150, externalBytes: 75 },
      ],
    })
    // the answer's own sample is not kept: a second read still has two periodic samples before it
    expect(memory.reading().samples).toHaveLength(3)
    memory.stop()
  })

  it('keeps no sample older than 25 hours, so the ring stays bounded', () => {
    const memory = sampler()
    memory.start()
    vi.advanceTimersByTime(48 * 60 * minute)

    const kept = memory.reading().samples.slice(0, -1)
    const newest = kept[kept.length - 1].at
    expect(kept.length).toBeLessThanOrEqual(HostMemorySampler.maxSamplesConst)
    expect(kept.length).toBe(151)
    expect(newest - kept[0].at).toBe(25 * 60 * minute)
    memory.stop()
  })

  it('stops sampling when stopped', () => {
    const memory = sampler()
    memory.start()
    expect(vi.getTimerCount()).toBe(1)

    memory.stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60 * minute)
    expect(memory.reading().samples).toHaveLength(2)
  })

  it('starts one timer however often it is started', () => {
    const memory = sampler()
    memory.start()
    memory.start()
    expect(vi.getTimerCount()).toBe(1)
    memory.stop()
  })
})
