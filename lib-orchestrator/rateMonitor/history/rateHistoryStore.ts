import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonShape } from '../../shared/jsonShape'
import { RateMonitorCacheStore } from '../cache/rateMonitorCacheStore'
import type { RateSample, RateWindow } from '../rateMonitorApi.types'

export type { RateSample } from '../rateMonitorApi.types'

interface ParsedMonth { mtimeMs: number; size: number; consumed: number; samples: readonly RateSample[] }

/**
 * Monthly append-only JSONL files. Each file's parsed samples stay in memory, and a file that grew is
 * read only from its last complete line: every `usage.history` used to read and parse every month in
 * range again (4 MB on the orchestrator's main thread, in 6 of 10 CPU profiles on 2026-11-25).
 */
export class RateHistoryStore {
  private readonly directory: string
  private readonly last = new Map<string, RateSample>()
  private readonly parsed = new Map<string, ParsedMonth>()
  private queue: Promise<void> = Promise.resolve()

  constructor(directory: string) { this.directory = directory }

  append(sample: RateSample): Promise<void> {
    const work = this.queue.then(() => this.write(sample))
    this.queue = work.catch(() => {})
    return work
  }

  flush(): Promise<void> { return this.queue }

  backfill(samples: readonly RateSample[]): Promise<void> {
    if (samples.length === 0) return Promise.resolve()
    const work = this.queue.then(async () => {
      const ordered = [...samples].sort((a, b) => a.at - b.at)
      const existing = await this.readFiles({ from: ordered[0].at - 300_000, to: ordered.at(-1)!.at })
      const signature = (sample: RateSample) => JSON.stringify([sample.agentId, sample.accountId, sample.at, sample.windows])
      const known = new Set(existing.map(signature))
      const previous = new Map<string, RateSample>()
      const events = [...existing.map(sample => ({ sample, stored: true })), ...ordered.map(sample => ({ sample, stored: false }))]
        .sort((a, b) => a.sample.at - b.sample.at || Number(b.stored) - Number(a.stored))
      for (const { sample, stored } of events) {
        const key = `${sample.agentId}/${sample.accountId}`, last = previous.get(key)
        if (stored) previous.set(key, sample)
        else if (!known.has(signature(sample)) && !(last && sample.at - last.at < 300_000
          && JSON.stringify(last.windows) === JSON.stringify(sample.windows))) {
          await this.write(sample)
          known.add(signature(sample))
          previous.set(key, sample)
        }
      }
    })
    this.queue = work.catch(() => {})
    return work
  }

  async read(range: { from: number; to: number }): Promise<readonly RateSample[]> {
    await this.queue
    return this.readFiles(range)
  }

  private async readFiles(range: { from: number; to: number }): Promise<readonly RateSample[]> {
    const samples: RateSample[] = []
    const files = await this.files()
    for (const file of [...this.parsed.keys()]) if (!files.includes(file)) this.parsed.delete(file)
    for (const file of files) {
      const start = Date.parse(`${file.slice(0, 7)}-01T00:00:00Z`)
      const date = new Date(start)
      const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
      if (end <= range.from || start > range.to) continue
      for (const sample of await this.month(file))
        if (sample.at >= range.from && sample.at <= range.to) samples.push(sample)
    }
    return samples.sort((a, b) => a.at - b.at)
  }

  private async month(file: string): Promise<readonly RateSample[]> {
    const path = join(this.directory, file)
    let info: { mtimeMs: number; size: number }
    try { info = await stat(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.parsed.delete(file)
      return []
    }
    let cached = this.parsed.get(file)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.samples
    // Only an append keeps what was parsed; a shorter or older file is read again from its start.
    if (!cached || info.size < cached.consumed || info.mtimeMs < cached.mtimeMs) cached = { mtimeMs: 0, size: 0, consumed: 0, samples: [] }
    const bytes = await RateHistoryStore.readFrom(path, cached.consumed, info.size)
    // A tail without its newline is a write in progress or a crashed append; it is read once complete.
    const complete = bytes.lastIndexOf(0x0a) + 1
    const samples = [...cached.samples]
    for (const line of bytes.subarray(0, complete).toString('utf8').split('\n')) {
      let sample: RateSample | null
      try { sample = RateHistoryStore.sampleOf(JSON.parse(line)) } catch { continue }
      if (sample) samples.push(sample)
    }
    this.parsed.set(file, { mtimeMs: info.mtimeMs, size: info.size, consumed: cached.consumed + complete, samples })
    return samples
  }

  private static async readFrom(path: string, from: number, to: number): Promise<Buffer> {
    if (to <= from) return Buffer.alloc(0)
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(to - from)
      let filled = 0
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, from + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return buffer.subarray(0, filled)
    } finally { await handle.close() }
  }

  async prune(now: number): Promise<void> {
    await this.queue
    const cutoff = now - 90 * 24 * 60 * 60_000
    for (const file of await this.files()) {
      const start = new Date(`${file.slice(0, 7)}-01T00:00:00Z`)
      if (Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) <= cutoff)
        await unlink(join(this.directory, file))
    }
  }

  private async write(sample: RateSample): Promise<void> {
    const key = `${sample.agentId}/${sample.accountId}`
    if (!this.last.has(key)) {
      const recent = await this.readFiles({ from: sample.at - 300_000, to: sample.at })
      for (const item of recent)
        if (item.agentId === sample.agentId && item.accountId === sample.accountId) this.last.set(key, item)
    }
    const previous = this.last.get(key)
    if (previous && sample.at >= previous.at && sample.at - previous.at < 300_000
      && JSON.stringify(sample.windows) === JSON.stringify(previous.windows)) return
    await mkdir(this.directory, { recursive: true })
    const file = join(this.directory, `${new Date(sample.at).toISOString().slice(0, 7)}.jsonl`)
    // A crashed append can leave a partial JSON value; separate the next record from that tail.
    let prefix = ''
    try {
      const size = (await stat(file)).size
      if (size > 0 && (await RateHistoryStore.readFrom(file, size - 1, size))[0] !== 0x0a) prefix = '\n'
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await appendFile(file, prefix + JSON.stringify(sample) + '\n', 'utf8')
    if (!previous || sample.at >= previous.at) this.last.set(key, sample)
  }

  private async files(): Promise<string[]> {
    try { return (await readdir(this.directory)).filter(file => /^\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(file)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private static sampleOf(value: unknown): RateSample | null {
    const row = JsonShape.record(value)
    if (!row || typeof row.at !== 'number' || !Number.isFinite(row.at)
      || (row.agentId !== 'claude' && row.agentId !== 'codex' && row.agentId !== 'antigravity') || typeof row.accountId !== 'string'
      || (row.source !== 'poll' && row.source !== 'statusline' && row.source !== 'rollout') || !Array.isArray(row.windows)) return null
    const windows: RateWindow[] = []
    for (const value of row.windows) {
      const window = RateMonitorCacheStore.windowOf(value)
      if (window === null) return null
      windows.push(window)
    }
    return { at: row.at, agentId: row.agentId, accountId: row.accountId, source: row.source, windows }
  }
}
