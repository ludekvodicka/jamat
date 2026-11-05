import { appendFile, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { PerfNames } from './perfNames'
import type { PerfRecord } from './perfRecord.types'

export class PerfRecordWriter {
  private readonly directory: string
  private readonly names: PerfNames
  private readonly report: (message: string) => void
  private pending: PerfRecord[]
  private pendingBytes: number
  private retainedBytes: number
  private timer: ReturnType<typeof setInterval> | null
  private queue: Promise<void>
  private readonly files: Map<string, { bytes: number; truncated: boolean }>
  private stopped: boolean
  rejected: number
  dropped: number
  static readonly fileBytes = 20 * 1024 * 1024

  constructor(directory: string, names: PerfNames, report: (message: string) => void) {
    this.directory = directory
    this.names = names
    this.report = report
    this.pending = []
    this.pendingBytes = 0
    this.retainedBytes = 0
    this.timer = null
    this.queue = Promise.resolve()
    this.files = new Map()
    this.stopped = false
    this.rejected = 0
    this.dropped = 0
  }

  start(): void {
    if (this.timer !== null || this.stopped) return
    this.timer = setInterval(() => { void this.flush() }, 2_000)
    this.timer.unref()
  }

  record(records: readonly unknown[]): void {
    if (this.stopped) return
    for (const value of records) {
      const record = this.names.record(value)
      if (record === null) { this.rejected++; continue }
      const bytes = Buffer.byteLength(JSON.stringify(record)) + 1
      if (this.retainedBytes + bytes > 1024 * 1024) { this.dropped++; continue }
      this.pending.push(record)
      this.pendingBytes += bytes
      this.retainedBytes += bytes
    }
  }

  flush(): Promise<void> {
    const batch = this.pending
    const bytes = this.pendingBytes
    this.pending = []
    this.pendingBytes = 0
    if (batch.length === 0) return this.queue
    this.queue = this.queue.then(() => this.append(batch)).catch(() => {
      this.dropped += batch.length
      this.report('Performance records could not be written.')
    }).finally(() => { this.retainedBytes -= bytes })
    return this.queue
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    await this.flush()
  }

  private async append(batch: readonly PerfRecord[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const grouped = new Map<string, { records: PerfRecord[]; process: string; date: string }>()
    for (const record of batch) {
      const process = record.process.replace(':', '-')
      const date = new Date(record.at).toISOString().slice(0, 10)
      const file = join(this.directory, `${process}-${date}.jsonl`)
      let group = grouped.get(file)
      if (!group) { group = { records: [], process, date }; grouped.set(file, group) }
      group.records.push(record)
    }
    for (const [file, group] of grouped) {
      let state = this.files.get(file)
      if (!state) {
        state = await this.fileState(file)
        this.files.set(file, state)
        await this.prune(group.process, group.date)
      }
      if (state.truncated) continue
      let contents = ''
      for (const record of group.records) {
        const line = `${JSON.stringify(record)}\n`
        const bytes = Buffer.byteLength(line)
        if (state.bytes + bytes > PerfRecordWriter.fileBytes) {
          const { v, at, process, pid, build } = record
          contents += `${JSON.stringify({ v, at, process, pid, build, kind: 'truncated' })}\n`
          state.truncated = true
          break
        }
        contents += line
        state.bytes += bytes
      }
      try { await appendFile(file, contents, { encoding: 'utf8', mode: 0o600 }) }
      catch (error) { this.files.delete(file); throw error }
    }
  }

  private async fileState(file: string): Promise<{ bytes: number; truncated: boolean }> {
    let handle
    try { handle = await open(file, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, truncated: false }
      throw error
    }
    try {
      const { size } = await handle.stat()
      const tail = Buffer.alloc(Math.min(size, 2048))
      await handle.read(tail, 0, tail.length, size - tail.length)
      return { bytes: size, truncated: tail.toString('utf8').trimEnd().split('\n').at(-1)?.includes('"kind":"truncated"') ?? false }
    } finally { await handle.close() }
  }

  private async prune(process: string, date: string): Promise<void> {
    const cutoff = new Date(Date.parse(date) - 6 * 86_400_000).toISOString().slice(0, 10)
    for (const name of await readdir(this.directory)) {
      const match = /^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
      if (match && match[1] === process && match[2] < cutoff) {
        await unlink(join(this.directory, name))
        this.files.delete(join(this.directory, name))
      }
    }
  }
}
