import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { SessionProcessTreeView, type SessionProcessRoot, type ProcessTreeRow } from '../../../lib-orchestrator/sessionManager/sessionProcessTreeView'
import type { PerfEvent } from '../../../lib-orchestrator/perfMonitor/perfRecord.types'
import { RunawayTracker, type RunawayObservation, type RunawayProcess } from '../../../lib-orchestrator/perfMonitor/runawayTracker'

export interface ProcessCpuRow extends ProcessTreeRow { image: string; cpuSeconds: number }

export class MachineLoadSampler {
  private readonly deps: {
    emit: (event: PerfEvent, at: number) => void
    roots: () => readonly SessionProcessRoot[]
    ownPids: () => readonly number[]
    power: Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>
    notify: (runaway: RunawayProcess) => void
    report: (message: string) => void
    readCpu?: typeof cpus
    query?: () => Promise<ProcessCpuRow[]>
    now?: () => number
    monotonic?: () => number
  }
  private readonly runaway: RunawayTracker
  private readonly suspend: () => void
  private readonly resume: () => void
  private timer: ReturnType<typeof setInterval> | null
  private previousCpu: { total: number; idle: number; cores: number }
  private previousProcesses: { at: number; rows: Map<string, ProcessCpuRow> } | null
  private highSamples: number
  private wall: number
  private mono: number
  private suspended: boolean
  private stopped: boolean
  private pending: Promise<void> | null
  private generation: number

  constructor(deps: MachineLoadSampler['deps']) {
    this.deps = deps
    this.runaway = new RunawayTracker(deps.notify)
    this.timer = null
    this.previousCpu = this.cpu()
    this.previousProcesses = null
    this.highSamples = 0
    this.wall = this.now()
    this.mono = this.monotonic()
    this.suspended = false
    this.stopped = false
    this.pending = null
    this.generation = 0
    this.suspend = () => { deps.emit({ kind: 'suspend' }, this.now()); this.suspended = true; this.reset() }
    this.resume = () => { deps.emit({ kind: 'resume' }, this.now()); this.suspended = false; this.reset() }
  }

  start(): void {
    if (this.timer !== null || this.stopped) return
    this.reset()
    this.deps.power.on('suspend', this.suspend)
    this.deps.power.on('resume', this.resume)
    this.timer = setInterval(() => { void this.poll() }, 60_000)
    this.timer.unref()
  }

  poll(): Promise<void> {
    if (this.pending || this.stopped) return this.pending ?? Promise.resolve()
    this.pending = this.sample().catch(() => {
      this.previousProcesses = null
      this.runaway.reset()
      this.deps.report('Machine process CPU could not be sampled.')
    }).finally(() => { this.pending = null })
    return this.pending
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.deps.power.removeListener('suspend', this.suspend)
    this.deps.power.removeListener('resume', this.resume)
    await this.pending
  }

