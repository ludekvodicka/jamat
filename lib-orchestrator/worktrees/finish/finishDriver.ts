import { FinishStepPolicy } from './finishStepPolicy'
import { FinalizeSteps } from './finalizeSteps'
import { FinishFlow } from './finishFlow'
import { SyncExecution } from './syncExecution'
import { FinishState } from './finishState'
import { CheckExecution } from './checkExecution'
import { ReviewStep } from './reviewStep'
import { FinishCompletion } from './finishCompletion'
import { PublicationStep } from './publicationStep'
import { ConflictStep } from './conflictStep'
import { PreparationStep } from './preparationStep'
import type { FinishDriverDeps } from './finishDriver.types'
export type { FinishDriverDeps, FinishDriverPorts } from './finishDriver.types'
import { relative, resolve } from 'node:path'
import { SessionWorkflows } from '../../sessionManager/worktreeSessionRuntime'
import { SvnWaitHelper } from '../conflicts/svnWaitHelper'
import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import { SvnCommitMessageCheck } from '../../svn/svnCommitMessageCheck'
import { SvnWorktreeEvidence } from '../../svn/svnWorktreeEvidence'
import type { SessionRecord, SessionRecordCommitReceipt, SvnActionVerdict } from '../../sessionManager/worktreeSessionRecords'
import type { SessionCreateSpec, SessionFinishPress, SessionsOpResult, SvnFinishWorktreeResult } from '../../sessionManager/sessionManagerApi.types'
import { SvnConflictFlow } from '../conflicts/svnConflictFlow'
import { SvnConflictWords } from '../conflicts/svnConflictWords'
import { SvnWorktreeRemoval } from '../removal/svnWorktreeRemoval'
import { WorktreeLifecycleMigration } from '../worktreeLifecycleMigration'
import { WorktreeRecovery } from '../worktreeRecovery'
import type { WorktreeLifecycle, SvnStepJournalEntry, WorktreeEvent } from '../worktreeState'
import type { WorktreeStopPress } from '../worktreeExecution'
import { WorktreeTransitions } from '../worktreeTransitions'
import { WorktreePublication } from '../worktreePublication'
import { ChecksStep } from './checksStep'
import { CommitStep } from './commitStep'
import { ReviewCandidates } from './reviewCandidates'
import { VerifyStep } from './verifyStep'
import { DispositionStep } from './dispositionStep'
import { FinishProjection } from './finishProjection'
import { SvnRevisionLabels } from './svnRevisionLabels'
import type { MainCopyUpdate } from '../landing/mainCopyUpdate'
import { LandedRows } from '../landing/landedRows'

export class FinishDriver {
  static readonly stopLimitMillisecondsConst = 60_000
  private readonly deps: FinishDriverDeps
  private readonly reviews: ReviewCandidates
  private readonly checks: ChecksStep
  private readonly commit: CommitStep
  private readonly verify: VerifyStep
  private readonly dispositions: DispositionStep
  private readonly conflicts: SvnConflictFlow
  private readonly flow: FinishFlow
  private readonly syncExecution: SyncExecution
  private readonly state: FinishState
  private readonly checkExecution: CheckExecution
  private readonly reviewStep: ReviewStep
  private readonly completion: FinishCompletion
  private readonly publication: PublicationStep
  private readonly conflictStep: ConflictStep
  private readonly preparation: PreparationStep
  private readonly driving = new Map<string, Promise<void>>()

  constructor(deps: FinishDriverDeps) {
    this.deps = deps
    this.reviews = new ReviewCandidates(deps)
    this.checks = new ChecksStep(deps.records, deps.handoffs)
    this.commit = new CommitStep(deps)
    this.verify = new VerifyStep(deps.records, deps.svn)
    this.dispositions = new DispositionStep(deps.records, deps.svn)
    this.conflicts = new SvnConflictFlow({ svn: deps.svn, briefs: deps.resolver.briefs, handover: deps.results,
      resolutions: deps.resolutions, savedDirectoryOf: (id) => deps.results.savedDirectoryOf(id),
      withMarkers: deps.resolver.withMarkers, unavailable: deps.resolver.unavailable, cli: deps.resolver.cli, now: deps.now })
    this.state = new FinishState(deps)
    this.preparation = new PreparationStep(deps, this.state)
    this.checkExecution = new CheckExecution(deps, this.state, this.checks, this.preparation)
    this.reviewStep = new ReviewStep(deps, this.state, this.reviews)
    this.completion = new FinishCompletion(deps, this.state, (record) => this.conflictStep.stopHelper(record))
    this.publication = new PublicationStep(deps, this.state, this.completion, this.commit, this.verify, (id, entry) => this.recoverCommit(id, entry), this.preparation)
    this.conflictStep = new ConflictStep(deps, this.state, this.conflicts)
    this.syncExecution = new SyncExecution(deps, this.state)
    this.flow = new FinishFlow((id) => deps.records.get(id)?.worktreeLifecycle, {
      syncing: (id, state) => this.syncExecution.run(id, state),
      'worker-resolving': (id, state) => this.conflictStep.run(id, state),
      checking: (id) => this.checkExecution.runChecks(id),
      reviewing: (id, state) => this.reviewStep.run(id, state),
      'awaiting-idle': (id) => this.publication.publish(id),
      committing: (id) => this.publication.publish(id),
      verifying: (id) => this.publication.verifyCurrent(id),
      disposing: async (id, state) => {
        if ((state.verified?.length ?? 0) === 0 && state.preparation?.checkedAt === undefined) {
          await this.preparation.invalidate(id, 'This older completion has no verified assembly. Prepare and confirm it before cleanup.')
          return false
        }
        await this.dispositions.run(id, deps.results.savedDirectoryOf(state.actionId!))
        await deps.liveness(id, 'disposing')
        return true
      },
      'stopping-worker': (id) => this.completion.stop(id),
      removing: async (id) => { await this.completion.remove(id); return true },
      recording: async (id) => {
        await this.completion.recordResult(id)
        this.updateAfterLanding(id)
        return false
      },
    }, async (id, state) => {
      if (state.execution?.pendingLog !== undefined) await this.state.keepAttempt(id, state.execution.pendingLog)
    })
  }

  async start(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ actionId: string | null }>> {
    return this.deps.sync.withControl(sessionId, () => this.startCurrent(sessionId, press))
  }

