import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { WorkerHandoffs } from '../../sessionManager/worktreeSessionRuntime'
import type { WorktreeActor } from '../worktreeState'

export class ChecksStep {
  private readonly records: SessionRecordsStore
  private readonly handoffs: Pick<WorkerHandoffs, 'checksFailed'>

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

  async complete(sessionId: string, result: { passed: boolean; logPath: string; at: number }): Promise<void> {
    if (!await this.records.update(sessionId, (record) => {
      const state = record.worktreeLifecycle
      if (state?.step !== 'checking') return null
      return { ...record, worktreeLifecycle: { ...state, version: state.version + 1,
        phase: result.passed ? 'finishing' : 'active', step: result.passed ? 'reviewing' : undefined, wait: undefined,
        checks: { ...result, overridden: false, configured: (state.execution?.checks.length ?? 0) > 0 }, review: undefined,
        facts: { ...state.facts, worker: { ...state.facts.worker, ready: undefined } } } }
    })) throw new Error('The check result could not be saved')
    if (!result.passed)
      await this.handoffs.checksFailed(sessionId, result.at, result.logPath)
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
