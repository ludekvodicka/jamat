import { WorktreeOutcomes } from '../../../lib-orchestrator/sessionManager/worktreeOutcomes'
import type { RemoteWorkflowReview } from '../../../lib-orchestrator/remoteControl/remoteReviewApi.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionWorkflowBody, SessionWorkflowInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import { WorktreeWords } from '../../../lib-orchestrator/worktrees/worktreeViews'
import type { VersioningCommitDraftDto, VersioningCommitRunResult, VersioningWorkflowState, VersioningWorkflowPort } from '../../shared/versioningCommit'

export class VersioningWorkflowAccess implements VersioningWorkflowPort {
  private readonly sessions: Pick<SessionManager, 'snapshot' | 'finishWorktreeSession'>

  private readonly results?: Pick<ReturnType<SessionManager['worktreeResultsStore']>, 'list'>

  constructor(sessions: VersioningWorkflowAccess['sessions'], results?: Pick<ReturnType<SessionManager['worktreeResultsStore']>, 'list'>) {
    this.sessions = sessions
    this.results = results
  }

  repositories(draft: VersioningCommitDraftDto): VersioningCommitDraftDto['repositories'] {
    return this.commitBodies(draft).flatMap((body) => body.repositories ?? [])
      .map((repository) => !repository.message.trim() && repository.source === 'unknown'
        && PathCompare.comparable(repository.root) === PathCompare.comparable(draft.scopeRoot)
        ? { ...repository, message: draft.message, source: draft.messageSource ?? 'unknown' } : repository)
  }

  /** The rule Session actions draws the fields by, so a proposal is judged by the field the person sees. */
  separateMessages(draft: VersioningCommitDraftDto): boolean {
    return this.commitBodies(draft).some((body) => (body.repositories?.length ?? 0) > 1 || body.separateMessages === true && (body.repositories?.length ?? 0) > 0)
  }

  /**
   * Only a session that is gone: a live session's later Finish reuses the draft with the person's
   * text. Before the first answered reconcile no record is read yet and every session looks gone.
   */
  abandoned(draft: VersioningCommitDraftDto): boolean {
    const snapshot = this.sessions.snapshot()
    return draft.workflow !== undefined && snapshot.reconciled && !snapshot.sessions.some((entry) => entry.sessionId === draft.sessionId)
  }

  messageSource(draft: VersioningCommitDraftDto): VersioningCommitDraftDto['messageSource'] {
    return this.results?.list({ sessionId: draft.sessionId }).some((result) => result.removal === 'kept'
      && result.messageSource === 'kept-attempt' && result.message === draft.message && result.at >= (draft.messageAt ?? 0)
      && PathCompare.isInside(result.worktreePath, draft.scopeRoot)) ? 'kept-attempt' : undefined
  }

  offers(sessionId: string, vcs: 'svn' | 'git', scope: string): boolean {
    return this.sections(sessionId).some((section) => section.open && section.actions.some((action) => action.requiresCommit)
      && section.rounds.some((round) => round.steps.some((step) => step.state === 'waits' && step.body?.kind === 'commit'
        && step.body.vcs === vcs && PathCompare.comparable(step.body.scopeRoot) === PathCompare.comparable(scope))))
  }

  owns(sessionId: string): boolean {
    const session = this.sessions.snapshot().sessions.find((entry) => entry.sessionId === sessionId)
    return session?.worktree?.kind === 'svn' || session?.retiredWorktree !== undefined
  }

  check(draft: VersioningCommitDraftDto, request: RemoteWorkflowReview): string | null {
    const snapshot = this.sessions.snapshot()
    const version = snapshot.sessions.find((session) => session.sessionId === draft.sessionId)?.worktreeView?.version
    if (request.reviewVersion !== undefined && request.reviewVersion !== version) return 'This review is outdated'
    if (request.reviewVersion === undefined && snapshot.revision !== request.revision)
      return 'Session actions changed. Read the current Finish before approving.'
    const section = this.sections(draft.sessionId).find((entry) => entry.workflowId === request.workflowId)
    if (!section?.open || !section.actions.some((action) => action.id === request.actionId && action.requiresCommit)
      || !section.rounds.some((round) => round.steps.some((step) => step.state === 'waits' && step.body?.kind === 'commit'
        && step.body.vcs === draft.vcs && PathCompare.comparable(step.body.scopeRoot) === PathCompare.comparable(draft.scopeRoot))))
      return 'This review no longer belongs to the waiting Finish. Read Session actions again.'
    return null
  }

