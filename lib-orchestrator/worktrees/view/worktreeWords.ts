import type { SessionSvnActionInfo, SessionInfo, SessionWorkflowAction, SessionWorkflowCommand, WorktreeView, WorktreeQuestionView } from '../../sessionManager/sessionManagerApi.types'
import type { FinishStep, WorktreeLifecycle, WorktreeWaitKind } from '../worktreeState'
import { WorktreeTransitions } from '../worktreeTransitions'
import { WorktreePublication } from '../worktreePublication'
import { SvnConflictFlow } from '../conflicts/svnConflictFlow'
import { SvnConflictWords } from '../conflicts/svnConflictWords'
import { SvnMergerLauncher } from '../conflicts/svnMergerLauncher'
import { ConflictStep } from '../finish/conflictStep'
import type { SvnLabelledRevision } from '../worktreeContracts'
import { SvnRevisionLabels } from '../finish/svnRevisionLabels'
import { SvnActionStages } from '../finish/svnActionStages'

export class WorktreeWords {
  /** The label of the press that goes on from a wait without its own; a reason asking for it names this. */
  static readonly tryAgainConst = 'Try again'
  static readonly recheckConst = 'Recheck local changes'
  static readonly prepareAgainConst = 'Update and prepare again'
  private static readonly syncBusyConst = 'Waiting for an idle worker: '
  // The work-state monitor counts a worker idle only after 15 s without working output, read every 2 s
  // while the window is visible and every 15 s while it is not.
  private static readonly idleDelayConst = 'Jamat continues by itself about 15 to 30 seconds after the worker stops'
  private static readonly syncBusyAfterConst = `. ${WorktreeWords.idleDelayConst}; press Sync now if it has already finished.`

  /** The reason of a `worker-busy` wait; the Finish goes on by itself once the worker is idle (UA1-J14-4). */
  static syncBusyOf(busy: string): string {
    return `${WorktreeWords.syncBusyConst}${busy}${WorktreeWords.syncBusyAfterConst}`
  }

  /** What holds the worker, read back from a `worker-busy` reason; null for a reason this build did not compose. */
  private static busyOf(reason: string): string | null {
    return reason.startsWith(WorktreeWords.syncBusyConst) && reason.endsWith(WorktreeWords.syncBusyAfterConst)
      ? reason.slice(WorktreeWords.syncBusyConst.length, -WorktreeWords.syncBusyAfterConst.length) : null
  }

  /** Why a review whose publication found incoming repository changes waits for a new update. */
  static incomingWaits(paths: readonly string[]): string {
    return `Repository changes are not in this worktree yet: ${paths.slice(0, 20).join(', ')}${paths.length > 20 ? ', …' : ''}. Press ${WorktreeWords.prepareAgainConst} before publication.`
  }

  /** A review whose files changed after the person read them; the press that prepares them again. */
  static reviewChanged(paths: readonly string[]): string {
    return `Changed since this review was read: ${paths.slice(0, 20).join(', ')}${paths.length > 20 ? ', …' : ''}. Press ${WorktreeWords.recheckConst}, then review the changes again.`
  }

  /** The publication gate refused the worktree at preparation: what it named, one line each, and how to go on. */
  static refusedOf(problems: string): string {
    return `${problems.split('\n').join('; ')}. Delete leftover svn conflict files, remove conflict markers and settle conflicted paths in the worktree, then press ${WorktreeWords.recheckConst}.`
  }

