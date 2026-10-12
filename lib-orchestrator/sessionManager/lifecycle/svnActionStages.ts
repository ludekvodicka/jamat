import type { SessionRecordScriptLink, SessionRecordSvnAction } from '../records/sessionRecord.types'
import type { SessionSvnActionInfo, SvnActionStage, SvnFinishPhase } from '../sessionManagerApi.types'

/**
 * The stages of an SVN action as data: which of them wait on a run, which run that is, and the four
 * legacy finish words an older peer draws. Every rule here is a total switch, so a new stage does not
 * compile until each one says what it is.
 */
export class SvnActionStages {
  /** True: the stage waits on `runId` through the `action` gate; false: this client drives it. */
  static isRun(stage: SvnActionStage): boolean {
    switch (stage) {
      case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'diffing': case 'reviewing':
        return true
      case 'stopping': case 'evidence': case 'verifying': case 'removing': case 'recording':
        return false
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
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
      case 'stopping': case 'evidence': case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'verifying':
      case 'diffing':
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
      case 'reviewing': return { phase: 'after', scriptId: 'review', name: SvnActionStages.reviewNameOf(action) }
      case 'stopping': case 'evidence': case 'verifying': case 'removing': case 'recording':
        throw new Error(`The client stage ${stage} waits on no run`)
      default:
        throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  /** What the snapshot and `sessions worktree` say about an action. */
  static infoOf(action: SessionRecordSvnAction): SessionSvnActionInfo {
    const roots = action.roots ?? []
    const root = action.stage === 'reviewing' ? roots[action.rootCursor] : undefined
    return {
      kind: action.kind,
      stage: action.stage,
      needs: action.needs?.reason ?? null,
      needsKind: action.needs?.kind ?? null,
      review: root === undefined ? null : { index: action.rootCursor + 1, count: roots.length, scopeRoot: root.path },
    }
  }

  /** The scope root of the review open now, for the legacy finish field. */
  static scopeRootOf(action: SessionRecordSvnAction): string | undefined {
    return action.stage === 'reviewing' ? action.roots?.[action.rootCursor]?.path : undefined
  }

  private static reviewNameOf(action: SessionRecordSvnAction): string {
    const root = action.roots?.[action.rootCursor]
    if (root === undefined) throw new Error(`An SVN action reviews root ${action.rootCursor} of ${action.roots?.length ?? 0}`)
    return root.own === '' ? '.' : root.own
  }
}
