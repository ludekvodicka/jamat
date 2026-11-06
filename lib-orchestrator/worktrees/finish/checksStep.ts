import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { WorkerHandoffs } from '../../sessionManager/worktreeSessionRuntime'
import type { WorktreeActor } from '../worktreeState'

export class ChecksStep {
  private readonly records: SessionRecordsStore
  private readonly handoffs: Pick<WorkerHandoffs, 'checksFailed' | 'notifyCaller'>

  constructor(records: SessionRecordsStore, handoffs: ChecksStep['handoffs']) {
    this.records = records
    this.handoffs = handoffs
  }

  async recordChanges(sessionId: string, before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): Promise<void> {
    if (!await this.records.update(sessionId, (record) => {
      const state = record.worktreeLifecycle
      if (state === undefined) return null
      const baseline = { ...record.worktree?.setupBaseline?.hashes, ...state.checkBaseline }
      const produced = Object.fromEntries(Object.entries(after).filter(([path, hash]) => hash !== before[path]
        && (before[path] === undefined || baseline[path] === before[path])))
      return { ...record, worktreeLifecycle: { ...state, checkBaseline: { ...state.checkBaseline, ...produced } } }
    })) throw new Error('The changes produced by checks could not be saved')
  }

  /**
   * True when a failed check waits for the person, who answers with Retry checks, Accept failed checks,
   * Solve with agent or Back to work: a Finish the person holds, or a check somebody stopped. Only an
   * agent's Finish hands the log to its worker by itself. In worktree 103 the person stopped a hanging
   * install and the Finish ended with nothing to press (J17). The result, the cleared run and the wait
   * are one write: a restart between two writes ran the checks again without waiting.
   */
  async complete(sessionId: string, result: { passed: boolean; logPath: string; at: number },
    failure?: { check: string; reason: string; stopped: boolean }): Promise<boolean> {
    const owner = this.records.get(sessionId)?.worktreeLifecycle?.owner
    const waits = !result.passed && (failure?.stopped === true || owner === 'person' || owner === 'remote-person')
    const reason = failure === undefined ? '' : ChecksStep.failedReasonOf(failure.check, failure.reason, result.logPath)
    if (!await this.records.update(sessionId, (record) => {
      const state = record.worktreeLifecycle
      if (state?.step !== 'checking') return null
      const checks = { ...result, overridden: false, configured: (state.execution?.checks.length ?? 0) > 0 }
      const facts = { ...state.facts, worker: { ...state.facts.worker, ready: undefined } }
      const execution = result.passed || state.execution === undefined ? state.execution
        : { ...state.execution, runId: undefined, verdict: undefined, checkBefore: undefined, checkCursor: 0 }
      if (waits) return { ...record, worktreeLifecycle: { ...state, version: state.version + 1, checks, review: undefined, facts, execution,
        // A lost worker's wait keeps its Resume worker; Retry checks follows once it is answered.
        ...state.wait?.kind === 'worker-lost' ? {} : { phase: 'waiting' as const, wait: { kind: 'checks-failed' as const, reason, at: result.at } } } }
      return { ...record, worktreeLifecycle: { ...state, version: state.version + 1,
        phase: result.passed ? 'finishing' : 'active', step: result.passed ? 'reviewing' : undefined, wait: undefined,
        checks, review: undefined, facts, execution } }
    })) throw new Error('The check result could not be saved')
    if (waits) await this.handoffs.notifyCaller(sessionId, `checks-failed: ${reason}`)
    else if (!result.passed)
      await this.handoffs.checksFailed(sessionId, result.at, result.logPath)
    return waits
  }

  /** The words of a failed-check wait: which check, why, where its log is and what answers it. */
  static failedReasonOf(check: string, reason: string, logPath: string): string {
    return `The check ${check} did not pass: ${reason}. Log: ${logPath}. Retry checks, accept the failure, `
      + 'solve it with an agent, or go back to work to send the log to the worker.'
  }

  async override(sessionId: string, actor: WorktreeActor): Promise<boolean> {
    if (actor !== 'person' && actor !== 'remote-person') return false
    return this.records.update(sessionId, (record) => {
      const state = record.worktreeLifecycle
      if (state?.checks?.passed !== false) return null
      return { ...record, worktreeLifecycle: { ...state, version: state.version + 1, phase: 'finishing', step: 'reviewing', wait: undefined,
        checks: { ...state.checks, overridden: true } } }
    })
  }
}
