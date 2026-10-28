import type { FinishStep, WorktreeActor, WorktreeEffect, WorktreeEvent, WorktreeLifecycle, WorktreePhase } from './worktreeState'
import { WorkerResumePolicy } from './worktreeState'

type TransitionKey = WorktreePhase | FinishStep
type TransitionRows = Partial<Record<WorktreeEvent['kind'], readonly WorktreeActor[]>>
export type WorktreeTransitionResult = { ok: true; state: WorktreeLifecycle; effects: WorktreeEffect[] } | { ok: false; refusal: string }

const people: readonly WorktreeActor[] = ['person', 'remote-person']
const keepers: readonly WorktreeActor[] = [...people, 'agent']
const system: readonly WorktreeActor[] = ['jamat']
const controls: TransitionRows = { keep: keepers, discard: keepers, wait: system, 'worker-died': system }
const backToWork: TransitionRows = { 'back-to-work': keepers }

export class WorktreeTransitions {
  static readonly table: Readonly<Partial<Record<TransitionKey, TransitionRows>>> = {
    active: { finish: [...people, 'worker', 'agent', 'jamat'], ready: ['worker', 'jamat'], keep: keepers, discard: keepers, 'worker-died': system },
    kept: { finish: [...people, 'worker', 'agent', 'jamat'], ready: ['worker', 'jamat'], discard: keepers },
    syncing: { ...controls, synced: system },
    'worker-resolving': { ...controls, ...backToWork, resolved: ['worker', 'person', 'jamat'], ready: ['worker', 'jamat'] },
    checking: { ...controls, ...backToWork, 'checks-passed': system },
    reviewing: { ...controls, ...backToWork, approve: people, correct: people },
    'awaiting-idle': { ...controls, ...backToWork, idle: system, 'confirm-busy': people, correct: people },
    committing: { committed: system, 'out-of-date': system, wait: system, 'worker-died': system },
    verifying: { verified: system, wait: system, 'worker-died': system },
    disposing: { disposed: system, wait: system, 'worker-died': system },
    'stopping-worker': { 'worker-stopped': system, wait: system },
    removing: { removed: system, wait: system },
    recording: { recorded: system, wait: system },
    waiting: { keep: keepers, discard: keepers, retry: [...people, 'jamat'], 'review-opened': people,
      'worker-resumed': system, 'resume-failed': system, ...backToWork },
  }

  static next(state: WorktreeLifecycle, event: WorktreeEvent, actor: WorktreeActor): WorktreeTransitionResult {
    if (state.unreadable !== undefined) return { ok: false, refusal: state.unreadable }
    const key = state.phase === 'waiting' ? 'waiting' : state.step ?? state.phase
    const actors = WorktreeTransitions.table[key]?.[event.kind]
    if (actors === undefined) return { ok: false, refusal: `${event.kind} is not possible in ${key}` }
    if (!actors.includes(actor)) return { ok: false, refusal: `${actor} may not ${event.kind} now` }
    if ((event.kind === 'keep' || event.kind === 'discard') && actor === 'agent') {
      if (event.dirty && (state.phase === 'finishing' || state.phase === 'waiting')
        && (state.owner === 'person' || state.owner === 'remote-person'))
        return { ok: false, refusal: `The person holds this Finish${state.ownerSince === undefined ? '' : ` since ${new Date(state.ownerSince).toLocaleTimeString()}`}` }
      if (event.kind === 'discard' && (event.dirty || event.permit.kind !== 'clean'))
        return { ok: false, refusal: 'An agent Discard requires a clean proof' }
    }
    if (event.kind === 'back-to-work' && actor === 'agent' && (state.owner === 'person' || state.owner === 'remote-person'))
      return { ok: false, refusal: `The person holds this Finish${state.ownerSince === undefined ? '' : ` since ${new Date(state.ownerSince).toLocaleTimeString()}`}` }
    const result = WorktreeTransitions.apply(state, event, actor)
    if (!result.ok) return result
    const version = state.version + 1
    const review = result.state.phase === 'finishing' && result.state.step === 'reviewing' && result.state.review !== undefined
      ? { ...result.state.review, version } : result.state.review
    return { ...result, state: { ...result.state, version, ...review === undefined ? {} : { review } } }
  }