  async start(draft: VersioningCommitDraftDto, request: RemoteWorkflowReview, selection: string[], reviewed: Record<string, string>): Promise<VersioningCommitRunResult> {
    const refused = this.check(draft, request)
    if (refused) return { ok: false, code: 'stale', detail: refused }
    if (request.repositories !== undefined && request.repositories.some((row) => {
      const stored = (draft.repositories ?? this.repositories(draft))?.find((candidate) => PathCompare.comparable(candidate.root) === PathCompare.comparable(row.root))
      return stored === undefined || stored.message !== row.message || stored.source !== row.source
    })) return { ok: false, code: 'stale', detail: 'Repository messages changed. Read the source review again.' }
    const answer = await this.sessions.finishWorktreeSession(draft.sessionId, {
      choice: 'commit', requestedBy: 'window', selection, ...(request.repositories === undefined ? {} : { repositories: request.repositories }), message: draft.message, messageSource: draft.messageSource ?? 'unknown', acknowledgedFindings: request.acknowledgedFindings, reviewed, ...request.agreement,
      ...request.reviewVersion === undefined ? {} : { reviewVersion: request.reviewVersion },
    })
    return answer.ok ? { ok: true, revision: '' } : { ok: false, code: 'vcs-failed', detail: answer.detail,
      ...(answer.setup ? { setup: answer.setup } : {}), ...(answer.code === 'session-working' ? { working: true } : {}) }
  }

  state(draft: VersioningCommitDraftDto): VersioningWorkflowState {
    const binding = draft.workflow
    if (!binding) throw new Error('A workflow review requires its source binding')
    const session = this.sessions.snapshot().sessions.find((entry) => entry.sessionId === draft.sessionId)
    const section = this.sections(draft.sessionId).find((entry) => entry.workflowId === binding.workflowId)
    const saved = this.results?.list({ sessionId: draft.sessionId }).find((entry) => entry.actionId === binding.workflowId
      && entry.at >= binding.acceptedAt && PathCompare.isInside(entry.worktreePath, draft.scopeRoot))
    const outcome = WorktreeOutcomes.of(session, section, binding.acceptedAt, saved)
    // A press such as Review corrective changes closes the Finish without a result and opens the next
    // one; the worktree keeps what the first published, so its approval can no longer be in flight.
    if (outcome.kind === 'uncertain' && section?.open !== true && this.sections(draft.sessionId).some((entry) => entry.open
      && entry.kind === 'finish' && entry.workflowId !== binding.workflowId))
      return { kind: 'replaced', detail: 'A later Finish of this worktree replaced this approval. What it published stays with the worktree; review the current Finish.' }
    return outcome
  }

  changed(paths: readonly string[]): string {
    return WorktreeWords.reviewChanged(paths)
  }

  private commitBodies(draft: VersioningCommitDraftDto): Extract<SessionWorkflowBody, { kind: 'commit' }>[] {
    return this.sections(draft.sessionId).flatMap((section) => section.rounds.flatMap((round) => round.steps))
      .flatMap((step) => step.body?.kind === 'commit' && PathCompare.comparable(step.body.scopeRoot) === PathCompare.comparable(draft.scopeRoot) ? [step.body] : [])
  }

  private sections(sessionId: string): readonly SessionWorkflowInfo[] {
    const session = this.sessions.snapshot().sessions.find((entry) => entry.sessionId === sessionId)
    return session?.actions?.sections ?? (session?.workflow ? [session.workflow] : [])
  }
}