  static outcome(session: SessionInfo | undefined, section: import('../../sessionManager/sessionManagerApi.types').SessionWorkflowInfo | undefined,
    acceptedAt: number, saved?: { result: string; revisions: readonly { repository: string; revision: number }[]; lines: readonly string[] }):
    { kind: 'waiting' | 'uncertain'; detail: string } | { kind: 'running' } | { kind: 'done'; revision: string; output: string } {
    if (section?.open) {
      if (section.rounds.some((round) => round.steps.some((step) => step.state === 'waits' || step.state === 'failed'))
        && !section.rounds.some((round) => round.steps.some((step) => step.state === 'running')))
        return { kind: 'waiting', detail: section.summary }
      return { kind: 'running' }
    }
    const outcome = session?.worktree?.outcome
    if (outcome && outcome.at >= acceptedAt) {
      if (outcome.result === 'committed' || outcome.result === 'nothing')
        return { kind: 'done', revision: outcome.revisions.join(', '), output: outcome.lines.join('\n') }
      return { kind: 'waiting', detail: outcome.lines.join('\n') || outcome.result }
    }
    if (section && !section.open && session?.retiredWorktree)
      return { kind: 'done', revision: session.retiredWorktree.revisions.join(', '), output: section.summary }
    if (section && !section.open && section.kind === 'git-finish' && section.revisions?.length)
      return { kind: 'done', revision: section.revisions.join(', '), output: section.summary }
    if (saved) {
      if (saved.result === 'committed' || saved.result === 'nothing' || saved.result === 'never-started' || saved.result === 'discarded')
        return { kind: 'done', revision: saved.revisions.map((entry) => `${entry.repository}:r${entry.revision}`).join(', '), output: saved.lines.join('\n') }
      return { kind: 'waiting', detail: saved.lines.join('\n') || saved.result }
    }
    return { kind: 'uncertain', detail: 'The original Finish outcome is not available. Verify its source result before another approval.' }
  }

  static legacyActionTitle(action: SessionSvnActionInfo): string {
    const stage = action.stage
    if (action.kind === 'update-main') {
      if (stage === 'updating') return 'Updating the main copy'
      else if (stage === 'resolving') return 'Claude resolves the conflicts of the main-copy update'
      else if (stage === 'verifying') return 'Checking the files the conflict resolver edited in the main copy'
      else if (stage === 'diffing') return 'Showing the merge of the resolved files'
      else if (stage === 'recording') return 'Reading whether the main copy holds the landed revisions'
    }
    if (stage === 'committing') return 'Committing the selected files'
    else if (stage === 'changes') return 'Review the changes in Session actions'
    else if (stage === 'main-update') return 'Update the main copy from Session actions'
    else if (stage === 'stopping') return 'Stopping the session before its Finish'
    else if (stage === 'evidence') return 'Reading what the worktree committed'
    else if (stage === 'checks') return "Running the project's checks"
    else if (stage === 'updating') return 'Updating the worktree to HEAD before the review'
    else if (stage === 'cleaning') return 'Running svn cleanup in the worktree'
    else if (stage === 'resolving') return 'Claude resolves the conflicts of the update'
    else if (stage === 'merging') return 'The merger settles the conflicts the rules left'
    else if (stage === 'verifying') return 'Checking the files the conflict resolver edited'
    else if (stage === 'fixing') return 'Checking the conflicts after Check again'
    else if (stage === 'diffing') return 'Showing the merge of the resolved files'
    else if (stage === 'reviewing')
      return action.review === null
        ? 'Waiting for the commit review'
        : `Waiting for the commit review ${action.review.index} of ${action.review.count}: ${action.review.scopeRoot}`
    else if (stage === 'removing') return 'Removing the worktree'
    else if (stage === 'recording') return 'Writing how the Finish ended'
    else
      throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
  }

