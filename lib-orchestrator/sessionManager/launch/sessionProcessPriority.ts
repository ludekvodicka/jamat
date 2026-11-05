import { constants, setPriority } from 'node:os'
import type { RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import type { SessionProcessPriorityLevel } from '../sessionManagerApi.types'

/**
 * Agent sessions and script runs run below normal priority by default, so the work they start (test
 * runners with a worker per core, builds, dev servers) yields the processor to the person's own
 * programs, Jamat included, whenever the machine is busy. An idle machine sees no difference. The
 * children inherit it: Windows hands a below-normal priority class to every process such a process
 * starts, and POSIX children inherit the nice value. Children started before a change keep their own.
 *
 * The client sets it rather than the Host, which spawns exactly what it is given: which session is an
 * agent is a client fact, and a live session follows a changed setting by the next listing without
 * restarting the Host that holds it. A shell the person types in is left alone.
 */
export class SessionProcessPriority {
  private readonly report: (text: string) => void
  private readonly setPriority: (pid: number, priority: number) => void
  /** runtimeSessionId -> the process identity and level already set, so a listing costs no system call. */
  private readonly applied = new Map<string, string>()

  constructor(report: (text: string) => void, setPriorityImpl: (pid: number, priority: number) => void = setPriority) {
    this.report = report
    this.setPriority = setPriorityImpl
  }

  static priorityOf(level: SessionProcessPriorityLevel): number {
    if (level === 'below-normal') return constants.priority.PRIORITY_BELOW_NORMAL
    else if (level === 'normal') return constants.priority.PRIORITY_NORMAL
    else
      throw new Error(`Unknown process priority: ${JSON.stringify(level satisfies never)}`)
  }

  observe(runtimes: readonly RuntimeSessionInfo[], governs: (runtimeSessionId: string) => boolean,
    level: SessionProcessPriorityLevel): void {
    const priority = SessionProcessPriority.priorityOf(level)
    const listed = new Set<string>()
    for (const runtime of runtimes) {
      if (!runtime.alive || runtime.pid === undefined || !governs(runtime.runtimeSessionId)) continue
      listed.add(runtime.runtimeSessionId)
      const identity = `${runtime.pid}:${runtime.processStartedAt ?? runtime.startedAt}:${level}`
      if (this.applied.get(runtime.runtimeSessionId) === identity) continue
      // Recorded before the call: a process that refuses is reported once, not on every listing.
      this.applied.set(runtime.runtimeSessionId, identity)
      try { this.setPriority(runtime.pid, priority) }
      catch (error) {
        // ESRCH is a process that ended between the listing and this call; the next listing says so.
        // POSIX refuses to raise a nice value back without privilege, which is reported like any refusal.
        if (ErrnoCode.of(error) !== 'ESRCH')
          this.report(`The priority of session process ${runtime.pid} could not be set to ${level}: ${ErrorText.of(error)}`)
      }
    }
    for (const runtimeSessionId of [...this.applied.keys()])
      if (!listed.has(runtimeSessionId)) this.applied.delete(runtimeSessionId)
  }
}
