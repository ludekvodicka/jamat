import type { SessionRecordScriptLink, SessionRecordSvnAction, SvnActionPass } from '../records/sessionRecord.types'
import type { SessionSvnActionInfo, SvnActionStage, SvnFinishPhase } from '../sessionManagerApi.types'
import { SvnConflictFlow } from './svnConflictFlow'
import { SvnConflictWords } from './svnConflictWords'

/**
 * The stages of an SVN action as data: which of them wait on a run, which run that is, and the four
 * legacy finish words an older peer draws. Every rule here is a total switch, so a new stage does not
 * compile until each one says what it is.
 */
export class SvnActionStages {
  /** The passes an action keeps; the oldest go first. */
  static readonly passesMaxConst = 40

  /** True: the stage waits on `runId` through the `action` gate; false: this client drives it. */
  static isRun(stage: SvnActionStage): boolean {
    switch (stage) {
      case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'merging': case 'diffing': case 'reviewing':
        return true
      case 'stopping': case 'evidence': case 'verifying': case 'fixing': case 'removing': case 'recording':
        return false
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /**
   * The agent run an agent stage waits on, which Keep, Discard and Stop agent stop first; null for
   * every other stage.
   */
  static agentRunOf(action: SessionRecordSvnAction): string | null {
    const stage = action.stage
    switch (stage) {
      case 'resolving': return action.runId ?? null
      case 'merging': return action.merger?.runId ?? action.runId ?? null
      case 'stopping': case 'evidence': case 'checks': case 'updating': case 'cleaning': case 'verifying': case 'fixing':
      case 'diffing': case 'reviewing': case 'removing': case 'recording':
        return null
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /**
   * Whether the next Finish press on this waiting action goes back to its conflicts (`fixing`) rather
   * than to the evidence: a Finish that waits on its conflicts, also once every path is settled (the
   * person settled the last one, or a guard after the merger waits), or on a resolver that failed with
   * a path still open. The workflow calls that press Check again.
   */
  static resumesAtFixing(action: SessionRecordSvnAction): boolean {
    const need = action.needs?.kind
    if (action.kind !== 'finish') return false
    if (need === 'conflict') return SvnConflictFlow.open(action.conflictSet)
    return need === 'resolver-failed' && SvnConflictFlow.unsettled(action.conflictSet)
  }

  /** A client step is due: a client stage, a verdict to judge, or a relaunch whose wait is over. */
  static clientDue(action: SessionRecordSvnAction, now = Number.POSITIVE_INFINITY): boolean {
    if (action.needs !== undefined) return false
    if (!SvnActionStages.isRun(action.stage) || action.verdict !== undefined) return true
    return action.retryAt !== undefined && now >= action.retryAt
  }

  /**
   * The finish phase a peer before 3.11 accepts: it refuses a session whose phase it does not know,
   * so every stage maps onto one of its four.
   */
  static legacyPhaseOf(stage: SvnActionStage): SvnFinishPhase {
    switch (stage) {
      case 'stopping': case 'evidence': case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'merging':
      case 'verifying': case 'fixing': case 'diffing':
        return 'updating'
      case 'reviewing':
        return 'reviewing'
      case 'removing': case 'recording':
        return 'removing'
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /** The run a run stage waits on, as its link names it. */
  static linkOf(action: SessionRecordSvnAction): Pick<SessionRecordScriptLink, 'phase' | 'scriptId' | 'name'> {
    const stage = action.stage
    switch (stage) {
      case 'checks': {
        const step = action.checks[action.checkCursor]
        if (step === undefined) throw new Error(`An SVN action names check ${action.checkCursor} of ${action.checks.length}`)
        return { phase: 'after', scriptId: 'checks', name: step.name }
      }
      case 'updating': return { phase: 'after', scriptId: 'svn', name: 'update' }
      case 'cleaning': return { phase: 'after', scriptId: 'svn', name: 'cleanup' }
      case 'diffing': return { phase: 'after', scriptId: 'svn', name: 'diff' }
      case 'resolving': return { phase: 'after', scriptId: 'svn-resolve', name: 'resolver' }
      case 'merging': return { phase: 'after', scriptId: 'svn-merge', name: 'merger' }
      case 'reviewing': return { phase: 'after', scriptId: 'review', name: SvnActionStages.reviewNameOf(action) }
      case 'stopping': case 'evidence': case 'verifying': case 'fixing': case 'removing': case 'recording':
        throw new Error(`The client stage ${stage} waits on no run`)
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /**
   * The action as it is written over `previous`: when it leaves a stage (a new stage, a new run of a
   * run stage, or a press that moves a waiting action on), one pass for the stage it left, and the
   * time the next one began. The passes are always `previous`'s, so a stale copy never drops one.
   */
  static passedOf(previous: SessionRecordSvnAction, next: SessionRecordSvnAction, now: number): SessionRecordSvnAction {
    const left = previous.stage !== next.stage
      || (previous.runId !== undefined && next.runId !== previous.runId)
      || (previous.needs !== undefined && next.needs === undefined)
    // The notifier writes the notice beside the flow: only a new wait's notice replaces it.
    const notice = next.notice !== undefined && next.notice.id !== previous.notice?.id ? next.notice : previous.notice
    const noticed = notice === undefined ? {} : { notice }
    if (!left) return { ...next, ...noticed, passes: previous.passes, stageAt: previous.stageAt }
    const pass: SvnActionPass = {
      stage: previous.stage,
      ...previous.runId === undefined || !SvnActionStages.isRun(previous.stage) ? {} : { runId: previous.runId },
      startedAt: previous.stageAt ?? previous.startedAt,
      endedAt: now,
      result: SvnActionStages.resultOf(previous),
    }
    const revision = previous.stage === 'reviewing' ? SvnActionStages.committedOf(previous, next) : null
    if (revision !== null) pass.facts = { revision }
    // The update this pass ends read the set the next action holds.
    const set = previous.stage === 'updating' ? next.conflictSet : undefined
    if (set !== undefined && set.readAt >= pass.startedAt && SvnConflictFlow.totalOf(set) > 0)
      pass.facts = { ...pass.facts, conflicts: SvnConflictFlow.totalOf(set) }
    // A check of the conflicts says what Jamat's rules settled and what was left open.
    const checked = previous.stage === 'fixing' ? next.conflictSet ?? previous.conflictSet : undefined
    if (checked !== undefined && SvnConflictFlow.totalOf(checked) > 0)
      pass.facts = {
        ...pass.facts,
        conflicts: SvnConflictFlow.totalOf(checked),
        fixed: checked.entries.filter((entry) => entry.state === 'settled' && entry.by === 'jamat').length,
        left: checked.entries.filter((entry) => entry.state !== 'settled').length + checked.more,
      }
    return { ...next, ...noticed, passes: [...previous.passes ?? [], pass].slice(-SvnActionStages.passesMaxConst), stageAt: now }
  }

  /** What the snapshot and `sessions worktree` say about an action; a conflict set adds its summary and at most 50 entries. */
  static infoOf(action: SessionRecordSvnAction): SessionSvnActionInfo {
    const roots = action.roots ?? []
    const root = action.stage === 'reviewing' ? roots[action.rootCursor] : undefined
    const set = action.conflictSet
    return {
      kind: action.kind,
      stage: action.stage,
      needs: action.needs?.reason ?? null,
      needsKind: action.needs?.kind ?? null,
      review: root === undefined ? null : { index: action.rootCursor + 1, count: roots.length, scopeRoot: root.path },
      ...SvnConflictFlow.open(set)
        ? {
          summary: SvnConflictWords.summaryOf(set),
          conflicts: SvnConflictWords.listOf(set, SvnConflictFlow.wireMaxConst),
          ...action.mergeBrief === undefined ? {} : { mergeBrief: action.mergeBrief },
        }
        : {},
      ...action.stage === 'merging' && action.merger !== undefined ? { mergerRunId: action.merger.runId } : {},
    }
  }

  /** The scope root of the review open now, for the legacy finish field. */
  static scopeRootOf(action: SessionRecordSvnAction): string | undefined {
    return action.stage === 'reviewing' ? action.roots?.[action.rootCursor]?.path : undefined
  }

  private static resultOf(action: SessionRecordSvnAction): SvnActionPass['result'] {
    if (action.needs !== undefined) return 'waited'
    // The merger ends by its last settlement, which stops it, or by its own exit: never a failure.
    if (action.stage === 'merging') return 'done'
    // A relaunch after a lock clears the verdict and keeps only its pace.
    if (action.verdict?.kind === 'failed' || action.retryAt !== undefined) return 'failed'
    return 'done'
  }

  /** The newest revision a review added to the evidence, or null. */
  private static committedOf(previous: SessionRecordSvnAction, next: SessionRecordSvnAction): number | null {
    const known = new Set(previous.evidence.map((entry) => `${entry.repository}@${entry.revision}`))
    const added = next.evidence.filter((entry) => !known.has(`${entry.repository}@${entry.revision}`)).map((entry) => entry.revision)
    return added.length === 0 ? null : Math.max(...added)
  }

  private static reviewNameOf(action: SessionRecordSvnAction): string {
    const root = action.roots?.[action.rootCursor]
    if (root === undefined) throw new Error(`An SVN action reviews root ${action.rootCursor} of ${action.roots?.length ?? 0}`)
    return root.own === '' ? '.' : root.own
  }
}
