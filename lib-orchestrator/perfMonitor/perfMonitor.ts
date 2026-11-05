import { PerfLoopSampler } from './perfLoopSampler'
import { PerfRecordWriter } from './perfRecordWriter'
import type { PerfNames } from './perfNames'
import type { PerfBuild, PerfEvent, PerfName, PerfProcess } from './perfRecord.types'
import type { PerfSpans } from './perfSpans'
import type { PerfProfilerPort } from './perfProfiler'
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export class PerfMonitor implements PerfSpans {
  private readonly process: PerfProcess
  private readonly build: PerfBuild
  private readonly now: () => number
  private readonly writer: PerfRecordWriter
  private readonly sampler: PerfLoopSampler
  private readonly monotonic: () => number
  private readonly names: PerfNames
  private readonly stack: { children: number }[]
  private recent: { name: PerfName; from: number; to: number }[]
  private readonly profiler: PerfProfilerPort | undefined
  private readonly profileDirectory: string
  private readonly report: (message: string) => void
  private highEluMs: number
  private lastProfileAt: number
  private profilePending: Promise<void> | null
  private stopped: boolean

  constructor(deps: { process: PerfProcess; build: PerfBuild; directory: string; now?: () => number;
    monotonic?: () => number; names: PerfNames; report: (message: string) => void; profiler?: PerfProfilerPort }) {
    this.process = deps.process
    this.build = deps.build
    this.now = deps.now ?? Date.now
    this.monotonic = deps.monotonic ?? (() => performance.now())
    this.names = deps.names
    this.stack = []
    this.recent = []
    this.profiler = deps.profiler
    this.profileDirectory = join(deps.directory, 'profiles')
    this.report = deps.report
    this.highEluMs = 0
    this.lastProfileAt = -Infinity
    this.profilePending = null
    this.stopped = false
    this.writer = new PerfRecordWriter(deps.directory, deps.names, deps.report)
    this.sampler = new PerfLoopSampler(event => this.event(event), this.now, this.monotonic,
      (elu, elapsedMs) => this.observeUtilization(elu, elapsedMs))
  }

  start(): void { this.writer.start(); this.sampler.start() }

  record(records: readonly unknown[]): void { this.writer.record(records) }

  span<T>(name: PerfName, work: () => T): T {
    const started = this.monotonic()
    const frame = { children: 0 }
    const depth = this.stack.length
    this.stack.push(frame)
    try { return work() }
    finally {
      const ended = this.monotonic()
      const ms = Math.max(0, ended - started)
      this.stack.pop()
      const parent = this.stack.at(-1)
      if (parent) parent.children += ms
      if (ms >= 20) {
        const valid = this.names.accepts(name) ? name : 'other'
        this.recent = this.recent.filter(span => span.to >= ended - 60_000).slice(-255)
        this.recent.push({ name: valid, from: started, to: ended })
        this.event({ kind: 'span', name: valid, ms, selfMs: Math.max(0, ms - frame.children), depth, blocking: true })
      }
    }
  }

  async operation<T>(name: PerfName, work: () => Promise<T>): Promise<T> {
    const started = this.monotonic()
    try { return await this.span(name, work) }
    finally {
      const ms = Math.max(0, this.monotonic() - started)
      if (ms >= 2_000) this.event({ kind: 'span', name: this.names.accepts(name) ? name : 'other',
        ms, selfMs: ms, depth: 0, blocking: false })
    }
  }

  event(event: PerfEvent): void {
    if (event.kind === 'stall') {
      const ended = this.monotonic()
      const started = ended - event.ms - 50
      event = { ...event, covered: [...new Set([...event.covered, ...this.recent
        .filter(span => span.to >= started && span.from <= ended).map(span => span.name)])] }
      this.recent = []
      if (event.ms >= 1_000 && event.covered.length === 0) this.startProfile('stall')
    }
    if (event.kind === 'suspend' || event.kind === 'resume') this.highEluMs = 0
    this.record([{ ...event, v: 1, at: this.now(), process: this.process, pid: process.pid, build: this.build }])
  }

  observeUtilization(elu: number | null, elapsedMs: number): void {
    this.highEluMs = elu !== null && elu >= 0.5 ? this.highEluMs + elapsedMs : 0
    if (this.highEluMs >= 10_000) this.startProfile('elu')
  }

  private startProfile(trigger: 'elu' | 'stall'): void {
    const profiler = this.profiler
    const now = this.monotonic()
    if (this.stopped || !profiler || this.profilePending || now - this.lastProfileAt < 600_000) return
    this.lastProfileAt = now
    this.highEluMs = 0
    this.profilePending = Promise.resolve().then(async () => {
      const profileId = await profiler.record(10)
      if (!/^[a-zA-Z0-9_-]+\.cpuprofile$/.test(profileId)) throw new Error('Invalid profile id')
      await this.pruneProfiles()
      this.event({ kind: 'profile', profileId, trigger })
    }).catch(() => { this.report('Automatic CPU profile could not be recorded.') })
      .finally(() => { this.profilePending = null })
  }

  private async pruneProfiles(): Promise<void> {
    const prefix = `${this.process.replace(':', '-')}-`
    const files = (await readdir(this.profileDirectory, { withFileTypes: true }))
      .filter(file => file.isFile() && file.name.startsWith(prefix) && /^[a-zA-Z0-9_-]+\.cpuprofile$/.test(file.name))
    const dated = await Promise.all(files.map(async file => ({ name: file.name,
      at: (await stat(join(this.profileDirectory, file.name))).mtimeMs })))
    dated.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
    for (const file of dated.slice(10)) await unlink(join(this.profileDirectory, file.name))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.sampler.stop()
    await this.profilePending
    await this.writer.stop()
  }
}
