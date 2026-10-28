import { PathCompare } from '../shared/pathCompare'
import { WorktreeLeaseHeld } from './worktreeLease'
import { ErrorText } from '../shared/errorText'
import type { SessionRecord } from '../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../sessionManager/worktreeSessionRecords'
import type { SvnStepJournalEntry } from './worktreeState'

export interface WorktreeRecoveryDeps {
  records: SessionRecordsStore
  commit(sessionId: string, entry: SvnStepJournalEntry): Promise<boolean>
  step(sessionId: string, entry: SvnStepJournalEntry): Promise<boolean>
  before(sessionId: string): Promise<boolean>
  resume(sessionId: string): void
  report(message: string): void
  now(): number
}

export class WorktreeRecovery {
  private readonly deps: WorktreeRecoveryDeps
  private readonly held = new Map<string, { at: number; runs: string[] }>()
  private retrying: Promise<void> | undefined

  constructor(deps: WorktreeRecoveryDeps) { this.deps = deps }

  /**
   * Whether the client stopped while this journaled svn step ran: its local run never wrote an
   * outcome, so its history entry still says `lost`.
   */
  static interrupted(record: SessionRecord, runId: string): boolean {
    return record.scriptRuns?.find((run) => run.runId === runId)?.outcome === 'lost'
  }

  static pending(record: SessionRecord): SvnStepJournalEntry[] {
    const state = record.worktreeLifecycle
    if (state?.unreadable !== undefined) return []
    if (state?.execution !== undefined && record.svnAction?.kind !== 'update-main') return state.journal.filter((entry) => {
      if (entry.recovered === 'not-landed') return false
      if (entry.endedAt === undefined) return true
      if (entry.kind !== 'commit' || state.step !== 'committing' && state.step !== 'verifying') return false
      const root = state.execution!.roots?.[state.execution!.rootCursor]
      const stepId = `${state.actionId}-commit-${root?.own || '.'}`
      if (entry.stepId !== stepId && entry.stepId !== `${state.actionId}-commit-${state.execution!.rootCursor}` || entry !== [...state.journal].reverse().find((row) => row.stepId === entry.stepId)) return false
      const receipt = record.commitReceipts?.find((row) => entry.cwd !== undefined && PathCompare.comparable(row.scopeRoot) === PathCompare.comparable(entry.cwd) && row.revision === entry.revision)
      return state.step === 'committing' || receipt === undefined || !state.execution!.evidence.some((row) => row.repository === root?.bounds?.repository && row.revision === receipt.revision
        && entry.paths !== undefined && entry.paths.every((path) => row.paths?.includes(path)))
    })
    const action = record.svnAction
    return (record.worktreeLifecycle?.journal ?? []).filter((entry) => {
      if (entry.endedAt === undefined) return true
      if (action?.kind === 'update-main' && action.needs !== undefined && entry.kind !== 'commit') return false
      if (action === undefined || action.verdict !== undefined || (action.runId !== undefined && action.runId !== entry.runId)) return false
      const kind = action.stage === 'committing' ? 'commit' : action.stage === 'updating' ? 'update'
        : action.stage === 'cleaning' ? 'cleanup' : action.stage === 'diffing' ? 'diff' : null
      if (kind === null || entry.kind !== kind) return false
      const stepId = kind === 'commit' ? `${action.actionId}-commit-${action.rootCursor}` : `${action.actionId}-${kind}`
      return entry.stepId === stepId && entry === [...record.worktreeLifecycle?.journal ?? []].reverse().find((row) => row.stepId === stepId)
    })
  }

  run(): Promise<void> { return this.recover(this.deps.records.list()) }

  /** Poll only interrupted commands held during recovery, never a new command running in this client. */
  retry(): Promise<void> {
    if (this.retrying !== undefined) return this.retrying
    const records: SessionRecord[] = []
    for (const [id, held] of this.held) {
      const record = this.deps.records.get(id)
      if (record === null || (record.svnAction?.needs?.kind !== 'locked' && record.worktreeLifecycle?.wait?.kind !== 'locked')
        || !WorktreeRecovery.pending(record).some((entry) => held.runs.includes(entry.runId))) this.held.delete(id)
      else if (this.deps.now() >= held.at + 5_000) records.push(record)
    }
    const work = this.recover(records).finally(() => { this.retrying = undefined })
    this.retrying = work
    return work
  }

  private async recover(records: readonly SessionRecord[]): Promise<void> {
    for (const record of records) {
      this.held.delete(record.sessionId)
      if (record.worktreeLifecycle?.unreadable !== undefined) continue
      if (record.pendingSetup?.local === true && (record.life !== 'starting'
        || record.pendingOperationId === undefined || record.pendingOperationKind === undefined)) continue
      const pending = WorktreeRecovery.pending(record)
      if (pending.length === 0 && record.pendingSetup?.local !== true) continue
      try {
        const commits = pending.filter((entry) => entry.kind === 'commit')
        let ready = true
        for (const entry of commits)
          if (!await this.deps.commit(record.sessionId, entry)) { ready = false; break }
        if (!ready) continue
        if (record.pendingSetup?.local === true) {
          await this.deps.before(record.sessionId)
          continue
        }
        // Commit recovery owns its cleanup and post-commit continuation; older sync intents cannot replay it.
        if (commits.length > 0) {
          this.deps.resume(record.sessionId)
          continue
        }
        const remaining = WorktreeRecovery.pending(this.deps.records.get(record.sessionId) ?? record)
        for (const entry of remaining) {
          if (!WorktreeRecovery.pending(this.deps.records.get(record.sessionId) ?? record).some((row) => row.runId === entry.runId)) continue
          if (!await this.deps.step(record.sessionId, entry)) { ready = false; break }
        }
        if (ready) this.deps.resume(record.sessionId)
      } catch (error) {
        const held = error instanceof WorktreeLeaseHeld
        if (held) this.held.set(record.sessionId, { at: this.deps.now(), runs: pending.map((entry) => entry.runId) })
        const reason = held ? `The interrupted SVN step is not recovered yet: ${ErrorText.of(error)}` : `Worktree recovery failed: ${ErrorText.of(error)}`
        const kind = held ? 'locked' : 'svn-failed'
        await this.deps.records.update(record.sessionId, (latest) => ({ ...latest,
          svnAction: latest.svnAction === undefined ? undefined : { ...latest.svnAction, needs: { kind, reason, at: this.deps.now() } },
          // An UPDATE of the main copy waits on its own action; the Finish that landed before it stays as it ended.
          worktreeLifecycle: latest.worktreeLifecycle === undefined || latest.svnAction?.kind === 'update-main' ? latest.worktreeLifecycle : { ...latest.worktreeLifecycle,
            version: latest.worktreeLifecycle.version + 1, phase: 'waiting', wait: { kind, reason, at: this.deps.now() } } }))
        this.deps.report(`Session ${record.sessionId}: ${reason}`)
      }
    }
  }
}
