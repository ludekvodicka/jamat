import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SessionLifecycle } from '../../sessionManager/worktreeSessionRuntime'
import type { FinishStep } from '../worktreeState'
import { WorkerResumePolicy } from '../worktreeState'
import { WorktreeTransitions } from '../worktreeTransitions'
import { AgentPresets } from '../../sessionManager/worktreeSessionRuntime'
import { ErrorText } from '../../shared/errorText'

/**
 * A started runtime is not a resumed worker. A resume of a conversation the agent cannot find starts
 * a process that ends half a second later; counted as a success, the worker came back 26 times in 69
 * seconds and never reached worker-lost (UA1-J14-2). So a resumed worker must stay alive for the
 * proving time; one that ends before it is a failed resume, and the next attempt waits the retry delay.
 */
export class WorkerLiveness {
  /** An interactive agent that found its conversation runs until it is stopped; a missing one ends within a second. */
  static readonly provingMilliseconds = 30_000
  static readonly retryDelayMilliseconds = 5_000
  /** Interruptions of the Host itself, which say nothing about the conversation. */
  private static readonly hostReasonsConst: readonly string[] = ['host-stopped', 'host-lost']

  private readonly deps: { records: SessionRecordsStore; resume: SessionLifecycle['resumeWorker'];
    redeliver: (sessionId: string) => Promise<void>; notify: (sessionId: string, text: string) => Promise<void>; now: () => number }
  private readonly running = new Map<string, Promise<void>>()

  constructor(deps: WorkerLiveness['deps']) { this.deps = deps }

  static open(record: SessionRecord): boolean {
    return record.kind === 'agent' && record.worktree?.kind === 'svn' && record.pendingSetup === undefined
      && (record.worktreeLifecycle?.phase === 'active' || record.worktreeLifecycle?.phase === 'finishing' || record.worktreeLifecycle?.phase === 'waiting')
  }

  /**
   * Each ended worker of one reconcile pass on its own: a write the store refuses for one session is
   * reported and the next goes on. One refusal threw out of the whole pass on every poll, and no other
   * session was reconciled (UA1-J14R-1).
   */
  async observe(records: readonly SessionRecord[], report: (text: string) => void): Promise<void> {
    for (const record of records) {
      if (!WorkerLiveness.open(record) || record.life !== 'ended' && record.life !== 'lost') continue
      try {
        await this.died(record.sessionId, record.exitReason ?? 'runtime ended')
        await this.run(record.sessionId)
      } catch (error) { report(`Session ${record.sessionId}: the worker liveness check failed: ${ErrorText.of(error)}`) }
    }
  }

  /**
   * The person resumed the session's conversation. A lost worker leaves its wait; a dead one counts as
   * resumed, so its next death is read again. Without this the wait stayed after the resume, and the
   * death facts kept every later death unread (UA1-J14R-3).
   */
  async reopened(sessionId: string): Promise<void> {
    const record = this.deps.records.get(sessionId)
    const state = record?.worktreeLifecycle
    if (record === null || state === undefined || !WorkerLiveness.open(record) || state.facts.worker.liveness !== 'dead') return
    const at = this.deps.now()
    if (!await this.deps.records.update(sessionId, (latest) => {
      const current = latest.worktreeLifecycle
      if (current === undefined || current.facts.worker.liveness !== 'dead') return null
      if (current.wait?.kind !== 'worker-lost') return { ...latest, worktreeLifecycle: { ...current, version: current.version + 1,
        facts: { ...current.facts, worker: { ...current.facts.worker, liveness: 'alive', resumedAt: at, resumeFailures: 0, resumeMode: undefined } } } }
      const resumed = WorktreeTransitions.next(current, { kind: 'worker-resumed', at }, 'jamat')
      return resumed.ok ? { ...latest, worktreeLifecycle: resumed.state } : null
    })) throw new Error('The resumed worker could not be saved')
  }

