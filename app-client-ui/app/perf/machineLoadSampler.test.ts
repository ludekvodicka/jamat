import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { PerfEvent } from '../../../lib-orchestrator/perfMonitor/perfRecord.types'
import { MachineLoadSampler, type ProcessCpuRow } from './machineLoadSampler'

function fixture(queryDelay = 0) {
  let at = 0, user = 0, idle = 0, generation = 0
  const events: PerfEvent[] = []
  const times: number[] = []
  const power = new EventEmitter()
  const query = vi.fn(async (): Promise<ProcessCpuRow[]> => {
    generation++
    at += queryDelay
    return [
      { pid: 1, parent: 0, startedAt: 1, image: 'agent.exe', cpuSeconds: generation },
      { pid: 2, parent: 1, startedAt: 2, image: 'cmd.exe', cpuSeconds: generation },
      { pid: 3, parent: 2, startedAt: 3, image: 'node.exe', cpuSeconds: generation * 120 },
      { pid: 99, parent: 0, startedAt: 1, image: 'electron.exe', cpuSeconds: generation * 24 },
    ]
  })
  const sampler = new MachineLoadSampler({ emit: (event, time) => { events.push(event); times.push(time) }, power, query, notify: vi.fn(), report: vi.fn(),
    roots: () => [{ pid: 1, startedAt: 1, sessionId: 'session', session: 'i34', sessionKind: 'agent', idle: true }],
    ownPids: () => [99], now: () => at, monotonic: () => at,
    readCpu: () => Array.from({ length: 4 }, () => ({ model: 'fixture', speed: 1, times: { user, idle, nice: 0, sys: 0, irq: 0 } })),
  })
  return { sampler, query, events, times, power, tick: async (busy: number) => { at += 60_000; user += busy * 100; idle += (1 - busy) * 100; await sampler.poll() } }
}

describe('machine CPU and attribution', () => {
  it('retains the OS sample timestamp across a delayed CIM response and stamps power events at delivery', async () => {
    const f = fixture(5_000)
    f.sampler.start()
    try {
      await f.tick(0.8)
      await f.tick(0.8)
      await f.tick(0.8)
      expect(f.times).toEqual([60_000, 120_000, 185_000, 185_000])
      f.power.emit('suspend')
      expect(f.times.at(-1)).toBe(190_000)
    } finally { await f.sampler.stop() }
  })
  it('does not query at 40 percent and preserves missing own CPU as null', async () => {
    const f = fixture()
    try {
      await f.tick(0.4)
      expect(f.query).not.toHaveBeenCalled()
      expect(f.events).toEqual([{ kind: 'machine', cpu: 0.4, jamatCpu: null }])
    } finally { await f.sampler.stop() }
  })

  it('requires two hot samples, then attributes process deltas through the complete parent chain', async () => {
    const f = fixture()
    try {
      await f.tick(0.8)
      expect(f.query).not.toHaveBeenCalled()
      await f.tick(0.8)
      expect(f.query).toHaveBeenCalledTimes(1)
      expect(f.events.filter(event => event.kind === 'external')).toEqual([])
      await f.tick(0.8)
      expect(f.query).toHaveBeenCalledTimes(2)
      expect(f.events.at(-2)).toEqual({ kind: 'machine', cpu: 0.8, jamatCpu: 0.1 })
      const outside = f.events.at(-1)
      expect(outside?.kind).toBe('external')
      if (outside?.kind !== 'external') throw new Error('Missing external sample')
      expect(outside.top[0]).toEqual({ image: 'node.exe', cores: 2, session: 'i34', sessionKind: 'agent' })
      expect(outside.top.some(row => row.image === 'electron.exe')).toBe(false)
    } finally { await f.sampler.stop() }
  })

  it('gets suspend/resume from power events and releases both listeners at stop', async () => {
    const f = fixture()
    f.sampler.start()
    f.power.emit('suspend')
    f.power.emit('resume')
    expect(f.events).toEqual([{ kind: 'suspend' }, { kind: 'resume' }])
    await f.sampler.stop()
    expect(f.power.listenerCount('suspend')).toBe(0)
    expect(f.power.listenerCount('resume')).toBe(0)
  })

})
