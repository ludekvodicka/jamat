import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerfMonitor } from './perfMonitor'
import { PerfNames } from './perfNames'
import { PerfProfiler } from './perfProfiler'
import type { PerfRecord } from './perfRecord.types'

const inspector = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), post: vi.fn() }))
vi.mock('node:inspector/promises', () => ({ Session: class {
  connect: typeof inspector.connect
  disconnect: typeof inspector.disconnect
  post: typeof inspector.post
  constructor() {
    this.connect = inspector.connect
    this.disconnect = inspector.disconnect
    this.post = inspector.post
  }
} }))

const build = { version: '3.10.0', inputHash: 'a'.repeat(64), builtAt: '2026-11-02T00:00:00.000Z' }
const epoch = Date.UTC(2026, 10, 2)
const roots: string[] = []
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'perf-profiler-'))
  roots.push(root)
  await mkdir(join(root, 'profiles'))
  return root
}
async function records(root: string): Promise<PerfRecord[]> {
  return (await readFile(join(root, 'main-2026-11-02.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

describe('automatic CPU profiles', () => {
  afterEach(async () => {
    vi.useRealTimers()
    vi.resetAllMocks()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('connects an in-process session, records ten seconds and disconnects after success or failure', async () => {
    vi.useFakeTimers()
    const root = await directory()
    const profile = { nodes: [], startTime: 1, endTime: 10_000_001, samples: [] }
    inspector.post.mockImplementation(async (method: string) => {
      if (method === 'Profiler.enable' || method === 'Profiler.start') return undefined
      else if (method === 'Profiler.stop') return { profile }
      else throw new Error(`Unexpected inspector method ${method}`)
    })
    const profiler = new PerfProfiler(join(root, 'profiles'), 'main')
    const recording = profiler.record(10)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(inspector.post.mock.calls.map(call => call[0])).toEqual(['Profiler.enable', 'Profiler.start'])
    await vi.advanceTimersByTimeAsync(1)
    const id = await recording
    expect(id).toMatch(/^main-[\d]+-[a-f\d-]+\.cpuprofile$/)
    expect(JSON.parse(await readFile(join(root, 'profiles', id), 'utf8'))).toEqual(profile)
    expect(inspector.connect).toHaveBeenCalledOnce()
    expect(inspector.disconnect).toHaveBeenCalledOnce()
    inspector.post.mockRejectedValueOnce(new Error('inspector unavailable'))
    await expect(profiler.record(10)).rejects.toThrow('inspector unavailable')
    expect(inspector.disconnect).toHaveBeenCalledTimes(2)
    expect(await readdir(join(root, 'profiles'))).toEqual([id])
  })

  it('requires ten high-ELU seconds, resets low/sleep intervals, and applies a ten-minute cooldown', async () => {
    vi.useFakeTimers()
    const root = await directory()
    let mono = 0
    const record = vi.fn(async () => {
      const id = `main-${mono}.cpuprofile`
      await writeFile(join(root, 'profiles', id), '{}')
      return id
    })
    const report = vi.fn()
    const monitor = new PerfMonitor({ process: 'main', build, directory: root, names: new PerfNames(), report,
      profiler: { record }, now: () => epoch + mono, monotonic: () => mono })
    const event = vi.spyOn(monitor, 'event')
    const high = (seconds: number) => {
      for (let index = 0; index < seconds; index++) { mono += 1_000; monitor.observeUtilization(0.5, 1_000) }
    }
    high(9)
    monitor.observeUtilization(0.49, 1_000)
    high(9)
    monitor.observeUtilization(null, 0)
    high(9)
    expect(record).not.toHaveBeenCalled()
    high(1)
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith(expect.objectContaining({ kind: 'profile', trigger: 'elu' })))
    expect(record).toHaveBeenCalledExactlyOnceWith(10)
    high(10)
    monitor.event({ kind: 'stall', ms: 1_500, covered: [] })
    expect(record).toHaveBeenCalledTimes(1)
    mono += 600_000
    monitor.event({ kind: 'stall', ms: 1_500, covered: [] })
    await monitor.stop()
    expect(record).toHaveBeenCalledTimes(2)
    expect((await records(root)).filter(row => row.kind === 'profile').map(row => row.trigger)).toEqual(['elu', 'stall'])
    expect(report).not.toHaveBeenCalled()
  })

  it('profiles only unattributed stalls and removes the oldest of eleven profiles for its own process', async () => {
    const root = await directory()
    for (let index = 0; index < 10; index++) {
      const file = join(root, 'profiles', `main-old-${index}.cpuprofile`)
      await writeFile(file, '{}')
      await utimes(file, index + 1, index + 1)
    }
    await writeFile(join(root, 'profiles', 'gateway-keep.cpuprofile'), '{}')
    let mono = 0
    const record = vi.fn(async () => {
      await writeFile(join(root, 'profiles', 'main-new.cpuprofile'), '{}')
      return 'main-new.cpuprofile'
    })
    const report = vi.fn()
    const monitor = new PerfMonitor({ process: 'main', build, directory: root, names: new PerfNames(), report,
      profiler: { record }, now: () => epoch + mono, monotonic: () => mono })
    monitor.span('sessions.recompose', () => { mono += 1_500 })
    monitor.event({ kind: 'stall', ms: 1_450, covered: [] })
    expect(record).not.toHaveBeenCalled()
    mono += 2_000
    monitor.event({ kind: 'stall', ms: 1_500, covered: [] })
    await monitor.stop()
    const files = await readdir(join(root, 'profiles'))
    expect(files.filter(file => file.startsWith('main-'))).toHaveLength(10)
    expect(files).not.toContain('main-old-0.cpuprofile')
    expect(files).toContain('gateway-keep.cpuprofile')
    expect(files).toContain('main-new.cpuprofile')
    expect((await records(root)).filter(row => row.kind === 'profile')).toHaveLength(1)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports one failure without a profile record or propagated exception', async () => {
    const root = await directory()
    const report = vi.fn()
    const record = vi.fn(async () => { throw new Error('private failure detail') })
    const monitor = new PerfMonitor({ process: 'main', build, directory: root, names: new PerfNames(), report,
      profiler: { record }, now: () => epoch, monotonic: () => 0 })
    monitor.event({ kind: 'stall', ms: 1_000, covered: [] })
    monitor.event({ kind: 'stall', ms: 1_000, covered: [] })
    await expect(monitor.stop()).resolves.toBeUndefined()
    expect(record).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledExactlyOnceWith('Automatic CPU profile could not be recorded.')
    expect((await records(root)).filter(row => row.kind === 'profile')).toEqual([])
  })

  it('waits for an in-flight recording before the final record flush', async () => {
    const root = await directory()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const monitor = new PerfMonitor({ process: 'main', build, directory: root, names: new PerfNames(), report: vi.fn(),
      profiler: { record: async () => { await pending; return 'main-final.cpuprofile' } },
      now: () => epoch, monotonic: () => 0 })
    monitor.event({ kind: 'stall', ms: 1_000, covered: [] })
    let stopped = false
    const stop = monitor.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    await writeFile(join(root, 'profiles', 'main-final.cpuprofile'), '{}')
    finish()
    await stop
    expect(stopped).toBe(true)
    expect((await records(root)).filter(row => row.kind === 'profile')).toMatchObject([{ profileId: 'main-final.cpuprofile' }])
  })
})