  private static apply(state: WorktreeLifecycle, event: WorktreeEvent, actor: WorktreeActor): WorktreeTransitionResult {
    const move = (step: FinishStep, effects: WorktreeEffect[] = [], patch: Partial<WorktreeLifecycle> = {}): WorktreeTransitionResult =>
      ({ ok: true, state: { ...state, phase: 'finishing', step, wait: undefined, ...patch }, effects })
    const wait = (kind: NonNullable<WorktreeLifecycle['wait']>['kind'], reason: string, at: number,
      patch: Partial<WorktreeLifecycle> = {}, effects: WorktreeEffect[] = []): WorktreeTransitionResult =>
      ({ ok: true, state: { ...state, ...patch, phase: 'waiting', wait: { kind, reason, at } }, effects })
    switch (event.kind) {
      case 'finish':
        if (!event.ready && (!event.confirmed || (actor !== 'person' && actor !== 'remote-person')))
          return { ok: false, refusal: 'Finish before ready requires the person confirmation' }
        return move('syncing', [{ kind: 'svn', step: 'update' }], { actionId: event.actionId, owner: actor,
          purpose: 'finish', corrective: undefined, hasWindow: event.hasWindow, review: undefined, outOfDate: 0, removalPermit: undefined, ownerSince: event.at, conflictProgress: undefined })
      case 'ready':
        return { ok: true, state: { ...state, facts: { ...state.facts, worker: { ...state.facts.worker,
          ready: { at: event.at, hashes: { ...event.hashes } } } } }, effects: [] }
      case 'synced':
        return move(event.conflicts > 0 ? 'worker-resolving' : 'checking', event.conflicts > 0
          ? [{ kind: 'deliver-worker', brief: `Resolve ${event.conflicts} conflicts in this worktree` }]
          : [{ kind: 'run-checks' }], { preparation: undefined, approvedAt: undefined, review: undefined, checks: undefined,
            facts: { ...state.facts, syncedAt: { revision: event.revision, at: event.at } } })
      case 'resolved': return move('checking', [{ kind: 'run-checks' }])
      case 'checks-passed':
        if (state.hasWindow !== true)
          return wait('waiting-for-review', 'Open a window to review the final changes', state.facts.syncedAt?.at ?? 0, { step: 'reviewing', review: event.review })
        return move('reviewing', [], { review: event.review })
      case 'review-opened':
        if (state.wait?.kind !== 'waiting-for-review') return { ok: false, refusal: 'This wait does not request a review window' }
        return move('reviewing', [], { hasWindow: true })
      case 'approve':
        if (state.preparation?.checkedAt === undefined)
          return { ok: false, refusal: 'Prepare and validate this application before approving publication' }
        if (state.review === undefined || state.review.version !== event.reviewVersion || state.version !== event.reviewVersion)
          return { ok: false, refusal: 'The review changed; read the current selection before approving' }
        return move('awaiting-idle')
      case 'correct': return move('worker-resolving', [{ kind: 'deliver-worker', brief: event.brief }], { review: undefined })
      case 'idle': case 'confirm-busy': return move('committing', [{ kind: 'svn', step: 'commit' }])
      case 'committed': return move('verifying', [{ kind: 'svn', step: 'status' }])
      case 'out-of-date': {
        const outOfDate = state.outOfDate + 1
        return wait('repository-busy', 'The repository changed; prepare, test and approve again', event.at,
          { outOfDate, step: 'syncing', preparation: undefined, approvedAt: undefined, checks: undefined })
      }
      case 'verified': return move('disposing')
      case 'disposed': return move('stopping-worker', [{ kind: 'stop-worker' }], { removalPermit: event.permit })
      case 'worker-stopped':
        if (state.removalPermit === undefined) return { ok: false, refusal: 'Removal requires a permit' }
        return move('removing', [{ kind: 'remove', permit: state.removalPermit }],
          { facts: { ...state.facts, worker: { ...state.facts.worker, liveness: 'stopped' } } })
      case 'removed': return move('recording', [{ kind: 'write-result' }])
      case 'recorded':
        return { ok: true, state: { ...state, phase: state.purpose === 'discard' ? 'removed' : 'landed', step: undefined, wait: undefined }, effects: [] }
      case 'keep':
        return { ok: true, state: { ...state, phase: 'kept', step: undefined, wait: undefined, preparation: undefined, approvedAt: undefined, update: undefined, updateFailure: undefined }, effects: [{ kind: 'write-result' }] }
      case 'discard':
        if (actor !== 'agent' && event.permit.kind !== 'discard')
          return { ok: false, refusal: 'The person Discard requires a discard permit' }
        return move('stopping-worker', [{ kind: 'stop-worker' }], { purpose: 'discard', owner: actor, removalPermit: event.permit, update: undefined, updateFailure: undefined })
      case 'wait': return wait(event.wait.kind, event.wait.reason, event.wait.at)
      case 'back-to-work':
        if (!WorktreeTransitions.beforeCommit(state))
          return { ok: false, refusal: 'Back to work is possible only before the commit starts' }
        return { ok: true, state: { ...state, phase: 'active', step: undefined, wait: undefined, review: undefined, approvedAt: undefined,
          awaitingIdleAt: undefined, awaitingIdleReason: undefined, busyConfirmedFor: undefined, preparation: undefined, stoppedFailure: undefined, retryFrom: state.journal.length,
          owner: undefined, ownerSince: undefined, purpose: undefined, hasWindow: undefined, execution: undefined, update: undefined, updateFailure: undefined,
          facts: { ...state.facts, syncedAt: undefined } }, effects: [] }
      case 'retry': {
        if (state.step === undefined || state.wait?.kind === 'waiting-for-review')
          return { ok: false, refusal: 'This wait requires its named action' }
        const step = state.step === 'committing' ? 'syncing' : state.step
        return move(step, WorktreeTransitions.effectsFor(step, state))
      }
      case 'worker-died': {
        const mode = WorkerResumePolicy.onDeath(state.step)
        return { ok: true, state: { ...state, facts: { ...state.facts, worker: { ...state.facts.worker, liveness: 'dead',
          diedAt: event.at, diedDuring: state.step, ...mode === 'none' ? {} : { resumeMode: mode } } } },
          effects: [{ kind: 'notify', text: 'The worker stopped; its conversation will resume' },
            ...mode === 'resume-and-redeliver' || mode === 'resume-quiet' ? [{ kind: 'resume-worker' as const }] : []] }
      }
      case 'worker-resumed': {
        if (state.wait?.kind !== 'worker-lost') return { ok: false, refusal: 'No lost worker can resume' }
        // A resume the person asked for starts the count of failed resumes again.
        const facts = { ...state.facts, worker: { ...state.facts.worker, liveness: 'alive' as const, resumedAt: event.at, resumeFailures: 0, resumeMode: undefined } }
        if (state.step === undefined) return { ok: true, state: { ...state, phase: 'active', wait: undefined, facts }, effects: [] }
        // The lost wait replaced the review wait of a Finish no window holds; the review goes back to it.
        if (state.step === 'reviewing' && state.hasWindow !== true)
          return wait('waiting-for-review', 'Open a window to review the final changes', event.at, { facts })
        return move(state.step, WorktreeTransitions.effectsFor(state.step, state), { facts })
      }
      case 'resume-failed': {
        if (state.wait?.kind !== 'worker-lost') return { ok: false, refusal: 'No worker resume is pending' }
        const failures = state.facts.worker.resumeFailures + 1
        return wait('worker-lost', failures >= 2 ? 'The worker could not resume twice' : 'Retrying the worker conversation', event.at,
          { facts: { ...state.facts, worker: { ...state.facts.worker, resumeFailures: failures } } }, failures >= 2 ? [] : [{ kind: 'resume-worker' }])
      }
      default: throw new Error(`Unknown worktree event: ${JSON.stringify(event satisfies never)}`)
    }
  }

