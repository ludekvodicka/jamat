import { execFile } from 'node:child_process'
import { constants, setPriority, tmpdir } from 'node:os'
import type { RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import type { SessionProcessPriorityLevel } from '../sessionManagerApi.types'

/**
 * Agent sessions and script runs run below normal priority by default, so the work they start (test
 * runners with a worker per core, builds, dev servers) yields the processor to the person's own
 * programs, Jamat included, whenever the machine is busy. An idle machine sees no difference. The
 * children inherit it: Windows hands a below-normal priority class to every process such a process
 * starts, and POSIX children inherit the nice value.
 *
 * The runtime process is the shell the Host spawned (`cmd.exe /c claude ...`), which has started the
 * agent before the first listing reaches this class. So when a process is set, the processes already
 * running below it are set too, read once from the process table; until 2026-11-25 only the shell was
 * lowered and every agent kept normal priority.
 *
 * The client sets it rather than the Host, which spawns exactly what it is given: which session is an
 * agent is a client fact, and a live session follows a changed setting by the next listing without
 * restarting the Host that holds it. A shell the person types in is left alone.
 */
export class SessionProcessPriority {
  private readonly report: (text: string) => void
  private readonly setPriority: (pid: number, priority: number) => void
  private readonly descendantsOf: (pid: number, startedAt: number) => Promise<number[]>
  /** runtimeSessionId -> the process identity and level already set, so a listing costs no system call. */
  private readonly applied = new Map<string, string>()

  constructor(report: (text: string) => void, setPriorityImpl: (pid: number, priority: number) => void = setPriority,
    descendantsOf: (pid: number, startedAt: number) => Promise<number[]> = SessionProcessPriority.windowsDescendants) {
    this.report = report
    this.setPriority = setPriorityImpl
    this.descendantsOf = descendantsOf
  }

  static priorityOf(level: SessionProcessPriorityLevel): number {
    if (level === 'below-normal') return constants.priority.PRIORITY_BELOW_NORMAL
    else if (level === 'normal') return constants.priority.PRIORITY_NORMAL
    else
      throw new Error(`Unknown process priority: ${JSON.stringify(level satisfies never)}`)
  }

  /** Resolves once the processes already running below each newly set process are set as well. */
  observe(runtimes: readonly RuntimeSessionInfo[], governs: (runtimeSessionId: string) => boolean,
    level: SessionProcessPriorityLevel): Promise<void> {
    const priority = SessionProcessPriority.priorityOf(level)
    const listed = new Set<string>()
    const below: Promise<void>[] = []
    for (const runtime of runtimes) {
      if (!runtime.alive || runtime.pid === undefined || !governs(runtime.runtimeSessionId)) continue
      listed.add(runtime.runtimeSessionId)
      const identity = `${runtime.pid}:${runtime.processStartedAt ?? runtime.startedAt}:${level}`
      if (this.applied.get(runtime.runtimeSessionId) === identity) continue
      // Recorded before the call: a process that refuses is reported once, not on every listing.
      this.applied.set(runtime.runtimeSessionId, identity)
      if (!this.set(runtime.pid, priority, level)) continue
      if (runtime.processStartedAt !== undefined)
        below.push(this.setDescendants(runtime.pid, runtime.processStartedAt, priority, level))
    }
    for (const runtimeSessionId of [...this.applied.keys()])
      if (!listed.has(runtimeSessionId)) this.applied.delete(runtimeSessionId)
    return Promise.all(below).then(() => undefined)
  }

  private set(pid: number, priority: number, level: SessionProcessPriorityLevel): boolean {
    try { this.setPriority(pid, priority); return true }
    catch (error) {
      // ESRCH is a process that ended between the listing and this call; the next listing says so.
      // POSIX refuses to raise a nice value back without privilege, which is reported like any refusal.
      if (ErrnoCode.of(error) !== 'ESRCH')
        this.report(`The priority of session process ${pid} could not be set to ${level}: ${ErrorText.of(error)}`)
      return false
    }
  }

  private async setDescendants(pid: number, startedAt: number, priority: number, level: SessionProcessPriorityLevel): Promise<void> {
    let descendants: number[]
    try { descendants = await this.descendantsOf(pid, startedAt) }
    catch (error) {
      this.report(`The processes below session process ${pid} could not be read, so they keep their priority: ${ErrorText.of(error)}`)
      return
    }
    for (const descendant of descendants) this.set(descendant, priority, level)
  }

  /**
   * The processes below `pid`, each started no earlier than its parent, from one CIM query. A root
   * whose start differs by more than a second is a reused PID and has none. Off Windows children are
   * forked after the nice value is set, so there is nothing to read.
   */
  static async windowsDescendants(pid: number, startedAt: number): Promise<number[]> {
    if (process.platform !== 'win32') return []
    const output = await new Promise<string>((accept, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; "
      + "startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }) | ConvertTo-Json -Compress"],
    // The same budget as the Host's descendant query; under load it has taken more than 5 s.
    { windowsHide: true, timeout: 10_000, cwd: tmpdir(), maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error === null ? accept(stdout) : reject(error)))
    return SessionProcessPriority.descendantsIn(JSON.parse(output) as unknown, pid, startedAt)
  }

  static descendantsIn(table: unknown, pid: number, startedAt: number): number[] {
    const rows = (Array.isArray(table) ? table : [table]) as unknown[]
    const typed = rows.filter(SessionProcessPriority.isRow)
    if (typed.length !== rows.length) throw new Error('The process table is unreadable')
    const root = typed.find(row => row.pid === pid)
    if (!root || Math.abs(root.startedAt - startedAt) > 1_000) return []
    const owned = new Map([[pid, root.startedAt]])
    for (let changed = true; changed;) {
      changed = false
      for (const row of typed)
        if (!owned.has(row.pid) && owned.has(row.parent) && row.startedAt >= owned.get(row.parent)!) {
          owned.set(row.pid, row.startedAt)
          changed = true
        }
    }
    owned.delete(pid)
    return [...owned.keys()]
  }

  private static isRow(row: unknown): row is { pid: number; parent: number; startedAt: number } {
    if (typeof row !== 'object' || row === null) return false
    const fields = row as Record<string, unknown>
    return Number.isSafeInteger(fields['pid']) && Number.isSafeInteger(fields['parent']) && Number.isFinite(fields['startedAt'])
  }
}
