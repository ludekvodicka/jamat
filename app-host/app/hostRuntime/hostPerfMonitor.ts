import { appendFile, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { HostPerfBuild } from './buildInfo.js'

type HostPerfEvent = { kind: 'stall'; ms: number; covered: [] }
  | { kind: 'sample'; elu: number; loopP50: number | null; loopP99: number | null; loopMax: number | null; heapMb: number }
  | { kind: 'truncated' }
type HostPerfRecord = HostPerfEvent & { v: 1; at: number; process: 'host'; pid: number; build: HostPerfBuild }

export class HostPerfMonitor {
  private readonly directory: string
  private readonly build: HostPerfBuild
  private readonly report: (message: string) => void
  private readonly now: () => number
  private readonly monotonic: () => number
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>
  private timer: ReturnType<typeof setInterval> | null
  private flushTimer: ReturnType<typeof setInterval> | null
  private wall: number
  private mono: number
  private sampleAt: number
  private utilization: ReturnType<typeof performance.eventLoopUtilization>
  private batch: HostPerfRecord[]
  private retainedRecords: number
  private queue: Promise<void>
  private readonly files: Map<string, { bytes: number; truncated: boolean }>

  constructor(directory: string, build: HostPerfBuild, report: (message: string) => void,
    now = Date.now, monotonic = () => performance.now()) {
    this.directory = directory
    this.build = build
    this.report = report
    this.now = now
    this.monotonic = monotonic
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.timer = null
    this.flushTimer = null
    this.wall = 0
    this.mono = 0
    this.sampleAt = 0
    this.utilization = performance.eventLoopUtilization()
    this.batch = []
    this.retainedRecords = 0
    this.queue = Promise.resolve()
    this.files = new Map()
  }

  start(): void {
    if (this.timer !== null) return
    this.wall = this.now()
    this.mono = this.monotonic()
    this.sampleAt = this.mono
    this.utilization = performance.eventLoopUtilization()
    this.histogram.enable()
    this.timer = setInterval(() => this.poll(), 50)
    this.timer.unref()
    this.flushTimer = setInterval(() => { void this.flush() }, 2_000)
    this.flushTimer.unref()
  }

  poll(): void {
    const wall = this.now()
    const mono = this.monotonic()
    const gap = mono - this.mono
    const slept = wall - this.wall - gap > 5_000
    this.wall = wall
    this.mono = mono
    if (slept) {
      this.histogram.reset()
      this.sampleAt = mono
      this.utilization = performance.eventLoopUtilization()
      return
    }
    if (gap - 50 >= 100) this.record({ kind: 'stall', ms: gap - 50, covered: [] })
    if (mono - this.sampleAt < 60_000) return
    const utilization = performance.eventLoopUtilization()
    const measured = this.histogram.count > 0
    this.record({ kind: 'sample', elu: performance.eventLoopUtilization(utilization, this.utilization).utilization,
      loopP50: measured ? this.histogram.percentile(50) / 1e6 : null,
      loopP99: measured ? this.histogram.percentile(99) / 1e6 : null,
      loopMax: measured ? this.histogram.max / 1e6 : null, heapMb: process.memoryUsage().heapUsed / 1024 / 1024 })
    this.sampleAt = mono
    this.utilization = utilization
    this.histogram.reset()
  }

  private record(event: HostPerfEvent): void {
    if (this.retainedRecords >= 1024) return
    this.batch.push({ ...event, v: 1, at: this.now(), process: 'host', pid: process.pid, build: this.build })
    this.retainedRecords++
  }

  flush(): Promise<void> {
    const batch = this.batch.splice(0)
    if (batch.length === 0) return this.queue
    this.queue = this.queue.then(() => this.append(batch)).catch(() => this.report('Host performance records could not be written.'))
      .finally(() => { this.retainedRecords -= batch.length })
    return this.queue
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.flushTimer !== null) clearInterval(this.flushTimer)
    this.timer = null
    this.flushTimer = null
    this.histogram.disable()
    await this.flush()
  }

  private async append(batch: readonly HostPerfRecord[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const groups = new Map<string, HostPerfRecord[]>()
    for (const record of batch) {
      const date = new Date(record.at).toISOString().slice(0, 10)
      const records = groups.get(date) ?? []
      records.push(record)
      groups.set(date, records)
    }
    for (const [date, records] of groups) {
      const file = join(this.directory, `host-${date}.jsonl`)
      let state = this.files.get(date)
      if (state === undefined) {
        state = await this.fileState(file)
        this.files.set(date, state)
        const cutoff = new Date(Date.parse(date) - 6 * 86_400_000).toISOString().slice(0, 10)
        for (const name of await readdir(this.directory)) {
          const match = /^host-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
          if (match && match[1] < cutoff) {
            await unlink(join(this.directory, name))
            this.files.delete(match[1])
          }
        }
      }
      if (state.truncated) continue
      let contents = ''
      for (const record of records) {
        const line = `${JSON.stringify(record)}\n`
        const bytes = Buffer.byteLength(line)
        if (state.bytes + bytes > 20 * 1024 * 1024) {
          const { v, at, process, pid, build } = record
          contents += `${JSON.stringify({ v, at, process, pid, build, kind: 'truncated' })}\n`
          state.truncated = true
          break
        }
        contents += line
        state.bytes += bytes
      }
      try { await appendFile(file, contents, { encoding: 'utf8', mode: 0o600 }) }
      catch (error) { this.files.delete(date); throw error }
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
}
