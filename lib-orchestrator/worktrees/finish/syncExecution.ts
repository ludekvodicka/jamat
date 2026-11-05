import type { FinishDriverDeps } from './finishDriver.types'
import type { FinishState } from './finishState'
import type { WorktreeLifecycle } from '../worktreeState'
import { SvnWorktreeRemoval } from '../removal/svnWorktreeRemoval'

export class SyncExecution {
  private readonly deps: Pick<FinishDriverDeps, 'records' | 'svn' | 'sync' | 'busyReason'>
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
    // After the worker settled Jamat's own conflict prompt the step stays due and is driven again on
    // each look, so the sync runs once the worker is idle; the sync's own idle gate still decides.
    const quiet = state.awaitingIdleAt !== undefined && state.execution?.confirmBusy !== true
    if (quiet) {
      const busy = this.deps.busyReason(sessionId)
      if (busy !== null) { await this.awaitIdle(sessionId, busy); return false }
    }
    const record = this.deps.records.get(sessionId)!
    const owner = await this.deps.svn.ownerCheck(SvnWorktreeRemoval.locationOf(record.worktree!))
    if (!owner.ok) { await this.state.wait(sessionId, 'svn-failed', owner.detail); return false }
    if (state.approvedAt !== undefined || state.preparation !== undefined)
      await this.state.write(sessionId, (current) => ({ ...current, approvedAt: undefined, preparation: undefined, review: undefined, checks: undefined,
        execution: { ...current.execution!, preparationRound: 0 } }))
    // The idle gate passed or the person confirmed a busy worker: the round runs now, so the step shows
    // the update and its log, not the wait it outlived by minutes in the 133 Finish.
    if (state.awaitingIdleAt !== undefined || state.awaitingIdleReason !== undefined)
      await this.state.write(sessionId, (current) => ({ ...current, awaitingIdleAt: undefined, awaitingIdleReason: undefined }))
    const synced = await this.deps.sync.run(sessionId, 'finish', state.execution?.confirmBusy)
    const attempts = this.deps.records.get(sessionId)!.worktreeLifecycle!.journal
      .filter((row) => row.kind === 'update' && row.endedAt !== undefined && row.stepId.startsWith(`${state.actionId}-`))
    for (const attempt of attempts)
      await this.state.retainAttempt(sessionId, { runId: attempt.runId, title: `svn update ${attempt.paths?.join(', ') ?? '.'}` })
    if (!synced.ok && synced.code === 'session-working' && quiet) { await this.awaitIdle(sessionId, this.deps.busyReason(sessionId) ?? synced.detail); return false }
    if (!synced.ok) { await this.state.wait(sessionId, synced.code === 'session-working' ? 'worker-busy' : 'svn-failed', synced.detail); return false }
    return true
  }

  /**
   * Names what holds the worker for the view, and keeps the gate armed when the round found the worker
   * busy after the gate passed; written only when it changed, since the step is looked at every poll.
   */
  private async awaitIdle(sessionId: string, busy: string): Promise<void> {
    const current = this.deps.records.get(sessionId)?.worktreeLifecycle
    if (current?.awaitingIdleReason === busy && current.awaitingIdleAt !== undefined) return
    await this.state.write(sessionId, (latest) => ({ ...latest, awaitingIdleAt: latest.awaitingIdleAt ?? Date.now(), awaitingIdleReason: busy }))
  }
}