  async died(sessionId: string, reason: string): Promise<void> {
    const record = this.deps.records.get(sessionId)
    if (record === null || !WorkerLiveness.open(record) || record.worktreeLifecycle?.facts.worker.liveness !== 'alive') return
    const mode = WorkerResumePolicy.onDeath(record.worktreeLifecycle.step)
    if (mode === 'none') return
    const worker = record.worktreeLifecycle.facts.worker
    // The runtime's own end when the Host reported it: a death read a few polls late still counts from it.
    const at = record.endedAt ?? this.deps.now()
    const lived = worker.resumedAt === undefined ? null : at - worker.resumedAt
    const early = lived !== null && lived < WorkerLiveness.provingMilliseconds
    const failed = early && !WorkerLiveness.hostReasonsConst.includes(reason)
    // A worker that proved itself starts from zero; a Host interruption right after a resume neither counts nor proves.
    const failures = failed ? worker.resumeFailures + 1 : early ? worker.resumeFailures : 0
    const ended = failed ? `the resumed worker ended ${Math.round(lived! / 100) / 10} s after its resume (${reason})` : null
    if (!await this.deps.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined ? null : {
      ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1,
        ...failures < 2 ? {} : { phase: 'waiting', wait: { kind: 'worker-lost', at, reason: WorkerLiveness.lostReasonOf(latest, ended!) } },
        facts: { ...latest.worktreeLifecycle.facts, worker: { ...latest.worktreeLifecycle.facts.worker, liveness: 'dead',
          diedAt: at, diedDuring: latest.worktreeLifecycle.step, deathReason: reason, resumeMode: mode, resumeFailures: failures } } },
    })) throw new Error('The worker death could not be saved')
    if (failures >= 2) await this.deps.notify(sessionId, `Worker lost: ${ended}`)
    else if (failed) await this.deps.notify(sessionId,
      `Worker ${ended!.replace(/^the resumed worker /, '')}; its conversation will resume again in ${WorkerLiveness.retryDelayMilliseconds / 1000} s, resume ${failures + 1} of 2`)
    else await this.deps.notify(sessionId, `Worker stopped: ${reason}; its conversation will resume`)
  }

  /** Every way to the wait says why and offers the person's choices; an id no running agent confirmed is named as such. */
  private static lostReasonOf(record: SessionRecord, failure: string): string {
    const agent = record.agent
    const unconfirmed = agent?.nativeSessionId !== undefined && !AgentPresets.identityConfirmed(agent)
      ? ` The running agent never confirmed conversation ${agent.nativeSessionId}, so it may not exist.` : ''
    return `The worker could not resume twice: ${failure}.${unconfirmed} Press Resume worker to continue its conversation, or Keep worktree or Discard to decide the worktree without it.`
  }

  run(sessionId: string, completedStep?: FinishStep): Promise<void> {
    const running = this.running.get(sessionId)
    if (running !== undefined) return running
    const work = this.resume(sessionId, completedStep).finally(() => { this.running.delete(sessionId) })
    this.running.set(sessionId, work)
    return work
  }

  private async resume(sessionId: string, completedStep?: FinishStep): Promise<void> {
    const record = this.deps.records.get(sessionId)
    const state = record?.worktreeLifecycle
    const worker = state?.facts.worker
    if (record === null || !WorkerLiveness.open(record) || worker?.liveness !== 'dead' || worker.resumeFailures >= 2 || worker.resumeMode === undefined) return
    if (record.life === 'live' || record.life === 'starting') return
    if (WorkerResumePolicy.onDeath(state?.step) === 'none') return
    if (worker.resumeMode === 'resume-after-step' && completedStep !== worker.diedDuring && state?.step === worker.diedDuring) return
    // After a resumed worker ended at once, the next attempt waits, so nothing respawns in a tight loop.
    if (worker.resumeFailures > 0 && worker.resumedAt !== undefined && worker.diedAt !== undefined
      && worker.diedAt - worker.resumedAt < WorkerLiveness.provingMilliseconds
      && this.deps.now() < worker.diedAt + WorkerLiveness.retryDelayMilliseconds) return
    let failure: string | null = null
    try {
      const result = await this.deps.resume(sessionId)
      if (!result.ok) failure = result.detail
    } catch (error) { failure = ErrorText.of(error) }
    if (failure !== null) {
      const failures = worker.resumeFailures + 1
      if (!await this.deps.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined ? null : {
        ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1,
          ...failures < 2 ? {} : { phase: 'waiting', wait: { kind: 'worker-lost', at: this.deps.now(), reason: WorkerLiveness.lostReasonOf(latest, failure!) } },
          facts: { ...latest.worktreeLifecycle.facts, worker: { ...latest.worktreeLifecycle.facts.worker, resumeFailures: failures } } },
      })) throw new Error('The worker resume failure could not be saved')
      if (failures >= 2) await this.deps.notify(sessionId, `Worker lost: ${failure}`)
      return
    }
    if (!await this.deps.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined ? null : {
      ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1,
        facts: { ...latest.worktreeLifecycle.facts, worker: { ...latest.worktreeLifecycle.facts.worker,
          liveness: 'alive', resumedAt: this.deps.now(), resumeMode: undefined } } },
    })) throw new Error('The resumed worker could not be saved')
    if (worker.resumeMode === 'resume-and-redeliver') await this.deps.redeliver(sessionId)
    await this.deps.notify(sessionId, `Worker resumed after ${worker.deathReason ?? 'interruption'}`)
  }
}
