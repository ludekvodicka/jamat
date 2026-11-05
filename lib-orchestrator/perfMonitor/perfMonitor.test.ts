import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerfLoopSampler } from './perfLoopSampler'
import { PerfMonitor } from './perfMonitor'
import { PerfNames } from './perfNames'
import type { PerfEvent } from './perfRecord.types'

describe('performance monitoring', () => {
  afterEach(() => vi.useRealTimers())

  it('observes ELU each second without adding sample records and resets that interval on sleep', () => {
    vi.useFakeTimers()
    let wall = 0, mono = 0
    const observe = vi.fn(), emit = vi.fn()
    const sampler = new PerfLoopSampler(emit, () => wall, () => mono, observe)
    sampler.start()
    wall = 999; mono = 999
    sampler.poll()
    expect(observe).not.toHaveBeenCalled()
    wall = 1_000; mono = 1_000
    sampler.poll()
    expect(observe).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 1_000)
    expect(emit.mock.calls.some(call => call[0].kind === 'sample')).toBe(false)
    wall += 6_100; mono += 100
    sampler.poll()
    expect(observe.mock.lastCall).toEqual([null, 0])
    sampler.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records nested exclusive blocking time, a throwing span, and async wall time separately', async () => {
    let mono = 0
    const monitor = new PerfMonitor({ process: 'main', directory: 'unused', names: new PerfNames(), report: vi.fn(),
      build: { version: '3.10.0', inputHash: 'a'.repeat(64), builtAt: new Date(0).toISOString() },
      now: () => mono, monotonic: () => mono })
    const events: PerfEvent[] = []
    vi.spyOn(monitor, 'event').mockImplementation(event => { events.push(event) })
    expect(() => monitor.span('sessions.recompose', () => {
      mono += 20
      monitor.span('records.commit', () => { mono += 60 })
      mono += 20
      throw new Error('original')
    })).toThrow('original')
    expect(events).toEqual([
      { kind: 'span', name: 'records.commit', ms: 60, selfMs: 60, depth: 1, blocking: true },
      { kind: 'span', name: 'sessions.recompose', ms: 100, selfMs: 40, depth: 0, blocking: true },
    ])
    await monitor.operation('finish.commit', async () => { await Promise.resolve(); mono += 2_100 })
    expect(events[2]).toEqual({ kind: 'span', name: 'finish.commit', ms: 2_100, selfMs: 2_100, depth: 0, blocking: false })
    expect(monitor.span('other', () => 42)).toBe(42)
    expect(events).toHaveLength(3)
  })

  it('measures a 150 ms loop stall and excludes sleep from wall-clock gaps', () => {
    vi.useFakeTimers()
    let wall = Date.UTC(2026, 10, 2)
    let mono = 0
    const events: PerfEvent[] = []
    const sampler = new PerfLoopSampler(event => events.push(event), () => wall, () => mono)
    sampler.start()
    wall += 200; mono += 200
    sampler.poll()
    expect(events).toEqual([{ kind: 'stall', ms: 150, covered: [] }])
    wall += 6_000; mono += 100
    sampler.poll()
    expect(events).toHaveLength(1)
    sampler.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('writes samples with build identity and drains the pending records on stop', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'perf-monitor-'))
    const now = Date.UTC(2026, 10, 2)
    let mono = 0
    const report = vi.fn()
    const monitor = new PerfMonitor({ process: 'main', directory, names: new PerfNames(), report,
      build: { version: '3.10.0', inputHash: 'a'.repeat(64), builtAt: new Date(now).toISOString() },
      now: () => now + mono, monotonic: () => mono })
    try {
      monitor.start()
      monitor.start()
      for (let index = 0; index < 1_200; index++) {
        mono += 50
        await vi.advanceTimersByTimeAsync(50)
      }
      await monitor.stop()
      const records = (await readFile(join(directory, 'main-2026-11-02.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ v: 1, kind: 'sample', process: 'main', pid: process.pid,
        build: { version: '3.10.0', inputHash: 'a'.repeat(64) } })
      expect(report).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { await monitor.stop(); await rm(directory, { recursive: true, force: true }) }
  })
})
