import type { SessionReviewPort } from '../../../lib-orchestrator/sessionManager/sessionReviewPort.types'
import type { SessionsOpErrorCode, SessionsOpResult } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import type { TabControlBroker } from '../tabs/tabControlBroker'
import type { VersioningCommitManager, VersioningCommitProposeResult } from './versioningCommitManager'

/**
 * The commit dialog as the sessions library sees it: a review opened in a session's own tab, whether
 * it is still known, and the message a worker proposed for it. The review run that asked for it waits
 * for its status itself; once the review settles, the parent's workflow takes the focus back.
 */
export class SessionReviewPortAdapter implements SessionReviewPort {
  private readonly broker: Pick<TabControlBroker, 'openCommit'>
  private readonly commits: Pick<VersioningCommitManager, 'status' | 'propose' | 'proposalOf' | 'forgetProposal'>
  private readonly tabTitleOf: (sessionId: string) => string | null

  constructor(
    broker: Pick<TabControlBroker, 'openCommit'>,
    commits: Pick<VersioningCommitManager, 'status' | 'propose' | 'proposalOf' | 'forgetProposal'>,
    tabTitleOf: (sessionId: string) => string | null,
  ) {
    this.broker = broker
    this.commits = commits
    this.tabTitleOf = tabTitleOf
  }

  async open(input: { sessionId: string; parentId: string; scopeRoot: string; proposal: string }): Promise<SessionsOpResult<{ commitSessionId: string }>> {
    const tabTitle = this.tabTitleOf(input.sessionId)
    if (tabTitle === null) return { ok: false, code: 'not-found', detail: `No session ${input.sessionId}` }
    const parentTitle = this.tabTitleOf(input.parentId)
    const opened = await this.broker.openCommit(input.sessionId, tabTitle, 'svn', input.scopeRoot, input.proposal, {
      fresh: true,
      // Once the review settles, the focus goes back to the workflow of the action that reviews.
      ...parentTitle === null ? {} : { returnToWorkflow: { sessionId: input.parentId, tabTitle: parentTitle } },
    })
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

  known(commitSessionId: string): boolean {
    return this.commits.status(commitSessionId) !== null
  }

  async propose(input: { sessionId: string; directory: string; message: string }): Promise<SessionsOpResult<{ scopeRoot: string }>> {
    const result = await this.commits.propose(input.sessionId, input.directory, input.message)
    if (result.ok) return { ok: true, value: { scopeRoot: result.scopeRoot } }
    return { ok: false, code: SessionReviewPortAdapter.codeOf(result.code), detail: result.detail }
  }

  proposalOf(sessionId: string, scopeRoot: string): string | null {
    return this.commits.proposalOf(sessionId, scopeRoot)
  }

  forgetProposal(sessionId: string, scopeRoot: string): void {
    this.commits.forgetProposal(sessionId, scopeRoot)
  }

  private static codeOf(code: Extract<VersioningCommitProposeResult, { ok: false }>['code']): SessionsOpErrorCode {
    if (code === 'message-empty' || code === 'message-too-long') return 'invalid-spec'
    else if (code === 'no-working-copy') return 'not-a-repo'
    else if (code === 'message-edited') return 'message-edited'
    else if (code === 'busy') return 'already-running'
    else throw new Error(`Unknown proposal refusal: ${JSON.stringify(code satisfies never)}`)
  }
}
