import type { SessionInfo } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { VersioningCommitOpenSessions } from '../../../../shared/versioningCommit'
import { PanelSplitParams, type PanelSplitItem } from '../../../widgets/tabs/panelSplit'

export type TerminalSplitReview = NonNullable<VersioningCommitOpenSessions['reviews']>[number]

/**
 * The split tabs that wait for the person, each with the title its `!` carries: a commit review that
 * is still pending, the same reviews the session tab's `!` reads, and the session's actions while
 * one of their steps waits for the person.
 */
export class TerminalSplitMarks {
  static of(items: readonly PanelSplitItem[], sessionId: string, reviews: readonly TerminalSplitReview[],
    session: Pick<SessionInfo, 'actions' | 'workflow'> | null): ReadonlyMap<string, string> {
    const marks = new Map<string, string>()
    for (const item of items) {
      if (reviews.some((review) => TerminalSplitMarks.shows(review, item, sessionId))) marks.set(item.key, 'Commit review required')
      else if (item.kind === 'workflow' && item.sessionId === sessionId && TerminalSplitMarks.waits(session)) marks.set(item.key, 'Waits for you')
    }
    return marks
  }

  /** A Finish review shows in the session's actions; any other in the commit item of its draft. */
  static shows(review: TerminalSplitReview, item: PanelSplitItem, sessionId: string): boolean {
    if (review.sessionId !== sessionId) return false
    if (review.workflow) return item.kind === 'workflow' && item.sessionId === sessionId
    return item.kind === 'commit' && (item.reviewId === review.draftId || item.reviewId === undefined
      && item.key === PanelSplitParams.commitKeyOf(review.vcs, review.scopeRoot, review.paths))
  }

  private static waits(session: Pick<SessionInfo, 'actions' | 'workflow'> | null): boolean {
    const sections = session?.actions?.sections ?? (session?.workflow === undefined ? [] : [session.workflow])
    return sections.some((section) => section.open
      && section.rounds.some((round) => round.steps.some((step) => step.state === 'waits')))
  }
}
