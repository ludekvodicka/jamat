import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostPerfMonitor } from './hostPerfMonitor.js'
import { BuildInfoSource } from './buildInfo.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, appendFile: vi.fn(actual.appendFile) }
})

const build = { version: '0.1.2', inputHash: 'b'.repeat(64), builtAt: '2026-11-02T00:00:00.000Z' }

describe('Host performance records', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers() })

  it.each([false, true])('bounds retained records through delayed I/O, releases on failure=%s and drains stop', async fail => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'host-perf-backlog-'))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const report = vi.fn()
    let mono = 0
    const perf = new HostPerfMonitor(directory, build, report, () => Date.UTC(2026, 10, 2) + mono, () => mono)
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const writing = new Promise<void>(resolve => { started = resolve })
    vi.mocked(fs.appendFile).mockImplementationOnce(async (...args) => {
      started()
      await blocked
      if (fail) throw new Error('disk full')
      await actual.appendFile(...args)
    })
    try {
      perf.start()
      for (let i = 0; i < 256; i++) { mono += 200; perf.poll() }
      await vi.advanceTimersByTimeAsync(2_000)
      await writing
      for (let interval = 0; interval < 4; interval++) {
        for (let i = 0; i < 256; i++) { mono += 200; perf.poll() }
        await vi.advanceTimersByTimeAsync(2_000)
      }
      expect(fs.appendFile).toHaveBeenCalledTimes(1)
      release()
      await perf.flush()
      expect(report).toHaveBeenCalledTimes(fail ? 1 : 0)
      const file = join(directory, 'host-2026-11-02.jsonl')
      expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1024 - (fail ? 256 : 0))

      let finish!: () => void
      const draining = new Promise<void>(resolve => { finish = resolve })
      let drainStarted!: () => void
      const drainWriting = new Promise<void>(resolve => { drainStarted = resolve })
      vi.mocked(fs.appendFile).mockImplementationOnce(async (...args) => {
        drainStarted()
        await draining
        await actual.appendFile(...args)
      })
      mono += 200
      perf.poll()
      let stopped = false
      const stopping = perf.stop().then(() => { stopped = true })
      try {
        await drainWriting
        expect(stopped).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      } finally { finish(); await stopping }
      expect(stopped).toBe(true)
      expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1025 - (fail ? 256 : 0))
    } finally { release(); await perf.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  it('writes one marker on reaching 20 MiB and prunes only Host files older than seven days', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-perf-cap-'))
    const file = join(directory, 'host-2026-11-02.jsonl')
    let mono = 0
    const perf = new HostPerfMonitor(directory, build, vi.fn(), () => Date.UTC(2026, 10, 2) + mono, () => mono)
    try {
      await writeFile(file, Buffer.alloc(20 * 1024 * 1024 - 100, 10))
      for (const name of ['host-2026-10-26.jsonl', 'host-2026-10-27.jsonl', 'main-2026-10-26.jsonl', 'keep.txt'])
        await writeFile(join(directory, name), '')
      perf.start()
      mono = 200
      perf.poll()
      await perf.flush()
      mono = 400
      perf.poll()
      await perf.stop()
      expect((await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
        .toEqual([{ v: 1, at: Date.UTC(2026, 10, 2) + 200, process: 'host', pid: process.pid, build, kind: 'truncated' }])
      expect((await readdir(directory)).sort()).toEqual(['host-2026-10-27.jsonl', 'host-2026-11-02.jsonl', 'keep.txt', 'main-2026-10-26.jsonl'])
    } finally { await perf.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  it('hashes production source, manifest and lockfile while ignoring test-only changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-perf-inputs-'))
    try {
      await mkdir(join(root, 'app'))
      for (const [file, contents] of Object.entries({ 'app/owner.ts': 'production', 'app/owner.test.ts': 'test',
        'start.ts': 'entry', 'package.json': '{"version":"1.2.3"}', 'pnpm-lock.yaml': 'dependency-v1', 'tsconfig.json': '{}' }))
        await writeFile(join(root, file), contents)
      const original = BuildInfoSource.perfBuild(root)
      await writeFile(join(root, 'app/owner.test.ts'), 'another assertion')
      expect(BuildInfoSource.perfBuild(root).inputHash).toBe(original.inputHash)
      await writeFile(join(root, 'app/owner.ts'), 'changed production')
      const source = BuildInfoSource.perfBuild(root)
      expect(source.inputHash).not.toBe(original.inputHash)
      await writeFile(join(root, 'pnpm-lock.yaml'), 'dependency-v2')
      const dependency = BuildInfoSource.perfBuild(root)
      expect(dependency.inputHash).not.toBe(source.inputHash)
      await writeFile(join(root, 'package.json'), '{"version":"1.2.4"}')
      const manifest = BuildInfoSource.perfBuild(root)
      expect(manifest.inputHash).not.toBe(dependency.inputHash)
      expect(manifest.version).toBe('1.2.4')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('records a forced 150 ms delay and drains the exact schema-v1 stall', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-perf-'))
    let clock = 0
    const at = Date.UTC(2026, 10, 2)
    const perf = new HostPerfMonitor(directory, build, vi.fn(), () => at + clock, () => clock)
    try {
      perf.start()
      clock = 200
      perf.poll()
      await perf.stop()
      expect(JSON.parse((await readFile(join(directory, 'host-2026-11-02.jsonl'), 'utf8')).trim()))
        .toEqual({ v: 1, at: at + 200, process: 'host', pid: process.pid, build, kind: 'stall', ms: 150, covered: [] })
    } finally { await perf.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  it('drops sleep gaps, emits minute samples and respects a persisted truncation marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-perf-sleep-'))
    let mono = 0, wall = Date.UTC(2026, 10, 2)
    const perf = new HostPerfMonitor(directory, build, vi.fn(), () => wall, () => mono)
    try {
      perf.start()
      wall += 60_000
      mono += 50
      perf.poll()
      await perf.flush()
      await expect(readFile(join(directory, 'host-2026-11-02.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
      for (let i = 0; i < 1200; i++) { mono += 50; wall += 50; perf.poll() }
      await perf.stop()
      const sample = JSON.parse((await readFile(join(directory, 'host-2026-11-02.jsonl'), 'utf8')).trim())
      expect(sample).toMatchObject({ v: 1, process: 'host', build, kind: 'sample', loopP99: null })
      expect(sample.elu).toBeGreaterThanOrEqual(0)
      expect(sample.heapMb).toBeGreaterThan(0)
      const marker = JSON.stringify({ v: 1, at: wall, process: 'host', pid: process.pid, build, kind: 'truncated' }) + '\n'
      await writeFile(join(directory, 'host-2026-11-02.jsonl'), marker)
      const restarted = new HostPerfMonitor(directory, build, vi.fn(), () => wall, () => mono)
      restarted.start()
      mono += 200; wall += 200
      restarted.poll()
      await restarted.stop()
      expect(await readFile(join(directory, 'host-2026-11-02.jsonl'), 'utf8')).toBe(marker)
    } finally { await perf.stop(); await rm(directory, { recursive: true, force: true }) }
  })

  it('uses the same stable package hash for source and packaging metadata without changing wire identity', () => {
    const before = BuildInfoSource.current()
    const source = BuildInfoSource.perfBuild()
    const packaging = BuildInfoSource.perfBuild(join(import.meta.dirname, '..', '..'))
    expect(packaging.inputHash).toBe(source.inputHash)
    expect(packaging.version).toBe(before.buildVersion)
    expect(packaging.inputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Number.isFinite(Date.parse(packaging.builtAt))).toBe(true)
    expect(BuildInfoSource.current()).toEqual(before)
  })
})
