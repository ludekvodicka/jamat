import type { SessionReviewPort } from '../../../lib-orchestrator/sessionManager/sessionReviewPort.types'
import type { SessionsOpErrorCode, SessionsOpResult } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { VersioningCommitManager, VersioningCommitProposeResult } from './versioningCommitManager'

/** The session proposal contract over the client's commit drafts. */
export class SessionReviewPortAdapter implements SessionReviewPort {
  private readonly commits: Pick<VersioningCommitManager, 'propose' | 'forgetProposal' | 'proposalOf'>

  constructor(commits: Pick<VersioningCommitManager, 'propose' | 'forgetProposal' | 'proposalOf'>) {
    this.commits = commits
  }

  async propose(input: { sessionId: string; directory: string; message: string }): Promise<SessionsOpResult<{ scopeRoot: string }>> {
    const result = await this.commits.propose(input.sessionId, input.directory, input.message)
    if (result.ok) return { ok: true, value: { scopeRoot: result.scopeRoot } }
    return { ok: false, code: SessionReviewPortAdapter.codeOf(result.code), detail: result.detail }
  }

  forgetProposal(sessionId: string, scopeRoot: string): void {
    this.commits.forgetProposal(sessionId, scopeRoot)
  }

  proposalOf(sessionId: string, scopeRoot: string): string | null {
    return this.commits.proposalOf(sessionId, scopeRoot)
  }

  private static codeOf(code: Extract<VersioningCommitProposeResult, { ok: false }>['code']): SessionsOpErrorCode {
    if (code === 'message-empty' || code === 'message-too-long') return 'invalid-spec'
    else if (code === 'no-working-copy') return 'not-a-repo'
    else if (code === 'message-edited') return 'message-edited'
    else if (code === 'message-prefix') return 'message-unchecked'
    else if (code === 'busy') return 'already-running'
    else throw new Error(`Unknown proposal refusal: ${JSON.stringify(code satisfies never)}`)
  }
}