  private async sample(): Promise<void> {
    const at = this.now()
    const mono = this.monotonic()
    if (this.suspended || at - this.wall - (mono - this.mono) > 5_000) { this.reset(); return }
    this.wall = at
    this.mono = mono
    const cpu = this.cpu()
    const total = cpu.total - this.previousCpu.total
    const busy = total > 0 ? Math.max(0, Math.min(1, 1 - (cpu.idle - this.previousCpu.idle) / total)) : null
    this.previousCpu = cpu
    if (busy === null) return
    this.highSamples = busy >= 0.5 ? this.highSamples + 1 : 0
    // The measured Windows query exceeded one second, so require two high-load samples before starting it.
    if (this.highSamples < 2 || process.platform !== 'win32' && !this.deps.query) {
      this.previousProcesses = null
      this.runaway.reset()
      this.deps.emit({ kind: 'machine', cpu: busy, jamatCpu: null }, at)
      return
    }
    const generation = this.generation
    let rows: ProcessCpuRow[]
    try { rows = await (this.deps.query ?? MachineLoadSampler.query)() }
    catch (error) {
      if (!this.stopped && !this.suspended && generation === this.generation)
        this.deps.emit({ kind: 'machine', cpu: busy, jamatCpu: null }, at)
      throw error
    }
    if (this.stopped || this.suspended || generation !== this.generation) return
    const previous = this.previousProcesses
    this.previousProcesses = { at, rows: new Map(rows.map(row => [`${row.pid}:${row.startedAt}`, row])) }
    const elapsed = previous === null ? 0 : (at - previous.at) / 1_000
    if (previous === null || elapsed <= 0) {
      this.deps.emit({ kind: 'machine', cpu: busy, jamatCpu: null }, at)
      return
    }
    const rates = rows.flatMap(row => {
      const old = previous.rows.get(`${row.pid}:${row.startedAt}`)
      return old && row.cpuSeconds >= old.cpuSeconds ? [{ ...row, cores: (row.cpuSeconds - old.cpuSeconds) / elapsed }] : []
    })
    const own = new Set(this.deps.ownPids())
    const jamatCpu = own.size > 0 && [...own].every(pid => rates.some(row => row.pid === pid))
      ? Math.min(busy, rates.filter(row => own.has(row.pid)).reduce((sum, row) => sum + row.cores, 0) / cpu.cores) : null
    this.deps.emit({ kind: 'machine', cpu: busy, jamatCpu }, at)
    const byPid = new Map(rows.map(row => [row.pid, row]))
    const roots = this.deps.roots()
    const outside = rates.filter(row => !own.has(row.pid))
      .map(row => ({ ...row, owner: SessionProcessTreeView.owner(row, byPid, roots) }))
    this.deps.emit({ kind: 'external', top: [...outside].sort((a, b) => b.cores - a.cores).slice(0, 10)
      .map(row => ({ image: row.image, cores: row.cores, session: row.owner?.session ?? null, sessionKind: row.owner?.sessionKind ?? null })) }, at)
    const observations: RunawayObservation[] = outside.flatMap(row => row.owner && row.pid !== row.owner.pid
      ? [{ ...row.owner, pid: row.pid, startedAt: row.startedAt, image: row.image, cores: row.cores }] : [])
    for (const row of this.runaway.update(observations, at, new Set(rows.map(row => `${row.pid}:${row.startedAt}`))))
      this.deps.emit({ kind: 'runaway', image: row.image, cores: row.cores, minutes: row.minutes,
        session: row.session, sessionKind: row.sessionKind }, at)
  }

  private reset(): void {
    this.generation++
    this.previousCpu = this.cpu()
    this.previousProcesses = null
    this.highSamples = 0
    this.wall = this.now()
    this.mono = this.monotonic()
    this.runaway.reset()
  }

  private now(): number { return (this.deps.now ?? Date.now)() }
  private monotonic(): number { return this.deps.monotonic?.() ?? performance.now() }

  private cpu(): { total: number; idle: number; cores: number } {
    const cores = (this.deps.readCpu ?? cpus)()
    return { total: cores.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0),
      idle: cores.reduce((sum, cpu) => sum + cpu.times.idle, 0), cores: cores.length }
  }

  static query(): Promise<ProcessCpuRow[]> {
    const script = '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(); image=$_.Name; cpuSeconds=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000 } } | ConvertTo-Json -Compress'
    return new Promise((resolve, reject) => {
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          clearTimeout(deadline)
          if (error) { reject(new Error('Process CPU query failed')); return }
          try {
            const parsed: unknown = JSON.parse(stdout)
            const rows = Array.isArray(parsed) ? parsed : [parsed]
            resolve(rows.filter((row): row is ProcessCpuRow => row !== null && typeof row === 'object'
              && Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.parent)
              && Number.isFinite(row.startedAt) && row.startedAt > 0 && Number.isFinite(row.cpuSeconds) && row.cpuSeconds >= 0
              && typeof row.image === 'string' && row.image.length <= 128 && /^[\p{L}\p{N}_. ()-]+$/u.test(row.image)))
          } catch { reject(new Error('Process CPU response was invalid')) }
        })
      // execFile's own timeout still waits for close when an inherited pipe stays open.
      const deadline = setTimeout(() => {
        child.kill()
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.unref()
        reject(new Error('Process CPU query timed out'))
      }, 10_000)
    })
  }
}
