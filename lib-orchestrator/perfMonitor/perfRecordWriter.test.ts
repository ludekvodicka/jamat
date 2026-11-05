import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerfNames } from './perfNames'
import { PerfRecordWriter } from './perfRecordWriter'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, appendFile: vi.fn(actual.appendFile) }
})

const record = { v: 1 as const, at: Date.UTC(2026, 10, 2), process: 'main' as const, pid: 123,
  build: { version: '3.10.0', inputHash: 'a'.repeat(64), builtAt: '2026-11-02T00:00:00.000Z' },
  kind: 'span' as const, name: 'records.commit', ms: 150, selfMs: 150, depth: 0, blocking: true }

describe('perf record writer', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers() })

  it('batches two seconds into one append and refuses unknown names and extra payload fields', async () => {
    vi.useFakeTimers()
    const directory = await fs.mkdtemp(join(tmpdir(), 'perf-writer-'))
    const append = vi.spyOn(fs, 'appendFile')
    const writer = new PerfRecordWriter(directory, new PerfNames(), vi.fn())
    try {
      writer.start()
      writer.record([record, { ...record, name: 'session-private-title' }, { ...record, token: 'private' }])
      await vi.advanceTimersByTimeAsync(1_000)
      writer.record([record])
      await vi.advanceTimersByTimeAsync(999)
      expect(append).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await writer.flush()
      expect(append).toHaveBeenCalledTimes(1)
      expect(writer.rejected).toBe(2)
      const contents = await fs.readFile(join(directory, 'main-2026-11-02.jsonl'), 'utf8')
      expect(contents.trim().split('\n')).toHaveLength(2)
      expect(contents).not.toContain('private')
    } finally { await writer.stop(); await fs.rm(directory, { recursive: true, force: true }) }
  })

  it.each([false, true])('bounds retained batches through delayed I/O, releases on failure=%s and drains stop', async fail => {
    vi.useFakeTimers()
    const directory = await fs.mkdtemp(join(tmpdir(), 'perf-backlog-'))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const report = vi.fn()
    const writer = new PerfRecordWriter(directory, new PerfNames(), report)
    const capacity = Math.floor(1024 * 1024 / (Buffer.byteLength(JSON.stringify(record)) + 1))
    const chunk = Math.ceil(capacity / 3)
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
      writer.start()
      writer.record(Array(chunk).fill(record))
      await vi.advanceTimersByTimeAsync(2_000)
      await writing
      for (let interval = 0; interval < 4; interval++) {
        writer.record(Array(chunk).fill(record))
        await vi.advanceTimersByTimeAsync(2_000)
      }
      expect(fs.appendFile).toHaveBeenCalledTimes(1)
      expect(writer.dropped).toBe(5 * chunk - capacity)
      release()
      await writer.flush()
      expect(writer.dropped).toBe(5 * chunk - capacity + (fail ? chunk : 0))
      expect(report).toHaveBeenCalledTimes(fail ? 1 : 0)
      const file = join(directory, 'main-2026-11-02.jsonl')
      expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(capacity - (fail ? chunk : 0))

      let finish!: () => void
      const draining = new Promise<void>(resolve => { finish = resolve })
      let drainStarted!: () => void
      const drainWriting = new Promise<void>(resolve => { drainStarted = resolve })
      vi.mocked(fs.appendFile).mockImplementationOnce(async (...args) => {
        drainStarted()
        await draining
        await actual.appendFile(...args)
      })
      writer.record([record])
      let stopped = false
      const stopping = writer.stop().then(() => { stopped = true })
      try {
        await drainWriting
        expect(stopped).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
        writer.record([record])
      } finally { finish(); await stopping }
      expect(stopped).toBe(true)
      expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(capacity - (fail ? chunk : 0) + 1)
    } finally { release(); await writer.stop(); await fs.rm(directory, { recursive: true, force: true }) }
  })

  it('writes a single truncation marker at the cap, including across writer restarts', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'perf-cap-'))
    const file = join(directory, 'main-2026-11-02.jsonl')
    await fs.writeFile(file, Buffer.alloc(PerfRecordWriter.fileBytes, 10))
    try {
      for (let run = 0; run < 2; run++) {
        const writer = new PerfRecordWriter(directory, new PerfNames(), vi.fn())
        writer.record([record, record])
        await writer.stop()
      }
      const contents = await fs.readFile(file, 'utf8')
      expect(contents.trim().split('\n').map(line => JSON.parse(line))).toEqual([
        { v: 1, at: record.at, process: 'main', pid: 123, build: record.build, kind: 'truncated' },
      ])
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })

  it('retains seven calendar days and leaves other processes and unrelated files alone', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'perf-retention-'))
    const writer = new PerfRecordWriter(directory, new PerfNames(), vi.fn())
    try {
      for (const file of ['main-2026-10-26.jsonl', 'main-2026-10-27.jsonl', 'host-2026-10-26.jsonl', 'notes.txt'])
        await fs.writeFile(join(directory, file), '')
      writer.record([record])
      await writer.stop()
      expect((await fs.readdir(directory)).sort()).toEqual([
        'host-2026-10-26.jsonl', 'main-2026-10-27.jsonl', 'main-2026-11-02.jsonl', 'notes.txt',
      ])
    } finally { await writer.stop(); await fs.rm(directory, { recursive: true, force: true }) }
  })

  it('reports an append failure, drops that batch and accepts a later batch', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'perf-failure-'))
    const report = vi.fn()
    const writer = new PerfRecordWriter(directory, new PerfNames(), report)
    try {
      vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'))
      writer.record([record])
      await writer.flush()
      expect(report).toHaveBeenCalledTimes(1)
      expect(writer.dropped).toBe(1)
      writer.record([record])
      await writer.stop()
      expect((await fs.readFile(join(directory, 'main-2026-11-02.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    } finally { await writer.stop(); await fs.rm(directory, { recursive: true, force: true }) }
  })
})