  static wait(kind: WorktreeWaitKind): { title: string; tone: 'wait' | 'error' } {
    switch (kind) {
      case 'review': case 'waiting-for-review': return { title: 'Ready for validation', tone: 'wait' }
      case 'conflict-person': return { title: 'Conflicts need your decision', tone: 'wait' }
      case 'checks-failed': return { title: 'Checks failed', tone: 'error' }
      case 'repository-busy': return { title: 'Repository keeps changing', tone: 'wait' }
      case 'published-with-differences': return { title: 'Published with differences', tone: 'error' }
      case 'worker-lost': return { title: 'Worker needs to be resumed', tone: 'error' }
      case 'changed-outside': return { title: 'Worktree changed outside Finish', tone: 'wait' }
      case 'removal-blocked': return { title: 'Worktree removal is blocked', tone: 'wait' }
      // Written when the Host lost a run of the Finish, or cannot account for its children.
      case 'host-unhealthy': return { title: 'Processes may still run', tone: 'error' }
      case 'svn-failed': return { title: 'SVN step failed', tone: 'error' }
      case 'locked': return { title: 'Working copy is locked', tone: 'wait' }
      case 'auth': return { title: 'SVN sign-in needed', tone: 'error' }
      case 'pinned-external': return { title: 'A selected external is pinned', tone: 'wait' }
      case 'partially-landed': return { title: 'Some repositories were published', tone: 'wait' }
      case 'never-started': return { title: 'The worker never started', tone: 'error' }
      case 'worker-busy': return { title: 'The worker is not idle', tone: 'wait' }
      default: throw new Error(`Unknown worktree wait: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  static step(step: FinishStep | undefined): string {
    switch (step) {
      case undefined: return 'Worktree'
      case 'syncing': return 'Updating the worktree to HEAD before the review'
      case 'worker-resolving': return 'The worker is resolving conflicts'
      case 'checking': return "Running the project's checks"
      case 'reviewing': return 'Ready for validation'
      case 'awaiting-idle': return 'Waiting for the worker to become idle'
      case 'committing': return 'Committing the approved files'
      case 'verifying': return 'Verifying the published files'
      case 'disposing': return 'Preserving and reverting setup and check changes'
      case 'stopping-worker': return 'Stopping the worker after verification'
      case 'removing': return 'Removing the worktree'
      case 'recording': return 'Recording the Finish result'
      default: throw new Error(`Unknown Finish step: ${JSON.stringify(step satisfies never)}`)
    }
  }

  static presentation(state: WorktreeLifecycle): Pick<WorktreeView, 'title' | 'tone' | 'actions'> {
    if (state.unreadable !== undefined) return { title: 'Saved worktree state requires a compatible client; inspect the preserved record before recovery', tone: 'error',
      actions: [{ id: 'open-in-vscode', label: 'Inspect preserved worktree', primary: false }] }
    const published = (WorktreePublication.retain(state).publication?.revisions.length ?? 0) > 0
    if (state.wait?.kind === 'removal-blocked' && published)
      return { title: 'Changes published; worktree removal is blocked', tone: 'wait', actions: WorktreeWords.actions(state) }
    const row = state.environment?.pending ? { title: 'Refresh the worktree environment', tone: 'wait' as const }
      : state.step === 'reviewing' && state.knownIncoming !== undefined ? { title: `${WorktreeWords.prepareAgainConst} for incoming changes`, tone: 'wait' as const }
      // A preparation that found nothing to publish leaves none; its review follows in the same drive.
      : state.step === 'reviewing' && state.preparation?.checkedAt === undefined && (state.wait !== undefined || state.preparation !== undefined)
        ? { title: 'Preparation needs to run again', tone: 'wait' as const }
      : state.step === 'reviewing' && state.wait === undefined
      ? WorktreeWords.reviewReady(state) ? WorktreeWords.wait('review') : { title: 'Preparing the synced review', tone: 'running' as const }
      : state.wait === undefined ? { title: SvnActionStages.installOf(state.execution ?? {}) === null ? WorktreeWords.step(state.step)
        : 'Installing dependencies for changed inputs', tone: 'running' as const }
      : state.wait.kind === 'conflict-person' && state.syncConflictSet !== undefined && !SvnConflictFlow.unsettled(state.syncConflictSet)
        ? { title: 'Conflicts settled', tone: 'wait' as const } : WorktreeWords.wait(state.wait.kind)
    switch (state.phase) {
      case 'active': return { title: 'Worktree active', tone: 'running', actions: [] }
      case 'kept': {
        const conflicts = (state.syncConflictSet?.entries.filter((entry) => entry.state !== 'settled').length ?? state.conflictMemory?.paths.length ?? 0) + (state.syncConflictSet?.more ?? 0)
        return { title: conflicts === 0 ? 'Worktree kept' : `Worktree kept with ${conflicts} conflict${conflicts === 1 ? '' : 's'}`, tone: 'done', actions: WorktreeWords.actions(state) }
      }
      case 'removed': return { title: state.execution?.neverStartedReason === undefined ? 'Worktree removed' : 'Never started; nothing to land', tone: 'done', actions: [] }
      case 'landed': return { title: state.execution?.evidence.length === 0 && !published ? 'Nothing to land' : 'Changes published', tone: 'done', actions: [] }
      case 'waiting': case 'finishing': return { ...row, actions: WorktreeWords.actions(state) }
      default: throw new Error(`Unknown worktree phase: ${JSON.stringify(state.phase satisfies never)}`)
    }
  }

  /**
   * What holds the step at the idle gate: publication, or the sync after the worker settled the
   * conflicts Jamat handed it. Null before the first look and for every other step.
   */
  static idleWaitOf(state: WorktreeLifecycle): string | null {
    if (state.awaitingIdleReason === undefined) return null
    if (state.step === 'awaiting-idle')
      return `The worker is not idle: ${state.awaitingIdleReason}. ${WorktreeWords.idleDelayConst}; press Publish anyway if it has already finished.`
    if (state.step === 'syncing' && state.wait === undefined)
      return `The worker is ending its turn on the conflicts Jamat handed it: ${state.awaitingIdleReason}. ${WorktreeWords.idleDelayConst}; press Sync now if it has already finished.`
    return null
  }

  static reviewReady(state: WorktreeLifecycle): boolean {
    return state.review !== undefined && (state.hasWindow === true || state.wait?.kind === 'waiting-for-review' || state.wait?.kind === 'review')
  }

  /**
   * A lost worker's wait leads with Resume worker, the press its reason names, and always keeps Keep
   * and Discard, which the reason names too. Its wait offered no resume, and Back to work left the
   * worker dead (UA1-J14R-3).
   */
  static actions(state: WorktreeLifecycle): SessionWorkflowAction[] {
    const actions = WorktreeWords.stepActions(state)
    if (state.unreadable !== undefined || state.wait?.kind !== 'worker-lost') return actions
    const decisions = WorktreeWords.decisions(state).filter((decision) => !actions.some((action) => action.id === decision.id))
    return [{ id: 'resume-worker', label: 'Resume worker', primary: true, place: 'step' },
      ...actions.map((action) => ({ ...action, primary: false })), ...decisions]
  }

  private static decisions(state: WorktreeLifecycle): SessionWorkflowAction[] {
    const publication = WorktreePublication.retain(state).publication
    return [{ id: 'keep', label: 'Keep worktree', primary: false }, { id: 'discard', label: 'Discard', primary: false,
      confirm: WorktreeWords.discardConfirm(publication?.revisions ?? [], publication?.remaining?.length, WorktreePublication.uncertain(state),
        WorktreePublication.mountsOf(state)) }]
  }

  private static stepActions(state: WorktreeLifecycle): SessionWorkflowAction[] {
    if (state.unreadable !== undefined) return []
    const [keep, discard] = WorktreeWords.decisions(state)
    const back: SessionWorkflowAction[] = WorktreeTransitions.beforeCommit(state) ? [{ id: 'back-to-work', label: 'Back to work', primary: false }, ...WorktreeWords.confirmStopped(state)] : []
    const helper = state.wait !== undefined && !(state.wait.kind === 'conflict-person' && state.step === 'worker-resolving'
      && (state.syncConflictSet?.entries ?? []).some(SvnMergerLauncher.forAgent))
    const alternate: SessionWorkflowAction[] = [...(state.verified?.length ?? 0) > 0 ? [{ id: 'update-main' as const, label: 'Update main copy', primary: false, confirmLive: [] }] : [],
      ...back, ...helper ? [{ id: 'solve-with-agent' as const, label: 'Solve with agent', primary: false }] : [],
      { id: 'open-in-vscode', label: 'Open in VS Code', primary: false }, keep, discard]
    // A new preparation updates the worktree first, so Discard of a kept one does not wait behind it.
    if (state.phase === 'kept') return [...state.execution?.neverStartedReason === undefined
      ? [{ id: 'prepare-worktree' as const, label: WorktreeWords.prepareAgainConst, primary: true }] : [], discard]
    if (state.phase === 'waiting' && state.step === undefined) return [
      { id: 'open-in-vscode', label: 'Inspect worktree', primary: false }, keep, discard]
    if (state.stoppedFailure !== undefined) return [{ id: 'finish-again', label: 'Try again after repair', primary: true, place: 'step' }, ...alternate]
    if (state.environment?.pending) return [
      { id: 'confirm-environment', label: state.environment.checksPolicy === undefined ? 'Environment is ready' : 'Confirm validation configuration', primary: true, place: 'step',
        confirm: state.environment.checksPolicy === undefined ? 'Does the worktree environment match the listed dependency inputs? If a dependency changed, install it first. Automated checks run next.'
          : 'Checks changed in the worktree. Continue using the main working copy checks? The new worktree checks will not run. Confirm that dependencies and the environment are also ready.' },
      { id: 'refresh-preparation', label: 'Read inputs again', primary: false }, ...alternate]
    if (state.step === 'worker-resolving') {
      const merger = state.execution?.merger
      const resolve: SessionWorkflowAction[] = state.wait !== undefined && (merger === undefined || merger.endedAt !== undefined)
        && (state.syncConflictSet?.entries ?? []).some(SvnMergerLauncher.forAgent) ? [{ id: 'resolve-with-agent', label: 'Resolve with agent', primary: false, place: 'step' }] : []
      return [{ id: 'finish-again', label: SvnConflictWords.checkAgainConst, primary: true, place: 'step' }, ...resolve,
        ...(merger === undefined ? [] : [{ id: 'open-merger' as const, label: 'Open merger', primary: false, runId: merger.runId },
          ...merger.endedAt === undefined ? [{ id: 'stop-agent' as const, label: 'Stop agent', primary: false, runId: merger.runId }] : []]), ...alternate]
    }
    if (state.step === 'reviewing') return [...WorktreeWords.reviewReady(state) && state.preparation?.checkedAt !== undefined && state.knownIncoming === undefined
      ? [{ id: 'finish-again' as const, label: state.review?.selection.length === 0 ? 'Complete without commit' : 'Publish verified changes',
        primary: true, place: 'step' as const, requiresCommit: true as const }] : [],
      { id: 'refresh-preparation', label: WorktreeWords.recheckConst, primary: false, place: 'step', note: 'Only after you edit files in the worktree' },
      { id: 'prepare-worktree', label: WorktreeWords.prepareAgainConst, primary: state.knownIncoming !== undefined, place: 'step',
        ...state.knownIncoming === undefined ? { note: 'Only to take newer repository changes first' } : {} }, ...back, keep, discard]
    if (state.step === 'checking' && state.execution?.runId !== undefined && state.execution.verdict === undefined)
      return [{ id: 'back-to-work', label: 'Stop checks and return to work', primary: false, place: 'step' }, ...WorktreeWords.confirmStopped(state)]
    if (state.wait?.kind === 'published-with-differences') return [{ id: 'finish-again', label: 'Verify again', primary: true },
      { id: 'review-correction', label: 'Review corrective changes', primary: false, confirm: 'Sync and review a corrective publication while retaining the original revision?' }, ...alternate]
    if (state.wait?.kind === 'checks-failed') return [{ id: 'finish-again', label: 'Retry checks', primary: true, place: 'step' },
      { id: 'override-checks', label: 'Accept failed checks', primary: false, overrideChecks: true, confirm: 'Continue despite the failed checks?' }, ...alternate]
    if (state.wait?.kind === 'worker-busy') return [{ id: 'finish-again', label: 'Sync now', primary: true, place: 'step', confirmWorking: true,
      confirm: `Sync although ${WorktreeWords.busyOf(state.wait.reason) ?? 'the worker is not idle'}?` },
      ...alternate]
    if (state.wait !== undefined) return [{ id: 'finish-again', label: state.wait.reason.includes('.writer') ? 'Check and release SVN writer'
      : state.wait.kind === 'partially-landed' ? 'Continue remaining repositories' : WorktreeWords.tryAgainConst, primary: true, place: 'step' }, ...alternate]
    if (state.step === 'syncing' && state.awaitingIdleReason !== undefined) return [{ id: 'finish-again', label: 'Sync now', primary: false, place: 'step',
      confirmWorking: true, confirm: `Sync although ${state.awaitingIdleReason}?` }, ...alternate]
    if (state.step === 'awaiting-idle') return [{ id: 'finish-again', label: 'Check worker idle', primary: true, place: 'step' },
      { id: 'confirm-busy', label: 'Publish anyway', primary: false, place: 'step',
        confirm: `Publish although ${state.awaitingIdleReason ?? 'the worker is not idle'}? Jamat holds input to the worker and checks the reviewed files again before the commit.` },
      ...back, keep, discard]
    if (state.phase === 'finishing' && state.execution === undefined)
      return [{ id: 'finish-again', label: 'Inspect and resume saved operation', primary: true, place: 'step' }, ...alternate]
    return []
  }

  /**
   * Discard cannot take back what a partial publication already committed: the confirm names those
   * revisions and says the rest goes with the worktree. `remaining` is unknown until a press measured it.
   * `uncertain` names the revisions an interrupted commit may have landed as, none of them proven ours.
   * `mounts` names the mount of a repository whose name another one of the worktree has, as the result does.
   */
  static discardConfirm(published: readonly SvnLabelledRevision[], remaining: number | undefined, uncertain: readonly string[],
    mounts?: ReadonlyMap<string, string>): string {
    const warning = uncertain.length === 0 ? ''
      : `An interrupted commit may have landed: ${uncertain.join('; ')}. Jamat could not prove which one is ours; inspect them first. `
    return `${warning}${WorktreeWords.discardQuestion(published, remaining, mounts)}`
  }

  private static discardQuestion(published: readonly SvnLabelledRevision[], remaining: number | undefined,
    mounts: ReadonlyMap<string, string> | undefined): string {
    if (published.length === 0) return 'Discard this worktree and its uncommitted changes?'
    const revisions = published.map((entry) => SvnRevisionLabels.nameOf(entry, mounts)).join(', ')
    const rest = remaining === undefined ? 'The rest is' : `${remaining} changed path${remaining === 1 ? ' is' : 's are'}`
    return `Already published: ${revisions}. ${rest} not published and will be discarded with this worktree. Discard it?`
  }

  /** Offered only for an ended or lost run whose stop Jamat could not prove; the confirm names the press it goes on with. */
  private static confirmStopped(state: WorktreeLifecycle): SessionWorkflowAction[] {
    const runId = state.execution?.runId
    if (runId === undefined || state.execution?.stopRefusedRunId !== runId) return []
    const press = state.execution.stopRefusedPress ?? 'back-to-work'
    let then: string
    switch (press) {
      case 'back-to-work': then = 'Return to work?'; break
      case 'keep': then = 'Then keep the worktree?'; break
      case 'discard': then = 'Then discard the worktree?'; break
      case 'commit': then = `Then ${WorktreeWords.tryAgainConst.toLowerCase()}?`; break
      default: throw new Error(`Unknown stop press: ${JSON.stringify(press satisfies never)}`)
    }
    return [{ id: 'confirm-stopped', label: ConflictStep.confirmStoppedConst, primary: false, runId,
      confirm: `Confirm that this run and all its child processes have stopped. ${then}` }]
  }

  static command(action: SessionWorkflowAction): SessionWorkflowCommand | undefined {
    switch (action.id) {
      case 'refresh-preparation': return { operation: 'sessions.finishWorktree', body: { choice: 'commit', refreshPreparation: true } }
      case 'confirm-environment': return { operation: 'sessions.finishWorktree', body: { choice: 'commit', confirmEnvironment: true } }
      case 'later': case 'open-in-vscode': case 'open-merger': return undefined
      case 'agree-setup': case 'retry-setup': return { operation: 'sessions.retrySetup', body: action.acknowledgeSetup === undefined ? {} : { acknowledgeSetup: action.acknowledgeSetup } }
      case 'cancel-setup': return { operation: 'sessions.discardWorktree', body: {} }
      case 'keep': case 'discard': return { operation: 'sessions.finishWorktree', body: { choice: action.id } }
      case 'prepare-worktree': return { operation: 'sessions.finishWorktree', body: { choice: 'commit' } }
      case 'review-correction': return { operation: 'sessions.finishWorktree', body: { choice: 'commit', reviewCorrection: true } }
      case 'override-checks': return { operation: 'sessions.finishWorktree', body: { choice: 'commit', overrideChecks: true } }
      case 'finish-again': return { operation: 'sessions.finishWorktree', body: { choice: 'commit', ...(action.overrideChecks ? { overrideChecks: true } : {}),
        ...(action.confirmWorking ? { confirmWorking: true } : {}) } }
      case 'confirm-busy': return { operation: 'sessions.finishWorktree', body: { choice: 'commit', confirmWorking: true } }
      case 'back-to-work': return { operation: 'sessions.backToWork', body: {} }
      case 'confirm-stopped': return { operation: 'sessions.backToWork', body: { confirmStoppedRunId: action.runId } }
      case 'resolve-with-agent': return { operation: 'sessions.finishWorktree', body: { choice: 'commit', agent: true } }
      case 'update-main': return { operation: 'sessions.updateMain', body: { confirmLive: action.confirmLive } }
      case 'solve-with-agent': return { operation: 'sessions.solveWithAgent', body: {} }
      case 'resume-worker': return { operation: 'sessions.reopen', body: {} }
      case 'stop-agent': case 'stop-run': return action.runId === undefined ? undefined : { operation: 'sessions.finalize', sessionId: action.runId, body: { expect: 'stop' } }
      case 'remove-run': return action.runId === undefined ? undefined : { operation: 'sessions.remove', sessionId: action.runId, body: {} }
      default: throw new Error(`Unknown workflow action: ${JSON.stringify(action.id satisfies never)}`)
    }
  }

  static decorate(info: SessionInfo): void {
    for (const section of [...info.actions?.sections ?? [], ...info.workflow === undefined ? [] : [info.workflow]]) {
      section.actions = section.actions.map((action) => ({ ...action, command: WorktreeWords.command(action) }))
      if (section.validation?.runs !== undefined)
        section.validation = { ...section.validation, runs: section.validation.runs.map((run) => ({ ...run, stop: { ...run.stop, command: WorktreeWords.command(run.stop) } })) }
    }
    if (info.svnAction !== undefined) {
      const action = info.svnAction
      action.title = action.kind === 'update-main' ? action.needs ?? WorktreeWords.legacyActionTitle(action) : info.worktreeView?.title ?? WorktreeWords.legacyActionTitle(action)
      if (action.kind === 'update-main' && info.worktreeView !== undefined)
        info.worktreeView = { ...info.worktreeView, title: action.title, tone: action.needs === null ? 'running' : 'wait' }
    }
    if (info.worktree !== undefined) info.worktree.questions = { local: WorktreeWords.question(info, true), remote: WorktreeWords.question(info, false) }
  }

  private static startsWorkflow(kind: 'svn' | 'git'): NonNullable<WorktreeQuestionView['startsWorkflow']> {
    switch (kind) {
      case 'svn': return ['commit', 'discard']
      case 'git': return ['merge']
      default: throw new Error(`Unknown worktree kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  static question(session: SessionInfo, local: boolean): WorktreeQuestionView | null {
    const worktree = session.worktree
    if (worktree === undefined || session.life !== 'ended' && session.life !== 'lost' && !(local && worktree.liveFinish === true)) return null
    if (session.svnAction !== undefined && (session.svnAction.needs === null || local)) return null
    const choices: WorktreeQuestionView['choices'] = []
    for (const choice of worktree.choices) {
      switch (choice) {
        case 'commit': if (session.admits.includes('finalize')) choices.push({ id: choice, title: 'Prepare for completion', note: 'updates the worktree and externals, resolves conflicts and runs checks; then waits while you run the app, review and confirm publication', glyph: '✓', submitLabel: 'Prepare' }); break
        case 'merge': if (session.admits.includes('finalize')) choices.push({ id: choice, title: 'Merge back', note: `reviews the worktree changes, then merges into ${worktree.branch}'s base and removes the worktree`, glyph: '⇤', submitLabel: 'Merge' }); break
        case 'keep': choices.push(worktree.cleanup?.phase === 'pending' ? { id: choice, title: 'Remove automatically', note: worktree.cleanup.summary, glyph: '↻', submitLabel: null }
          : { id: choice, title: 'Keep worktree', note: 'decide later; the row keeps Finish…', glyph: '—', submitLabel: null }); break
        case 'discard': if (local && (session.admits.includes('discardWorktree') || worktree.liveFinish === true)) choices.push({ id: choice, title: 'Discard worktree', note: WorktreeWords.discardNote(worktree.kind), glyph: '✕', submitLabel: 'Discard worktree', danger: true }); break
        default: throw new Error(`Unknown Finish choice: ${JSON.stringify(choice satisfies never)}`)
      }
    }
    if (!choices.some((choice) => choice.submitLabel !== null)) return null
    return { label: 'Worktree', choices, chosenDefault: choices.find((choice) => choice.id === 'commit' || choice.id === 'merge')?.id ?? 'keep',
      ...(local ? { startsWorkflow: WorktreeWords.startsWorkflow(worktree.kind) } : {}) }
  }

  private static discardNote(kind: 'svn' | 'git'): string {
    switch (kind) {
      case 'svn': return 'saves a copy of the changes and removes the worktree'
      case 'git': return 'throws the branch, the directory and its unmeasured changes away'
      default: throw new Error(`Unknown worktree kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }
}
