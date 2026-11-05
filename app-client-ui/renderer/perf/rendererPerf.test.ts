import { afterEach, describe, expect, it, vi } from 'vitest'
import { RendererPerf, type RendererPerfEvent } from './rendererPerf'

afterEach(() => vi.useRealTimers())

describe('renderer performance', () => {
  it('measures sent input to the next output of the same attach, ignoring status', () => {
    vi.useFakeTimers()
    let now = 0
    const perf = new RendererPerf(() => now, () => now)
    const batches: RendererPerfEvent[][] = []
    perf.start(batch => batches.push(batch))
    perf.input('one')
    now = 10
    perf.frame('one', { type: 'terminal.snapshot-start', streamId: 's', index: 0, reset: true, projection: { runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, outputSeq: 1, cols: 80, rows: 24, alive: true, lastOutputAt: null } })
    perf.frame('one', { type: 'terminal.snapshot-chunk', streamId: 's', index: 1, data: 'history' })
    perf.frame('one', { type: 'terminal.snapshot-end', streamId: 's', index: 2 })
    perf.frame('one', { type: 'terminal.snapshot-complete', streamId: 's' })
    perf.frame('one', { type: 'terminal.status', status: 'connecting', detail: null })
    perf.frame('other', { type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, delta: 'ignored', outputSeq: 1, lastOutputAt: 0 })
    now = 30
    perf.frame('one', { type: 'terminal.data', runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, delta: 'output', outputSeq: 2, lastOutputAt: 30 })
    perf.sample()
    vi.advanceTimersByTime(10_000)
    expect(batches.flat().filter(row => row.kind === 'inputToFrame'))
      .toEqual([{ kind: 'inputToFrame', at: 30, p50: 30, p99: 30, count: 1 }])
    perf.stop()
  })

  it('bounds the longtask batch and reports unavailable metrics as null', () => {
    vi.useFakeTimers()
    const batches: RendererPerfEvent[][] = []
    const perf = new RendererPerf()
    perf.start(batch => batches.push(batch))
    for (let i = 0; i < 1000; i++) perf.longTask(150)
    perf.sample()
    vi.advanceTimersByTime(10_000)
    expect(batches[0]).toHaveLength(257)
    expect(batches[0].at(-1)).toMatchObject({ kind: 'sample', elu: null, heapMb: null, loopP99: 150 })
    perf.stop()
  })
})
