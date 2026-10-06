import { setTimeout as sleep } from 'node:timers/promises'

import type { RemoteControlCommitStatusDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionReviewPort, SessionReviewSettled } from '../../../lib-orchestrator/sessionManager/sessionReviewPort.types'
import type { SessionsOpResult } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import type { TabControlBroker } from '../tabs/tabControlBroker'
import type { VersioningCommitManager } from './versioningCommitManager'

/**
 * The commit dialog as the sessions library sees it: a review opened in the session's own tab, and
 * the state it ended in. The status object of the review is the receipt, read in this process, so
 * no envelope crosses a wire on the way.
 */
export class SessionReviewPortAdapter implements SessionReviewPort {
  private static readonly pollMillisecondsConst = 1_000
  private static readonly outOfDateConst = /out.of.date|E155011|E160028|E170004|newer content/i
  private readonly broker: Pick<TabControlBroker, 'openCommit'>
  private readonly commits: Pick<VersioningCommitManager, 'status'>
  private readonly tabTitleOf: (sessionId: string) => string | null
  private readonly pause: (milliseconds: number, signal: AbortSignal) => Promise<void>

  constructor(
    broker: Pick<TabControlBroker, 'openCommit'>,
    commits: Pick<VersioningCommitManager, 'status'>,
    tabTitleOf: (sessionId: string) => string | null,
    pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  ) {
    this.broker = broker
    this.commits = commits
    this.tabTitleOf = tabTitleOf
    this.pause = pause ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal }))
  }

  async open(input: { sessionId: string; scopeRoot: string; proposal: string }): Promise<SessionsOpResult<{ commitSessionId: string }>> {
    const tabTitle = this.tabTitleOf(input.sessionId)
    if (tabTitle === null) return { ok: false, code: 'not-found', detail: `No session ${input.sessionId}` }
    const opened = await this.broker.openCommit(input.sessionId, tabTitle, 'svn', input.scopeRoot, input.proposal, { fresh: true })
    if (!opened.ok) return { ok: false, code: 'review-unavailable', detail: opened.error.detail }
    const commitSessionId = opened.value.commitSessionId
    if (commitSessionId === undefined)
      return { ok: false, code: 'review-unavailable', detail: `The commit dialog for ${input.scopeRoot} opened without a review to wait for` }
    // A receipt proves only the scope the review stood on; a wider one would vouch for the wrong paths.
    if (PathCompare.comparable(opened.value.scopeRoot) !== PathCompare.comparable(input.scopeRoot))
      return {
        ok: false,
        code: 'review-unavailable',
        detail: `The commit dialog reviews ${opened.value.scopeRoot}, not ${input.scopeRoot}; nothing it commits counts for this finish`,
      }
    return { ok: true, value: { commitSessionId } }
  }

  /**
   * Polled like `commit-svn-jamat --wait`, and ended by the same rule: a failed attempt leaves the
   * review open for another try, so only a review that closed, committed or went to an external
   * client is settled.
   */
  async settled(commitSessionId: string, signal: AbortSignal): Promise<SessionReviewSettled> {
    for (;;) {
      signal.throwIfAborted()
      const status = this.commits.status(commitSessionId)
      if (status === null) return { state: 'lost' }
      const settled = SessionReviewPortAdapter.settledOf(status)
      if (settled !== null) return settled
      await this.pause(SessionReviewPortAdapter.pollMillisecondsConst, signal)
    }
  }

  private static settledOf(status: RemoteControlCommitStatusDto): SessionReviewSettled | null {
    if (status.state === 'committed') return { state: 'committed', revision: status.revision ?? '' }
    else if (status.state === 'external-closed') return { state: 'external-closed' }
    else if (status.state === 'cancelled') return status.closed ? { state: 'cancelled' } : null
    else if (status.state === 'failed') {
      if (!status.closed) return null
      const reason = status.detail ?? 'The commit failed'
      return { state: 'failed', reason, outOfDate: SessionReviewPortAdapter.outOfDateConst.test(reason) }
    }
    else if (status.state === 'editing' || status.state === 'running') return null
    else throw new Error(`Unknown commit state: ${JSON.stringify(status.state satisfies never)}`)
  }
}
