import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordScriptLink, SessionRecordScriptStep, SessionRecordSvnAction, SvnActionPass } from '../../sessionManager/worktreeSessionRecords'
import type { SessionSvnActionInfo, SvnActionStage, SvnFinishPhase } from '../../sessionManager/sessionManagerApi.types'
import { SvnConflictFlow } from '../conflicts/svnConflictFlow'
import { SvnConflictWords, type SvnConflictSide } from '../conflicts/svnConflictWords'
import { FinishStepPolicy } from './finishStepPolicy'

/**
 * The stages of an SVN action as data: which of them wait on a run, which run that is, and the four
 * legacy finish words an older peer draws. Every rule here is a total switch, so a new stage does not
 * compile until each one says what it is.
 */
export class SvnActionStages {
  static running(record: SessionRecord): boolean {
    const lifecycle = record.worktreeLifecycle
    if (lifecycle?.execution !== undefined && record.svnAction?.kind !== 'update-main')
      return lifecycle.phase === 'finishing' && lifecycle.step !== undefined && FinishStepPolicy.steps[lifecycle.step].background
    return record.svnAction !== undefined && record.svnAction.needs === undefined
      && record.svnAction.stage !== 'changes' && record.svnAction.stage !== 'main-update'
  }

  /** The passes an action keeps; the oldest go first. */
  static readonly passesMaxConst = 40

  /** The install step a checks stage runs before its checks, while its refresh has not ended; else null. */
  static installOf(action: Pick<SessionRecordSvnAction, 'refresh'>): SessionRecordScriptStep | null {
    const refresh = action.refresh
    if (refresh === undefined || refresh.endedAt !== undefined) return null
    return refresh.steps[Math.min(refresh.cursor, refresh.steps.length - 1)]
  }

  /** True: the stage waits on `runId` through the `action` gate; false: this client drives it. */
  static isRun(stage: SvnActionStage): boolean {
    switch (stage) {
      case 'committing': case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'merging': case 'diffing':
        return true
      case 'reviewing': case 'main-update': case 'changes': case 'stopping': case 'evidence': case 'verifying': case 'fixing': case 'removing': case 'recording':
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
      case 'main-update': case 'changes': case 'stopping': case 'evidence': case 'committing': case 'checks': case 'updating': case 'cleaning': case 'verifying': case 'fixing':
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
    if (action.stage === 'changes') return SvnConflictFlow.unsettled(action.conflictSet)
    if (need === 'conflict') return SvnConflictFlow.open(action.conflictSet)
    return need === 'resolver-failed' && SvnConflictFlow.unsettled(action.conflictSet)
  }

  /**
   * A client step is due: a client stage, a verdict to judge, a relaunch whose wait is over, or a lost
   * launch. The caller asks only for actions no drive of this process holds.
   */
  static clientDue(action: SessionRecordSvnAction, now = Number.POSITIVE_INFINITY): boolean {
    if (action.needs !== undefined || action.stage === 'changes' || action.stage === 'main-update') return false
    if (!SvnActionStages.isRun(action.stage) || action.verdict !== undefined || SvnActionStages.launchLost(action)) return true
    return action.retryAt !== undefined && now >= action.retryAt
  }

  /**
   * A run stage that names neither its run nor a retry. A launch writes the action so before it
   * starts its command, and only the drive that wrote it is inside that launch; outside every drive,
   * the client stopped mid-launch and nothing else starts the stage again (Mirabia 118, 2026-10-30).
   */
  static launchLost(action: SessionRecordSvnAction): boolean {
    return SvnActionStages.isRun(action.stage) && action.needs === undefined && action.verdict === undefined
      && action.runId === undefined && action.retryAt === undefined
  }

  /**
   * The finish phase a peer before 3.11 accepts: it refuses a session whose phase it does not know,
   * so every stage maps onto one of its four.
   */
  static legacyPhaseOf(stage: SvnActionStage): SvnFinishPhase {
    switch (stage) {
      case 'main-update': case 'changes': case 'stopping': case 'evidence': case 'committing': case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'merging':
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
        const install = SvnActionStages.installOf(action)
        if (install !== null) return { phase: 'after', scriptId: 'setup', name: install.name }
        const step = action.checks[action.checkCursor]
        if (step === undefined) throw new Error(`An SVN action names check ${action.checkCursor} of ${action.checks.length}`)
        return { phase: 'after', scriptId: 'checks', name: step.name }
      }
      case 'committing': return { phase: 'after', scriptId: 'svn', name: 'commit' }
      case 'updating': return { phase: 'after', scriptId: 'svn', name: 'update' }
      case 'cleaning': return { phase: 'after', scriptId: 'svn', name: 'cleanup' }
      case 'diffing': return { phase: 'after', scriptId: 'svn', name: 'diff' }
      case 'resolving': return { phase: 'after', scriptId: 'svn-resolve', name: 'resolver' }
      case 'merging': return { phase: 'after', scriptId: 'svn-merge', name: 'merger' }
      case 'reviewing': case 'main-update': case 'changes': case 'stopping': case 'evidence': case 'verifying': case 'fixing': case 'removing': case 'recording':
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
    const revision = (previous.stage === 'reviewing' || previous.stage === 'committing') ? SvnActionStages.committedOf(previous, next) : null
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

  /** What the snapshot and `sessions worktree` say about an action; a conflict set adds its summary, every open entry and settled ones up to 50. */
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
          conflicts: SvnConflictWords.listOf(set, SvnConflictFlow.wireMaxConst, SvnActionStages.sideOf(action)),
          ...action.mergeBrief === undefined ? {} : { mergeBrief: action.mergeBrief },
        }
        : {},
      ...action.stage === 'merging' && action.merger !== undefined ? { mergerRunId: action.merger.runId } : {},
    }
  }

  /** An UPDATE works in a main copy, where the local side of a conflict is the person's own work. */
  static sideOf(action: Pick<SessionRecordSvnAction, 'kind'>): SvnConflictSide {
    const kind = action.kind
    switch (kind) {
      case 'update-main': return 'main-copy'
      case 'finish': case 'discard': return 'worktree'
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
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
}