  static resumeStep(step: FinishStep | undefined): FinishStep {
    switch (step) {
      case undefined: case 'syncing': case 'worker-resolving': case 'reviewing': return 'syncing'
      case 'checking': case 'awaiting-idle': case 'committing': case 'verifying': case 'disposing':
      case 'stopping-worker': case 'removing': case 'recording': return step
      default: throw new Error(`Unknown finish step: ${JSON.stringify(step satisfies never)}`)
    }
  }

  /** A Finish that holds a review, or has started publishing, refuses svn changes it did not make. */
  static guardsSvnState(state: WorktreeLifecycle): boolean {
    if (state.phase !== 'finishing' && state.phase !== 'waiting') return false
    return state.review !== undefined || state.approvedAt !== undefined || state.step !== undefined && !WorktreeTransitions.beforeCommit(state)
  }

  /** Nothing is published yet, so the person may take the worktree back to the worker. */
  static beforeCommit(state: WorktreeLifecycle): boolean {
    if (state.purpose === 'discard' || state.corrective === true || (state.execution?.evidence.length ?? 0) > 0 || state.journal.some((entry) => entry.kind === 'commit' && entry.stepId.startsWith(`${state.actionId}-`)
      && entry.recovered !== 'not-landed' && (entry.revision !== undefined || entry.endedAt === undefined))) return false
    switch (state.step) {
      case 'syncing': case 'worker-resolving': case 'checking': case 'reviewing': case 'awaiting-idle': return true
      case undefined: case 'committing': case 'verifying': case 'disposing': case 'stopping-worker': case 'removing': case 'recording': return false
      default: throw new Error(`Unknown finish step: ${JSON.stringify(state.step satisfies never)}`)
    }
  }

  private static effectsFor(step: FinishStep, state: WorktreeLifecycle): WorktreeEffect[] {
    switch (step) {
      case 'syncing': return [{ kind: 'svn', step: 'update' }]
      case 'worker-resolving': return [{ kind: 'deliver-worker', brief: 'Continue resolving the worktree conflicts' }]
      case 'checking': return [{ kind: 'run-checks' }]
      case 'reviewing': case 'awaiting-idle': case 'disposing': return []
      case 'committing': return [{ kind: 'svn', step: 'status' }]
      case 'verifying': return [{ kind: 'svn', step: 'status' }]
      case 'stopping-worker': return [{ kind: 'stop-worker' }]
      case 'removing': return state.removalPermit === undefined ? [] : [{ kind: 'remove', permit: state.removalPermit }]
      case 'recording': return [{ kind: 'write-result' }]
      default: throw new Error(`Unknown finish step: ${JSON.stringify(step satisfies never)}`)
    }
  }
}
