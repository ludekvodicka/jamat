import type { FinishDriverDeps } from './finishDriver.types'
import type { FinishState } from './finishState'
import type { WorktreeLifecycle } from '../worktreeState'
import { SvnWorktreeRemoval } from '../removal/svnWorktreeRemoval'

export class SyncExecution {
  private readonly deps: Pick<FinishDriverDeps, 'records' | 'svn' | 'sync'>
  private readonly state: Pick<FinishState, 'retainAttempt' | 'wait' | 'write'>

  constructor(deps: SyncExecution['deps'], state: SyncExecution['state']) {
    this.deps = deps
    this.state = state
  }

  async run(sessionId: string, state: WorktreeLifecycle): Promise<boolean> {
    const prior = state.execution!
    if (prior.runId !== undefined && !state.journal.some((entry) => entry.runId === prior.runId)) {
      if (prior.verdict === undefined) return false
      await this.state.retainAttempt(sessionId, { runId: prior.runId, title: 'Migrated svn sync' })
      if (prior.verdict.kind === 'failed') { await this.state.wait(sessionId, 'svn-failed', prior.verdict.reason); return false }
      await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!, runId: undefined, verdict: undefined } }))
    }
    const record = this.deps.records.get(sessionId)!
    const owner = await this.deps.svn.ownerCheck(SvnWorktreeRemoval.locationOf(record.worktree!))
    if (!owner.ok) { await this.state.wait(sessionId, 'svn-failed', owner.detail); return false }
    if (state.approvedAt !== undefined || state.preparation !== undefined)
      await this.state.write(sessionId, (current) => ({ ...current, approvedAt: undefined, preparation: undefined, review: undefined, checks: undefined,
        execution: { ...current.execution!, preparationRound: 0 } }))
    const synced = await this.deps.sync.run(sessionId, 'finish', state.execution?.confirmBusy)
    const attempts = this.deps.records.get(sessionId)!.worktreeLifecycle!.journal
      .filter((row) => row.kind === 'update' && row.endedAt !== undefined && row.stepId.startsWith(`${state.actionId}-`))
    for (const attempt of attempts)
      await this.state.retainAttempt(sessionId, { runId: attempt.runId, title: `svn update ${attempt.paths?.join(', ') ?? '.'}` })
    if (!synced.ok) { await this.state.wait(sessionId, synced.code === 'session-working' ? 'worker-busy' : 'svn-failed', synced.detail); return false }
    return true
  }
}
