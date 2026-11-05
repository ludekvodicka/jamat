import { performance, type EventLoopUtilization } from 'node:perf_hooks'
import { expect, it, vi } from 'vitest'
import { WorkerPerfSampler, type WorkerPerfSample } from './workerPerfSampler'

it('records interval utilization across changing cumulative snapshots and stops sampling', () => {
  vi.useFakeTimers()
  const snapshots = [
    { idle: 10, active: 10, utilization: 0.5 },
    { idle: 20, active: 20, utilization: 0.5 },
    { idle: 50, active: 30, utilization: 0.375 },
  ]
  const samples: WorkerPerfSample[] = []
  const sampler = new WorkerPerfSampler({ performance: {
    eventLoopUtilization: (a?: EventLoopUtilization, b?: EventLoopUtilization) =>
      a && b ? performance.eventLoopUtilization(a, b) : snapshots.shift()!,
  } }, sample => samples.push(sample))
  try {
    vi.advanceTimersByTime(120_000)
    expect(samples).toEqual([
      { kind: 'sample', elu: 0.5, loopP50: null, loopP99: null, loopMax: null, heapMb: null },
      { kind: 'sample', elu: 0.25, loopP50: null, loopP99: null, loopMax: null, heapMb: null },
    ])
    expect(snapshots).toHaveLength(0)
    sampler.stop()
    vi.advanceTimersByTime(120_000)
    expect(samples).toHaveLength(2)
  } finally { sampler.stop(); vi.useRealTimers() }
})
