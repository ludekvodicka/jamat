import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonShape } from '../../shared/jsonShape'
import { RateMonitorCacheStore } from '../cache/rateMonitorCacheStore'
import type { RateSample, RateWindow } from '../rateMonitorApi.types'

export type { RateSample } from '../rateMonitorApi.types'

export class RateHistoryStore {
  private readonly directory: string
  private readonly last = new Map<string, RateSample>()
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
    for (const file of await this.files()) {
      const start = Date.parse(`${file.slice(0, 7)}-01T00:00:00Z`)
      const date = new Date(start)
      const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
      if (end <= range.from || start > range.to) continue
      const text = await readFile(join(this.directory, file), 'utf8')
      for (const line of text.split('\n')) {
        let sample: RateSample | null
        try { sample = RateHistoryStore.sampleOf(JSON.parse(line)) } catch { continue }
        if (sample && sample.at >= range.from && sample.at <= range.to) samples.push(sample)
      }
    }
    return samples.sort((a, b) => a.at - b.at)
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
      const existing = await readFile(file, 'utf8')
      if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n'
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
      || (row.agentId !== 'claude' && row.agentId !== 'codex') || typeof row.accountId !== 'string'
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
