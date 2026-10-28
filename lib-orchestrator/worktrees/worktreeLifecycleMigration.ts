import type { SessionRecord, SessionRecordSvnAction } from '../sessionManager/worktreeSessionRecords'
import type { SvnActionNeed, SvnActionStage } from '../sessionManager/sessionManagerApi.types'
import { WorktreeStateValidation } from './worktreeStateValidation'
import type { FinishStep, WorktreeActor, WorktreeLifecycle, WorktreeWaitKind } from './worktreeState'

export class WorktreeLifecycleMigration {
  private static readonly stages: readonly string[] = ['stopping', 'evidence', 'checks', 'updating', 'cleaning', 'resolving', 'merging', 'verifying', 'fixing', 'diffing', 'changes', 'committing', 'main-update', 'reviewing', 'removing', 'recording'] satisfies readonly SvnActionStage[]

  private static readonly actors: Record<SessionRecordSvnAction['requestedBy'], WorktreeActor> = {
    window: 'person', peer: 'agent', cli: 'agent',
  }
  private static readonly liveness: Record<SessionRecord['life'], 'alive' | 'dead'> = {
    starting: 'alive', live: 'alive', ended: 'dead', lost: 'dead',
  }
  private static readonly purposes: Record<SessionRecordSvnAction['kind'], WorktreeLifecycle['purpose']> = {
    finish: 'finish', discard: 'discard', 'update-main': undefined,
  }

  static fromOld(record: SessionRecord): WorktreeLifecycle | null {
    if (record.worktree === undefined && record.retiredWorktree === undefined && record.svnAction?.kind !== 'update-main') return null
    const action = record.svnAction
    const base: WorktreeLifecycle = {
      version: 0, actionId: action?.actionId ?? null, phase: 'active', outOfDate: action?.rounds?.outOfDate ?? 0, journal: [],
      facts: { worker: { liveness: record.exitReason === 'stopped' && WorktreeLifecycleMigration.liveness[record.life] === 'dead'
        ? 'stopped' : WorktreeLifecycleMigration.liveness[record.life] ?? 'dead', resumeFailures: 0 } },
      ...record.worktree?.conflictMemory === undefined ? {} : { conflictMemory: structuredClone(record.worktree.conflictMemory) },
    }
    if (action !== undefined) return WorktreeLifecycleMigration.action(base, action)
    if (record.retiredWorktree !== undefined)
      return { ...base, phase: record.retiredWorktree.landed !== undefined ? 'landed' : 'removed' }
    if (record.worktreeCleanup?.phase === 'kept' || record.worktreeOutcome?.worktree === 'kept')
      return { ...base, phase: 'kept' }
    if (record.worktreeCleanup?.phase === 'pending')
      return { ...base, phase: 'waiting', step: 'removing', wait: { kind: 'removal-blocked',
        reason: record.worktreeCleanup.reason ?? 'Worktree cleanup is pending', at: record.worktreeCleanup.requestedAt } }
    if (record.worktreeFinish !== undefined || record.worktreeMerge !== undefined)
      return WorktreeLifecycleMigration.unknown(base, record.createdAt)
    return base
  }

  static shadow(record: SessionRecord, previous: SessionRecord): SessionRecord {
    if (previous.worktreeLifecycle?.execution !== undefined)
      return { ...record, worktreeLifecycle: record.worktreeLifecycle ?? previous.worktreeLifecycle }
    const mapped = WorktreeLifecycleMigration.fromOld(record)
    const prior = WorktreeStateValidation.parse(previous.worktreeLifecycle) === undefined ? undefined : previous.worktreeLifecycle
    if (mapped === null) return { ...record, worktreeLifecycle: prior === undefined || prior.journal.length === 0 ? undefined
      : { ...prior, version: prior.version + 1, actionId: null, phase: 'active', step: undefined, wait: undefined } }
    const sameAction = prior?.actionId === mapped.actionId
    return { ...record, worktreeLifecycle: {
      ...prior, ...mapped, version: (prior?.version ?? -1) + 1,
      step: mapped.step, wait: mapped.wait, conflictMemory: record.worktree === undefined || record.svnAction?.kind === 'update-main' ? prior?.conflictMemory : mapped.conflictMemory,
      owner: mapped.owner, purpose: mapped.purpose, hasWindow: mapped.hasWindow,
      review: sameAction ? prior?.review : undefined, removalPermit: sameAction ? prior?.removalPermit : undefined,
      journal: prior?.journal ?? mapped.journal, facts: prior?.facts ?? mapped.facts,
    } }
  }

  static unknown(base: WorktreeLifecycle, at: number): WorktreeLifecycle {
    return { ...base, phase: 'waiting', step: undefined, review: undefined,
      wait: { kind: 'svn-failed', reason: 'Unknown state after upgrade', at } }
  }

  private static action(base: WorktreeLifecycle, action: SessionRecordSvnAction): WorktreeLifecycle {
    const at = action.stageAt ?? action.startedAt
    if (!WorktreeLifecycleMigration.stages.includes(action.stage)) return WorktreeLifecycleMigration.unknown(base, at)
    const step = WorktreeLifecycleMigration.stepOf(action.stage)
    const state: WorktreeLifecycle = { ...base, phase: 'finishing', step,
      ...step === 'committing' ? { legacyCommit: true as const } : {},
      owner: WorktreeLifecycleMigration.actors[action.requestedBy],
      ownerSince: action.startedAt,
      hasWindow: action.requestedBy === 'window',
      purpose: WorktreeLifecycleMigration.purposes[action.kind],
    }
    if (action.kind === 'update-main' && action.needs !== undefined && action.stage === 'main-update')
      return { ...state, step: 'syncing', phase: 'waiting', wait: { ...action.needs, kind: WorktreeLifecycleMigration.waitOf(action.needs.kind) } }
    if (action.needs !== undefined)
      return { ...state, phase: 'waiting', wait: { ...action.needs, kind: WorktreeLifecycleMigration.waitOf(action.needs.kind) } }
    if (action.stage === 'main-update')
      return { ...state, phase: 'landed', step: undefined }
    return state
  }

  private static stepOf(stage: SvnActionStage): FinishStep {
    switch (stage) {
      case 'stopping': return 'stopping-worker'
      case 'evidence': case 'updating': case 'cleaning': case 'diffing': return 'syncing'
      case 'checks': return 'checking'
      case 'resolving': case 'merging': case 'fixing': return 'worker-resolving'
      case 'verifying': return 'verifying'
      case 'changes': case 'reviewing': return 'reviewing'
      case 'committing': return 'committing'
      case 'removing': return 'removing'
      case 'recording': case 'main-update': return 'recording'
      default: throw new Error(`Unknown SVN stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  private static waitOf(need: SvnActionNeed): WorktreeWaitKind {
    switch (need) {
      case 'check-failed': return 'checks-failed'
      case 'conflict': case 'resolver-failed': return 'conflict-person'
      case 'incoming': case 'review-cancelled': case 'review-interrupted': return 'review'
      case 'out-of-date': return 'repository-busy'
      case 'partial': return 'partially-landed'
      case 'not-stopped': return 'worker-lost'
      case 'worker-busy': return 'worker-busy'
      case 'pinned-external': case 'locked': case 'svn-failed': case 'removal-blocked': return need
      default: throw new Error(`Unknown SVN need: ${JSON.stringify(need satisfies never)}`)
    }
  }
}