  private async startCurrent(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ actionId: string | null }>> {
    const initial = this.deps.records.get(sessionId)
    if (initial?.worktreeLifecycle?.unreadable !== undefined)
      return { ok: false, code: 'invalid-spec', detail: initial.worktreeLifecycle.unreadable }
    if (initial?.worktree?.kind !== 'svn') return { ok: false, code: 'invalid-spec', detail: 'Finish requires an SVN worktree' }
    await this.deps.commands.lease.checkAndRelease(initial.worktree.worktreePath)
    const result = await this.deps.commands.lease.within(initial.worktree.worktreePath, 'finish', async (): Promise<SessionsOpResult<{ actionId: string | null }>> => {
      let record = this.deps.records.get(sessionId)!
      if (press.choice === 'merge') return { ok: false, code: 'invalid-spec', detail: 'Use Commit for an SVN worktree' }
      if (press.choice === 'commit' && !FinalizeSteps.prepares(record))
        return { ok: false, code: 'never-started', detail: FinishDriver.neverStarted(record) }
      const prior = record.worktreeLifecycle ?? WorktreeLifecycleMigration.fromOld(record)
      if (press.choice === 'commit' && prior?.stoppedFailure !== undefined && press.requestedBy !== 'window')
        return { ok: false, code: 'svn-failed', detail: prior.stoppedFailure }
      if (press.requestedBy !== 'window' && prior?.owner === 'person' && (prior.phase === 'finishing' || prior.phase === 'waiting')) {
        const changed = await this.deps.svn.present(initial.worktree!.worktreePath)
          ? await this.deps.svn.changes(initial.worktree!.worktreePath) : { ok: true as const, value: [] }
        if (!changed.ok) return { ok: false, code: 'svn-failed', detail: changed.detail }
        if (press.choice === 'commit' || changed.value.length > 0 || (prior.conflictMemory?.paths.length ?? 0) > 0)
          return { ok: false, code: 'person-only', detail: 'The person holds this Finish' }
      }
      if (press.choice === 'commit') {
        // A removal that failed past its rename left only `<name>.deleting`: Retry resumes it, and the
        // removal proves the identity of that aside itself.
        const aside = prior?.step === 'removing' && !await this.deps.svn.present(record.worktree!.worktreePath)
        const owner = aside ? { ok: true as const } : await this.deps.svn.ownerCheck(SvnWorktreeRemoval.locationOf(record.worktree!))
        if (!owner.ok) return { ok: false, code: 'svn-failed', detail: owner.detail }
        if (press.acknowledgeSetup !== undefined || prior?.execution === undefined || prior.step !== undefined && FinishStepPolicy.steps[prior.step].prepare) {
          const declared = await this.deps.checks.declaredAfter(record, press.acknowledgeSetup)
          if (!declared.ok) return declared.result
        }
      }
      await this.activate(sessionId, press)
      if (press.choice === 'commit' && prior?.stoppedFailure !== undefined)
        await this.state.write(sessionId, (state) => ({ ...state, stoppedFailure: undefined, retryFrom: state.journal.length }))
      record = this.deps.records.get(sessionId)!
      let state = record.worktreeLifecycle!
      const actor = press.requestedBy === 'window' ? 'person' : 'agent'
      if (press.choice === 'keep' || press.choice === 'discard') {
        const changes = await this.deps.svn.present(initial.worktree!.worktreePath)
          ? await this.deps.svn.changes(initial.worktree!.worktreePath) : { ok: true as const, value: [] }
        if (!changes.ok) return { ok: false, code: 'svn-failed', detail: changes.detail }
        state = this.deps.records.get(sessionId)!.worktreeLifecycle!
        const dirty = changes.value.length > 0 || (state.conflictMemory?.paths.length ?? 0) > 0
        const event: WorktreeEvent = press.choice === 'keep' ? { kind: 'keep', dirty }
          : { kind: 'discard', dirty, permit: actor === 'person' ? { kind: 'discard', by: 'person', at: this.deps.now() }
            : { kind: 'clean', provedAt: this.deps.now(), allowed: [] } }
        const transition = WorktreeTransitions.next(state, event, actor)
        if (!transition.ok) return { ok: false, code: 'person-only', detail: transition.refusal }
        try { await this.conflictStep.stopHelper(record, false, press.choice) }
        catch (error) { return { ok: false, code: 'merge-pending', detail: ErrorText.of(error) } }
        if (!await this.deps.records.update(sessionId, (record) => {
          const current = record.worktreeLifecycle
          if (current === undefined || current.actionId !== state.actionId) return null
          const latest = WorktreeTransitions.next(current, event, actor)
          if (!latest.ok) return null
          const observed = event.kind === 'keep' ? { publication: { ...WorktreePublication.retain(latest.state).publication!, remaining: SvnWorktreeEvidence.unpublished(changes.value) } } : {}
          return { ...record, worktreeLifecycle: { ...latest.state, ...observed, version: current.version + 1 } }
        })) return { ok: false, code: 'review-stale', detail: 'The Finish changed while stopping its helper; read it again' }
        this.deps.changed()
        if (press.choice === 'keep') await this.completion.recordResult(sessionId, 'kept')
      }
      else if (press.choice === 'commit') {
        if (press.confirmEnvironment === true) {
          if (actor !== 'person') return { ok: false, code: 'person-only', detail: 'Only the person confirms the refreshed worktree environment' }
          if (!await this.preparation.confirmEnvironment(sessionId)) return { ok: false, code: 'review-stale', detail: 'Environment inputs changed; prepare again' }
          return { ok: true, value: { actionId: state.actionId } }
        }
        if (press.refreshPreparation === true) {
          if (state.phase !== 'active' && (state.step === undefined || !FinishStepPolicy.steps[state.step].prepare))
            return { ok: false, code: 'merge-pending', detail: 'Preparation cannot replace a running publication or recovery' }
          if (state.execution?.runId !== undefined && state.execution.verdict === undefined)
            return { ok: false, code: 'merge-pending', detail: 'Wait for the current check to end' }
          await this.deps.commands.accept(initial.worktree!.worktreePath)
          await this.state.write(sessionId, (current) => ({ ...current, phase: 'finishing', step: 'checking', wait: undefined,
            preparation: undefined, approvedAt: undefined, review: undefined, checks: undefined,
            execution: { ...current.execution!, preparationRound: 0, checkCursor: 0, checkBefore: undefined, runId: undefined, verdict: undefined, refresh: undefined } }))
          return { ok: true, value: { actionId: state.actionId } }
        }
        // Only the person blesses svn changes made outside Jamat; the review that follows shows them. Once a
        // commit may have run, its approval stays: recovery and verification judge the publication against it.
        if (state.wait?.kind === 'changed-outside') {
          if (actor !== 'person') return { ok: false, code: 'person-only', detail: 'Only the person accepts svn changes made outside Jamat' }
          await this.deps.commands.accept(initial.worktree!.worktreePath)
          if (WorktreeTransitions.beforeCommit(state))
            await this.state.write(sessionId, (current) => ({ ...current, review: undefined, approvedAt: undefined,
              ...FinishStepPolicy.requiresApproval(current.step) ? { step: 'syncing' as const, preparation: undefined } : {} }))
          state = this.deps.records.get(sessionId)!.worktreeLifecycle!
        }
        if (press.reviewCorrection === true) {
          if (actor !== 'person' || state.wait?.kind !== 'published-with-differences')
            return { ok: false, code: 'person-only', detail: 'A corrective publication requires the person to review a published difference' }
          await this.deps.commands.accept(initial.worktree!.worktreePath)
          await this.state.write(sessionId, (current) => ({ ...current, actionId: this.deps.newId(), corrective: true,
            phase: 'finishing', step: 'syncing', wait: undefined, review: undefined, approvedAt: undefined,
            owner: actor, hasWindow: true, execution: { ...current.execution!, evidence: [], runId: undefined, verdict: undefined, checkCursor: 0 } }))
        }
        else if (press.overrideChecks === true) {
          if (actor !== 'person') return { ok: false, code: 'person-only', detail: 'Only the person may explicitly accept failed checks' }
          if (!await this.preparation.checked(sessionId, true))
            return { ok: false, code: 'review-stale', detail: 'The failed checks no longer describe this assembly; prepare again' }
          if (actor !== 'person' || !await this.checks.override(sessionId, actor))
            return { ok: false, code: 'person-only', detail: 'Only the person may explicitly accept failed checks' }
          await this.reviewStep.review(sessionId)
          return { ok: true, value: { actionId: state.actionId } }
        }
        if (press.reviewCorrection === true) return { ok: true, value: { actionId: this.deps.records.get(sessionId)!.worktreeLifecycle!.actionId } }
        if (actor === 'agent' && state.owner === 'person' && (state.phase === 'finishing' || state.phase === 'waiting'))
          return { ok: false, code: 'person-only', detail: 'The person holds this Finish' }
        if (press.selection !== undefined && actor !== 'person')
          return { ok: false, code: 'person-only', detail: 'Approve the selection in Session actions' }
        if (state.step === 'checking' && state.execution?.runId !== undefined && state.execution.verdict === undefined)
          return { ok: false, code: 'merge-pending', detail: 'The declared check is still running' }
        if (press.reviewVersion !== undefined && state.version !== press.reviewVersion)
          return { ok: false, code: 'review-stale', detail: 'This review is outdated' }
        if (press.selection !== undefined) {
          const invalid = await this.preparation.refuseStale(sessionId)
          if (invalid !== null) return { ok: false, code: 'review-stale', detail: invalid }
          if (state.preparation?.checkedAt === undefined) {
            const reason = 'Checks have not finished for this assembly'
            await this.preparation.invalidate(sessionId, reason)
            return { ok: false, code: 'review-stale', detail: reason }
          }
          const findings = press.selection.length === 0 || press.repositories !== undefined ? []
            : SvnCommitMessageCheck.blocking(press.message ?? '', press.messageSource ?? 'unknown', press.acknowledgedFindings ?? [])
          if (findings.length > 0)
            return { ok: false, code: 'message-unchecked', detail: findings.map(SvnCommitMessageCheck.wordOf).join('; ') }
          if (press.reviewVersion === undefined) return { ok: false, code: 'review-stale', detail: 'Open the current review before approving it' }
          if (state.wait?.kind === 'waiting-for-review' || state.wait?.kind === 'review') {
            await this.state.write(sessionId, (current) => ({ ...current, phase: 'finishing', wait: undefined, hasWindow: true }), false)
            state = this.deps.records.get(sessionId)!.worktreeLifecycle!
          }
          const selection = press.selection.map((path) => relative(initial.worktree!.worktreePath, path).replace(/\\/g, '/') || '.')
          // Approve persists last, so a throw inside it left nothing approved: a refusal with its reason, never
          // the uncertain "may have accepted" outcome (Finish 072).
          let approved: Awaited<ReturnType<ReviewCandidates['approve']>>
          try {
            approved = await this.reviews.approve(sessionId, { selection, message: press.message ?? '', source: press.messageSource ?? 'unknown',
              acknowledged: [...press.acknowledgedFindings ?? []], repositories: press.repositories, reviewVersion: press.reviewVersion })
          }
          catch (error) { return { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
          if (!approved.ok) return approved
          await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!, confirmBusy: press.confirmWorking }, owner: actor }))
          await this.reviewStep.prepareRoots(sessionId)
        }
        else if (state.step === 'reviewing' && state.review !== undefined) {
          await this.state.write(sessionId, (current) => ({ ...current, phase: 'finishing', step: 'syncing', wait: undefined,
            owner: actor, hasWindow: actor === 'person', review: undefined, approvedAt: undefined, preparation: undefined,
            execution: { ...current.execution!, reviewWaitAt: current.wait?.kind === 'waiting-for-review' ? current.wait.at : current.execution?.reviewWaitAt,
              checkCursor: 0, checkBefore: undefined, runId: undefined, verdict: undefined } }))
        }
        else if (state.step === 'worker-resolving') {
          await this.conflictStep.checkConflicts(sessionId, press.agent === true, press.confirmWorking)
        }
        else {
          if (state.step === 'awaiting-idle' && press.confirmWorking === true) {
            if (actor !== 'person') return { ok: false, code: 'person-only', detail: 'Only the person confirms publication while the worker is not idle' }
            await this.state.write(sessionId, (current) => ({ ...current, busyConfirmedFor: current.approvedAt }))
          }
          if (state.execution?.stopRefusedRunId !== undefined && state.execution.stopRefusedRunId === state.execution.runId)
            try { await this.conflictStep.stopHelper(record, false, 'commit') }
            catch (error) { return { ok: false, code: 'merge-pending', detail: ErrorText.of(error) } }
          await this.state.write(sessionId, (current) => ({ ...current, phase: 'finishing', step: WorktreeTransitions.resumeStep(current.step),
            wait: undefined, owner: actor, hasWindow: actor === 'person', execution: { ...current.execution!, confirmBusy: press.confirmWorking,
              stopRefusedRunId: undefined, stopRefusedPress: undefined,
              ...(WorktreeTransitions.resumeStep(current.step) === 'syncing'
                ? { checkCursor: 0, checkBefore: undefined, runId: undefined, verdict: undefined } : {}) } }))
        }
      }
      else throw new Error(`Unknown Finish choice: ${JSON.stringify(press.choice satisfies never)}`)
      return { ok: true, value: { actionId: this.deps.records.get(sessionId)?.worktreeLifecycle?.actionId ?? null } }
    })
    if (!result.ok) return result
    await this.drive(sessionId)
    return result
  }

  /**
   * Ends a Finish that has published nothing yet and leaves the worktree and its live worker as they are.
   * With `confirmStoppedRunId`, the person confirms the stop Jamat could not prove; when that refusal
   * interrupted Keep, Discard or Try again, that press goes on instead of the return to work.
   */
  async backToWork(sessionId: string, actor: 'person' | 'agent', confirmStoppedRunId?: string): Promise<SessionsOpResult<{ actionId: string | null }>> {
    const initial = this.deps.records.get(sessionId)
    if (initial?.worktree?.kind !== 'svn') return { ok: false, code: 'invalid-spec', detail: 'Back to work requires an SVN worktree' }
    const press = initial.worktreeLifecycle?.execution?.stopRefusedPress
    if (confirmStoppedRunId !== undefined && press !== undefined && press !== 'back-to-work') {
      const confirmed = await this.confirmStopped(initial.worktree.worktreePath, sessionId, actor, confirmStoppedRunId, press)
      return confirmed.ok ? this.start(sessionId, { choice: press, requestedBy: 'window' }) : confirmed
    }
    return this.deps.commands.lease.within(initial.worktree.worktreePath, 'finish', async (): Promise<SessionsOpResult<{ actionId: string | null }>> => {
      const record = this.deps.records.get(sessionId)!
      const state = record.worktreeLifecycle
      if (state === undefined) return { ok: false, code: 'invalid-spec', detail: 'No Finish runs in this worktree' }
      const refused = confirmStoppedRunId === undefined ? null : FinishDriver.confirmationRefusal(state, actor, confirmStoppedRunId)
      if (refused !== null) return refused
      const transition = WorktreeTransitions.next(state, { kind: 'back-to-work' }, actor)
      if (!transition.ok) return { ok: false, code: 'person-only', detail: transition.refusal }
      try { await this.conflictStep.stopHelper(record, confirmStoppedRunId !== undefined) }
      catch (error) { return { ok: false, code: 'merge-pending', detail: ErrorText.of(error) } }
      if (!await this.deps.records.update(sessionId, (latest) => {
        const current = latest.worktreeLifecycle
        if (current === undefined || current.actionId !== state.actionId || current.step !== state.step) return null
        const next = WorktreeTransitions.next(current, { kind: 'back-to-work' }, actor)
        return next.ok ? { ...latest, worktreeLifecycle: next.state, ...latest.svnAction?.kind === 'update-main' ? {} : { svnAction: undefined } } : null
      })) return { ok: false, code: 'review-stale', detail: 'The Finish changed; read it again' }
      this.deps.changed()
      return { ok: true, value: { actionId: state.actionId } }
    })
  }

  private async confirmStopped(root: string, sessionId: string, actor: 'person' | 'agent', runId: string, press: WorktreeStopPress): Promise<SessionsOpResult<null>> {
    return this.deps.commands.lease.within(root, 'finish', async (): Promise<SessionsOpResult<null>> => {
      const record = this.deps.records.get(sessionId)!
      const state = record.worktreeLifecycle
      if (state === undefined) return { ok: false, code: 'invalid-spec', detail: 'No Finish runs in this worktree' }
      const refused = FinishDriver.confirmationRefusal(state, actor, runId)
      if (refused !== null) return refused
      try { await this.conflictStep.stopHelper(record, true, press) }
      catch (error) { return { ok: false, code: 'merge-pending', detail: ErrorText.of(error) } }
      return { ok: true, value: null }
    })
  }

  private static confirmationRefusal(state: WorktreeLifecycle, actor: 'person' | 'agent', runId: string): SessionsOpResult<never> | null {
    return actor !== 'person' || state.execution?.runId !== runId || state.execution.stopRefusedRunId !== runId
      ? { ok: false, code: 'person-only', detail: 'Only the person can confirm the current refused run was stopped manually' } : null
  }

  private async activate(sessionId: string, press?: SessionFinishPress): Promise<void> {
    const record = this.deps.records.get(sessionId)!
    const state = record.worktreeLifecycle ?? WorktreeLifecycleMigration.fromOld(record)
    if (state === null) throw new Error('The worktree lifecycle is unavailable')
    if (state.execution !== undefined && state.phase !== 'kept' && state.phase !== 'removed') return
    const old = record.svnAction?.kind === 'update-main' ? undefined : record.svnAction
    const declared = press?.choice === 'discard' || press?.choice === 'keep' ? { ok: true as const, steps: [] }
      : await this.deps.checks.declaredAfter(record, press?.acknowledgeSetup)
    if (!declared.ok) throw new Error(declared.result.ok ? 'Checks were refused' : declared.result.detail)
    const actionId = old?.actionId ?? this.deps.newId()
    const execution: NonNullable<WorktreeLifecycle['execution']> = old === undefined ? {
      root: record.worktree!.worktreePath, checks: declared.steps.map((step) => ({ ...step, scriptId: 'checks' as const })),
      checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: press?.requestedBy ?? 'cli', startedAt: this.deps.now(),
      ...(record.worktree?.agentStartedAt === undefined ? { neverStartedReason: FinishDriver.neverStarted(record) } : {}),
    } : { ...FinishProjection.evidence(old), checks: old.checks.map((step) => ({ ...step, scriptId: 'checks' as const })) }
    const legacyCommit = old?.commit
    const review = legacyCommit === undefined ? state.review : { version: state.version + 1,
      selection: legacyCommit.selection.map((path) => relative(execution.root, path).replace(/\\/g, '/') || '.'),
      hashes: legacyCommit.hashes, message: legacyCommit.message, source: legacyCommit.messageSource ?? 'unknown',
      acknowledged: legacyCommit.acknowledgedFindings ?? [], headMovedBy: 0 }
    const step = old === undefined ? undefined : old.kind === 'discard' ? 'stopping-worker'
      : old.stage === 'stopping' || old.stage === 'evidence' || old.stage === 'committing' && old.runId === undefined
        || (old.stage === 'removing' || old.stage === 'recording') && state.removalPermit === undefined || old.stage === 'verifying' && old.commit === undefined ? 'syncing' : state.step
    if (old !== undefined && step === 'syncing' && old.stage !== 'updating' && old.stage !== 'cleaning' && old.stage !== 'diffing') {
      execution.runId = undefined
      execution.verdict = undefined
      execution.checkBefore = undefined
      execution.checkCursor = 0
    }
    let removalPermit = state.removalPermit
    if (old?.kind === 'discard' && removalPermit === undefined) {
      const changes = await this.deps.svn.changes(record.worktree!.worktreePath)
      if (!changes.ok) throw new Error(changes.detail)
      if (old.requestedBy === 'window') removalPermit = { kind: 'discard', by: 'person', at: old.startedAt }
      else if (changes.value.length === 0 && (state.conflictMemory?.paths.length ?? 0) === 0) removalPermit = { kind: 'clean', provedAt: this.deps.now(), allowed: [] }
    }
    if (!await this.deps.records.update(sessionId, (latest) => latest.worktreeLifecycle?.version !== record.worktreeLifecycle?.version ? null
      : ({ ...latest, svnAction: latest.svnAction?.kind === 'update-main' ? latest.svnAction : undefined,
      worktreeLifecycle: { ...state, legacyCommit: undefined, actionId, execution, removalPermit, version: state.version + 1,
        purpose: press?.choice === 'discard' || old?.kind === 'discard' ? 'discard' : 'finish',
        ...actionId === state.actionId ? {} : { corrective: undefined, publication: state.publication && { ...state.publication, remaining: undefined } },
        phase: state.phase === 'kept' || old === undefined ? 'active' : state.phase, step,
        wait: old === undefined ? undefined : state.wait, approvedAt: legacyCommit === undefined ? state.approvedAt : old!.startedAt,
        review: old === undefined ? undefined : review,
        owner: old === undefined ? press?.requestedBy === 'window' ? 'person' : 'agent' : state.owner,
        hasWindow: old === undefined ? press?.requestedBy === 'window' : state.hasWindow, ownerSince: old === undefined ? this.deps.now() : state.ownerSince,
        syncConflictSet: state.syncConflictSet ?? old?.conflictSet } }))) throw new Error('The Finish could not be saved')
  }

  async drive(sessionId: string): Promise<void> {
    const pending = this.driving.get(sessionId)
    if (pending !== undefined) return pending
    let yielded = false
    const work = this.deps.sync.withControl(sessionId, async () => { yielded = await this.driveCurrent(sessionId) })
      .finally(() => {
        this.driving.delete(sessionId)
        this.deps.changed()
        if (yielded) this.due(sessionId)
      })
    this.driving.set(sessionId, work)
    return work
  }

  private async driveCurrent(sessionId: string): Promise<boolean> {
    const record = this.deps.records.get(sessionId)
    if (record?.svnAction?.kind === 'update-main') {
      await this.deps.update.drive(sessionId)
      if (this.deps.records.get(sessionId)?.svnAction?.kind === 'update-main') return false
    }
    if (record?.svnAction !== undefined && record.worktree?.kind === 'svn')
      await this.deps.commands.lease.within(record.worktree.worktreePath, 'finish', () => this.activate(sessionId))
    const root = this.deps.records.get(sessionId)?.worktreeLifecycle?.execution?.root
    if (root === undefined) return false
    return this.deps.commands.lease.within(root, 'finish', async () => {
      try {
        const current = this.deps.records.get(sessionId)!
        if (current.worktreeLifecycle?.phase === 'finishing')
          for (const entry of WorktreeRecovery.pending(current).filter((row) => row.kind !== 'commit'))
            if (!await this.recoverStep(sessionId, entry)) return false
        return await this.flow.advance(sessionId) === 'yield'
      } catch (error: unknown) {
        if (this.deps.records.get(sessionId)?.worktreeLifecycle?.wait?.kind !== 'changed-outside')
          await this.state.wait(sessionId, 'svn-failed', ErrorText.of(error))
        return false
      }
    })
  }

  /**
   * A sync that waited for a busy worker goes on once the worker is idle, as a Finish press would
   * without its confirmation (UA1-J14-4). The owner of the activity calls this after each look.
   */
  async workerIdle(sessionId: string): Promise<void> {
    const state = this.deps.records.get(sessionId)?.worktreeLifecycle
    const root = state?.execution?.root
    if (state?.phase !== 'waiting' || state.wait?.kind !== 'worker-busy' || root === undefined
      || this.driving.has(sessionId) || !this.deps.idle(sessionId)) return
    const resumed = await this.deps.sync.withControl(sessionId, () => this.deps.commands.lease.within(root, 'finish', async () => {
      const current = this.deps.records.get(sessionId)?.worktreeLifecycle
      if (current?.phase !== 'waiting' || current.wait?.kind !== 'worker-busy' || !this.deps.idle(sessionId)) return false
      await this.state.write(sessionId, (latest) => ({ ...latest, phase: 'finishing', wait: undefined }))
      return true
    }))
    if (resumed) await this.drive(sessionId)
  }

  due(sessionId: string): void { this.deps.detach(this.drive(sessionId), `Finishing worktree ${sessionId}`) }

  /**
   * A Finish that published updates its main copy at once, with no press and no list of the sessions
   * working there: the person already asked for the change to land (Finish 072). Overlap protection
   * keeps the copies a running session's files need; a refused start leaves the UPDATE offer.
   */
  private updateAfterLanding(sessionId: string): void {
    const record = this.deps.records.get(sessionId)
    const outcome = record?.worktreeOutcome?.result
    if (record?.worktreeLifecycle?.phase !== 'landed' || outcome !== 'committed' && outcome !== 'partial') return
    const mainCopy = LandedRows.landingOf(record)?.mainCopy
    if (mainCopy === undefined) return
    const requestedBy = record.worktreeLifecycle.execution?.requestedBy ?? 'window'
    // Outside this drive's lease scope, after the drive: an svn write in the main copy checks every lease
    // its scope holds under it, and the worktree that lease names is gone.
    this.deps.detach(this.deps.commands.lease.outside(async () => {
      await this.settled(sessionId)
      const started = await this.deps.update.startUpdate(sessionId, mainCopy, requestedBy, false, false)
      if (!started.ok) this.deps.report(`Session ${sessionId}: UPDATE of ${mainCopy} did not start after the Finish (${started.detail})`)
    }), `Updating the main copy of ${sessionId}`)
  }
  held(): ReadonlySet<string> { return new Set([...this.driving.keys(), ...this.deps.update.held()]) }
  async settled(sessionId: string): Promise<SvnFinishWorktreeResult | null> {
    let pending = this.driving.get(sessionId)
    while (pending !== undefined) {
      await pending
      pending = this.driving.get(sessionId)
    }
    return this.completion.endingOf(sessionId)
  }
  endingOf(actionId: string): SvnFinishWorktreeResult | null { return this.completion.endingOf(actionId) }
  startUpdate(...args: Parameters<MainCopyUpdate['startUpdate']>) { return this.deps.update.startUpdate(...args) }

  async foreignCommit(sessionId: string, receipts: readonly SessionRecordCommitReceipt[]): Promise<void> {
    const record = this.deps.records.get(sessionId)
    if (record?.worktree?.kind !== 'svn') return
    const root = record.worktree.worktreePath
    await this.deps.commands.lease.within(root, 'finish', async () => {
      const current = this.deps.records.get(sessionId)
      if (current?.worktree?.kind !== 'svn' || PathCompare.comparable(current.worktree.worktreePath) !== PathCompare.comparable(root)) return
      await this.activate(sessionId)
      const known = receipts.filter((receipt) => receipt.revision !== null && receipt.paths.length > 0 && PathCompare.isInside(root, receipt.scopeRoot))
      if (known.length === 0) { await this.state.wait(sessionId, 'published-with-differences', 'The external commit has no proven revision or path receipt'); return }
      const deletions = new Set<string>()
      for (const receipt of known) {
        const publication = await this.deps.svn.publicationRows(receipt.scopeRoot, receipt.paths, receipt.revision!)
        if (!publication.ok) throw new Error(publication.detail)
        for (const path of receipt.paths)
          if (publication.value.changed.some((row) => row.action === 'D' && (row.path === path || path.startsWith(row.path + '/'))))
            deletions.add(relative(root, resolve(receipt.scopeRoot, path)).replace(/\\/g, '/') || '.')
      }
      const selection = known.flatMap((receipt) => receipt.paths.map((path) => relative(root, resolve(receipt.scopeRoot, path)).replace(/\\/g, '/') || '.'))
      const hashes = await this.deps.svn.commitHashes(root, selection, 'node')
      if (!hashes.ok) throw new Error(hashes.detail)
      const roots = known.map((receipt) => ({ path: receipt.scopeRoot, own: relative(root, receipt.scopeRoot).replace(/\\/g, '/'), changed: [],
        selection: receipt.paths.map((path) => resolve(receipt.scopeRoot, path)) }))
      const bounds = await this.deps.svn.lowerBounds(roots)
      if (!bounds.ok) throw new Error(bounds.detail)
      // These receipts already exist; current HEAD is not a lower bound preceding their publication.
      const accepted = roots.map((scope, index) => ({ ...scope, bounds: { ...bounds.value[scope.own], since: known[index].revision! - 1 } }))
      await this.state.write(sessionId, (state) => ({ ...state, phase: 'finishing', step: 'verifying', wait: undefined, approvedAt: this.deps.now(),
        review: { version: state.version + 1, selection, deletions: [...deletions, ...(state.review?.deletions ?? []).filter((path) => !selection.includes(path))], hashes: { ...state.review?.hashes, ...hashes.value },
          message: state.review?.message ?? '', source: state.review?.source ?? 'unknown', acknowledged: state.review?.acknowledged ?? [], headMovedBy: 0 },
        execution: { ...state.execution!, rootCursor: 0, roots: accepted,
          evidence: SvnRevisionLabels.merged(state.execution!.evidence, known.map((receipt, index) => ({ repository: bounds.value[roots[index].own].repository,
            revision: receipt.revision!, label: 'receipt' as const, paths: receipt.paths.map((path) => FinishState.repositoryPath(bounds.value[roots[index].own].base, path)) }))) } }))
    })
    this.due(sessionId)
  }

  async noteVerdict(sessionId: string, verdict: SvnActionVerdict): Promise<boolean> {
    const record = this.deps.records.get(sessionId)
    if (record?.svnAction?.kind === 'update-main') return this.deps.update.noteVerdict(sessionId, verdict)
    if (record?.worktree?.kind === 'svn' && record.worktreeLifecycle?.execution === undefined && record.svnAction !== undefined)
      await this.deps.commands.lease.within(record.worktree.worktreePath, 'finish', () => this.activate(sessionId))
    const state = this.deps.records.get(sessionId)?.worktreeLifecycle
    if (state?.execution === undefined) return false
    const runId = state.execution.runId
    if (runId === undefined || state.phase !== 'finishing' || (state.step === undefined || !FinishStepPolicy.steps[state.step].verdict)) return false
    const run = this.deps.records.get(runId)
    if (run?.life === 'live' || run?.life === 'starting') return false
    if (run !== null && !this.deps.records.get(sessionId)?.scriptRuns?.some((entry) => entry.runId === runId)) return false
    // A lost run, or an ended one whose children the Host cannot account for, is judged all the same:
    // refusing its verdict left the step running for ever. The Finish waits for the person instead.
    const unproven = await this.deps.stopRun(runId) ? null
      : `${ConflictStep.unprovenOf(run?.life ?? 'lost', FinishDriver.runWordOf(state, runId), ConflictStep.hostWordsOf(this.deps.stopRefusal?.(runId)))} Stop them, then press ${ConflictStep.confirmStoppedConst}.`
    const saved = await this.deps.commands.lease.within(state.execution.root, 'finish', async () => {
      const latest = this.deps.records.get(sessionId)?.worktreeLifecycle
      if (latest?.actionId !== state.actionId || latest.execution?.runId !== runId || latest.phase !== 'finishing' || latest.step !== state.step) return false
      await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!,
        ...(unproven === null ? { verdict } : { verdict: { kind: 'failed' as const, reason: unproven }, stopRefusedRunId: runId,
          stopRefusedPress: current.execution!.stopRefusedRunId === runId ? current.execution!.stopRefusedPress : undefined }),
        ...(state.step === 'worker-resolving' && current.execution!.merger !== undefined
          ? { merger: { ...current.execution!.merger, endedAt: this.deps.now() } } : {}) } }))
      if (unproven !== null) await this.state.wait(sessionId, 'host-unhealthy', unproven)
      return true
    })
    if (saved && unproven === null) this.due(sessionId)
    return saved
  }

  private static runWordOf(state: WorktreeLifecycle, runId: string): string {
    if (state.step === 'worker-resolving') return 'The merger'
    const check = state.step === 'checking' ? state.execution?.checks[state.execution.checkCursor]?.name : undefined
    return check === undefined ? `The Finish run ${runId}` : `The check ${check}`
  }

  async resolveConflict(sessionId: string, request: Parameters<MainCopyUpdate['resolveConflict']>[1]) {
    const state = this.deps.records.get(sessionId)?.worktreeLifecycle
    if (state?.execution === undefined || this.deps.records.get(sessionId)?.svnAction?.kind === 'update-main') return this.deps.update.resolveConflict(sessionId, request)
    let awaitingMerger = false
    const resolved = await this.deps.commands.lease.within(state.execution.root, 'resolve', async () => {
      const current = this.deps.records.get(sessionId)!.worktreeLifecycle!
      awaitingMerger = current.execution?.merger !== undefined && current.execution.merger.endedAt === undefined
      const resolved = await this.deps.sync.resolve(sessionId, { ...request, requestedBy: request.by === 'person' ? 'window' : 'cli' })
      // The last path settlement cannot outrun the merger's captured verdict and handover guards.
      if (resolved.ok && awaitingMerger) await this.state.write(sessionId, (latest) => ({ ...latest, step: 'worker-resolving' }))
      return resolved
    })
    if (resolved.ok && !awaitingMerger) this.due(sessionId)
    return resolved
  }

  async helperOf(sessionId: string): Promise<SessionsOpResult<SessionCreateSpec>> {
    const record = this.deps.records.get(sessionId)
    const action = record === null ? undefined : FinishProjection.action(record)
    if (record === null || action?.needs === undefined || !SvnWaitHelper.offered(action))
      return { ok: false, code: 'invalid-spec', detail: 'Solve with agent needs a Finish that waits for the person' }
    const cli = this.deps.resolver.cli()
    if (!cli.ok) return { ok: false, code: 'invalid-spec', detail: cli.detail }
    const text = SvnWaitHelper.briefOf({ title: record.title, sessionId, action, need: action.needs,
      workflow: SessionWorkflows.of(record, (runId) => this.deps.records.get(runId)),
      logOf: (runId) => this.deps.resolver.briefs.pathOf(sessionId, runId), cli: cli.command, instance: this.deps.resolver.instance })
    const written = await this.deps.resolver.briefs.writeHelpBrief(sessionId, action.actionId, text)
    if (!written.ok) return { ok: false, code: 'invalid-spec', detail: written.detail }
    return { ok: true, value: SvnWaitHelper.specOf(record, { root: action.root,
      briefFile: this.deps.resolver.briefs.helpBriefPathOf(sessionId, action.actionId) }) }
  }

  async recoverCommit(sessionId: string, entry: SvnStepJournalEntry): Promise<boolean> {
    const record = this.deps.records.get(sessionId)
    if (record?.worktree?.kind !== 'svn') return false
    return this.deps.commands.lease.within(record.worktree.worktreePath, 'commit', async () => {
      await this.activate(sessionId)
      const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
      const action = this.state.action(sessionId)
      const root = action.roots?.[action.rootCursor]
      if (root === undefined || entry.stepId !== `${state.actionId}-commit-${root.own || '.'}` && entry.stepId !== `${state.actionId}-commit-${action.rootCursor}` || entry.cwd !== root.path) {
        await this.state.wait(sessionId, 'svn-failed', 'The commit journal no longer matches its owning Finish'); return false
      }
      const recovered = await this.commit.recover(entry, root.path)
      if (recovered.kind === 'ambiguous') {
        const uncertain = { repository: root.bounds!.repository, revisions: recovered.candidates }
        await this.state.write(sessionId, (current) => ({ ...current, journal: current.journal.map((row) => row.runId === entry.runId
          ? { ...row, uncertain: recovered.candidates.length === 0 ? undefined : uncertain } : row) }))
        const named = WorktreePublication.uncertain(this.deps.records.get(sessionId)!.worktreeLifecycle!)
        await this.state.wait(sessionId, 'svn-failed', named.length === 0 ? recovered.reason
          : `${recovered.reason}. Candidates: ${named.join('; ')}. Jamat marks none of them as published without proof; inspect them in the repository.`)
        return false
      }
      await this.conflictStep.preserveRecoveryConflicts(sessionId)
      // The killed client may have left its lock, or moved some selected nodes on, before it died.
      await this.deps.commands.acceptInterrupted(root.path, root.selection ?? [])
      const cleanup = await this.deps.runner.run(sessionId, 'cleanup', root.path, ['cleanup', '--', '.'], { stepId: `${entry.stepId}-recovery-cleanup`, attempt: entry.attempt })
      if (!cleanup.ok) { await this.state.wait(sessionId, 'svn-failed', cleanup.output); return false }
      if (recovered.kind === 'not-landed') {
        const restored = await this.deps.svn.unprepareCommit(root.path, entry.preparedAdds ?? [])
        if (!restored.ok) throw new Error(restored.detail)
        await this.state.write(sessionId, (current) => ({ ...current, step: 'reviewing', approvedAt: undefined, review: undefined,
          journal: current.journal.map((row) => row.runId === entry.runId ? { ...row, endedAt: row.endedAt ?? this.deps.now(), outcome: row.outcome ?? 'other', recovered: 'not-landed', uncertain: undefined } : row.endedAt === undefined ? { ...row, endedAt: this.deps.now(), outcome: 'other' } : row) }))
        await this.reviewStep.review(sessionId)
        await this.state.wait(sessionId, 'review', 'No commit landed before the restart; review and approve again')
        return false
      }
      if (recovered.kind !== 'landed') throw new Error(`Unknown recovery: ${JSON.stringify(recovered satisfies never)}`)
      await this.commit.receipt(sessionId, root.path, recovered.revision, root.selection!.map((path) => relative(root.path, path).replace(/\\/g, '/') || '.'))
      await this.state.write(sessionId, (current) => ({ ...current, phase: 'finishing', step: 'verifying', wait: undefined,
        execution: { ...current.execution!, runId: entry.runId, evidence: SvnRevisionLabels.merged(current.execution!.evidence,
          [{ repository: root.bounds!.repository, revision: recovered.revision, label: 'receipt', paths: entry.paths }]) },
        journal: current.journal.map((row) => row.runId === entry.runId ? { ...row, endedAt: row.endedAt ?? this.deps.now(), outcome: 'ok', revision: recovered.revision, uncertain: undefined }
          : row.endedAt === undefined ? { ...row, endedAt: this.deps.now(), outcome: 'other' } : row) }))
      return true
    })
  }

  async recoverStep(sessionId: string, entry: SvnStepJournalEntry): Promise<boolean> {
    const record = this.deps.records.get(sessionId)
    if (record?.worktree?.kind !== 'svn' || record.svnAction?.kind === 'update-main') return this.deps.update.recoverStep(sessionId, entry)
    return this.deps.commands.lease.within(record.worktree.worktreePath, 'update', async () => {
    await this.activate(sessionId)
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    if (entry.kind === 'update' && state.preparation !== undefined && state.step !== 'syncing'
      && state.preparation.checkedAt !== undefined && state.preparation.checkedAt >= entry.startedAt) {
      await this.state.write(sessionId, (current) => ({ ...current, journal: current.journal.map((row) => row.runId === entry.runId
        ? { ...row, endedAt: this.deps.now(), outcome: 'other', output: 'Older update intent superseded by the retained verified preparation; no SVN replay performed' } : row) }))
      return true
    }
    if (entry.kind === 'cleanup' && !entry.stepId.startsWith(`${state.actionId}-conflict-`) && entry.cwd !== undefined && PathCompare.isInside(record.worktree!.worktreePath, entry.cwd)
      && entry.stepId.startsWith(`${state.actionId}-`)) {
      const cleanup = await this.deps.runner.run(sessionId, 'cleanup', entry.cwd, ['cleanup', '--', '.'],
        { stepId: entry.stepId, attempt: entry.attempt + 1 })
      if (!cleanup.ok) { await this.state.wait(sessionId, 'locked', cleanup.output); return false }
      await this.state.write(sessionId, (current) => ({ ...current, journal: current.journal.map((row) => row.runId === entry.runId
        ? { ...row, endedAt: this.deps.now(), outcome: 'ok' } : row) }))
      return true
    }
    if ((entry.kind === 'resolve' || entry.kind === 'revert' || entry.kind === 'cleanup') && entry.cwd !== undefined
      && PathCompare.isInside(record.worktree!.worktreePath, entry.cwd) && entry.stepId.startsWith(`${state.actionId}-conflict-`)) {
      await this.state.write(sessionId, (current) => ({ ...current, step: 'worker-resolving', phase: 'waiting',
        wait: { kind: 'conflict-person', at: this.deps.now(), reason: `Interrupted conflict write. Release file holders and press ${SvnConflictWords.checkAgainConst}: Jamat cleans up only its own SVN queue and leaves working text in place; for an unknown queue it saves copies and names them before any manual cleanup.` },
        journal: current.journal.map((row) => row.runId === entry.runId ? { ...row, endedAt: this.deps.now(), outcome: 'other' } : row) }))
      return false
    }
    if (state.update !== undefined && !state.update.completed) {
      await this.conflictStep.preserveRecoveryConflicts(sessionId)
      if (!await this.deps.sync.recover(sessionId, entry)) {
        await this.state.wait(sessionId, 'svn-failed', 'The interrupted update no longer matches its saved repository step'); return false
      }
      await this.state.write(sessionId, (current) => ({ ...current, step: 'syncing', phase: 'finishing', wait: undefined }))
      return true
    }
    if (entry.kind !== 'update' || entry.cwd !== state.execution!.root || entry.targetRevision === undefined || !entry.stepId.startsWith(`${state.actionId}-`)) {
      await this.state.wait(sessionId, 'svn-failed', 'The interrupted SVN step lacks its current owner and fixed target'); return false
    }
      await this.conflictStep.preserveRecoveryConflicts(sessionId)
      const cleanup = await this.deps.runner.run(sessionId, 'cleanup', entry.cwd!, ['cleanup', '--', '.'], { stepId: `${entry.stepId}-recovery-cleanup`, attempt: entry.attempt })
      if (!cleanup.ok) { await this.state.wait(sessionId, 'svn-failed', cleanup.output); return false }
      const result = await this.deps.runner.run(sessionId, 'update', entry.cwd!, ['update', '-r', String(entry.targetRevision), '--accept', 'postpone', '--', '.'],
        { stepId: entry.stepId, attempt: entry.attempt + 1, targetRevision: entry.targetRevision, baseRevision: entry.baseRevision })
      await this.deps.results.keepAttempt(state.actionId!, sessionId, { runId: result.runId, title: 'Recovered svn update' })
      await this.conflictStep.preserveRecoveryConflicts(sessionId)
      await this.state.write(sessionId, (current) => ({ ...current, step: 'syncing', phase: 'finishing', wait: undefined,
        journal: current.journal.map((row) => row.runId === entry.runId || row.endedAt === undefined && row.cwd === entry.cwd ? { ...row, endedAt: this.deps.now(), outcome: 'other' } : row) }))
      if (!result.ok && result.failure !== 'conflict') { await this.state.wait(sessionId, 'svn-failed', result.output); return false }
      return true
    })
  }

  private static neverStarted(record: SessionRecord): string {
    return `The agent never started: ${record.endedReason ?? record.launchWait?.reason ?? 'no agent start was recorded'}. Nothing to land.`
  }
}
