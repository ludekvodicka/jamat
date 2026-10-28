import { posix } from 'node:path'
import type { SessionRecord, SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeLifecycle } from '../worktreeState'
import { FinishProjection } from './finishProjection'
import type { FinishDriverDeps } from './finishDriver.types'

export class FinishState {
  private readonly deps: Pick<FinishDriverDeps, 'changed' | 'handoffs' | 'now' | 'records' | 'results' | 'svn'>

  constructor(deps: Pick<FinishDriverDeps, 'changed' | 'handoffs' | 'now' | 'records' | 'results' | 'svn'>) {
    this.deps = deps
  }

  async write(sessionId: string, update: (state: WorktreeLifecycle) => WorktreeLifecycle, increment = true): Promise<void> {
    if (!await this.deps.records.update(sessionId, (record) => record.worktreeLifecycle === undefined ? null : {
      ...record, worktreeLifecycle: { ...update(record.worktreeLifecycle), version: record.worktreeLifecycle.version + (increment ? 1 : 0) },
    })) throw new Error('The Finish lifecycle could not be saved')
    this.deps.changed()
  }

  /** `write` together with the record of the run it names, so no reader sees one without the other. */
  async writeWithRun(sessionId: string, run: SessionRecord, update: (state: WorktreeLifecycle) => WorktreeLifecycle): Promise<void> {
    if (!await this.deps.records.putWith(run, sessionId, (record) => record.worktreeLifecycle === undefined ? null : {
      ...record, worktreeLifecycle: { ...update(record.worktreeLifecycle), version: record.worktreeLifecycle.version + 1 },
    })) throw new Error(`The run ${run.sessionId} could not be saved`)
    this.deps.changed()
  }

  async wait(sessionId: string, kind: NonNullable<WorktreeLifecycle['wait']>['kind'], reason: string): Promise<void> {
    const before = this.deps.records.get(sessionId)?.worktreeLifecycle
    const prior = before?.wait
    if (prior?.kind === 'worker-lost') return
    const at = kind === 'waiting-for-review' && before?.execution?.reviewWaitAt !== undefined ? before.execution.reviewWaitAt
      : prior?.kind === kind && prior.reason === reason ? prior.at : this.deps.now()
    // A liveness poll can replace the wait while this Finish write is queued.
    await this.write(sessionId, (state) => state.wait?.kind === 'worker-lost' ? state : ({ ...state, phase: 'waiting', wait: { kind, reason, at },
      ...(kind === 'waiting-for-review' ? { execution: { ...state.execution!, reviewWaitAt: at } } : {}),
      ...(state.review === undefined ? {} : { review: { ...state.review, version: state.version + 1 } }) }))
    if (this.deps.records.get(sessionId)?.worktreeLifecycle?.wait?.kind === 'worker-lost') return
    if (prior?.at !== at && !(kind === 'waiting-for-review' && before?.execution?.reviewWaitAt === at)) await this.deps.handoffs.notifyCaller(sessionId, `${kind}: ${reason}`)
  }

  async retainAttempt(sessionId: string, attempt: { runId: string; title: string }): Promise<string> {
    const path = await this.keepAttempt(sessionId, attempt)
    if (path === null) throw new Error(`The full log ${attempt.runId} could not be retained`)
    return path
  }

  /** Null when the log no longer exists; retrying cannot bring it back, so the pending retention ends too. */
  async keepAttempt(sessionId: string, attempt: { runId: string; title: string }): Promise<string | null> {
    await this.write(sessionId, (state) => ({ ...state, execution: { ...state.execution!, pendingLog: attempt } }))
    const path = await this.deps.results.keepAttempt(this.deps.records.get(sessionId)!.worktreeLifecycle!.actionId!, sessionId, attempt)
    await this.write(sessionId, (state) => ({ ...state, execution: { ...state.execution!, pendingLog: undefined } }))
    return path
  }

  async changedHashes(root: string): Promise<Record<string, string>> {
    const paths = await this.deps.svn.changes(root)
    if (!paths.ok) throw new Error(paths.detail)
    const hashes = await this.deps.svn.commitHashes(root, paths.value.map((row) => row.path), 'node')
    if (!hashes.ok) throw new Error(hashes.detail)
    return hashes.value
  }

  action(sessionId: string): SessionRecordSvnAction {
    const record = this.deps.records.get(sessionId)
    const action = record === null ? undefined : FinishProjection.action(record)
    if (action === undefined) throw new Error('No active Finish')
    return action
  }

  static repositoryPath(base: string, path: string): string {
    return posix.join(base || '/', path).replace(/\/$/, '') || '/'
  }
}
