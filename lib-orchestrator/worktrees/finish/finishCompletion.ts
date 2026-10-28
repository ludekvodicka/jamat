import { relative } from 'node:path'
import type { SvnFinishWorktreeResult, SvnLabelledRevision, WorktreeResultCommitMessage, WorktreeResultKind } from '../../sessionManager/sessionManagerApi.types'
import { SvnConflictWords } from '../conflicts/svnConflictWords'
import { SvnWorktreeRemoval } from '../removal/svnWorktreeRemoval'
import { SvnWorktreeEvidence } from '../../svn/svnWorktreeEvidence'
import { WorktreeResultsStore } from '../results/worktreeResultsStore'
import { LandedRows } from '../landing/landedRows'
import { SvnRevisionLabels } from './svnRevisionLabels'
import type { FinishDriverDeps } from './finishDriver.types'
import type { FinishState } from './finishState'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import { SessionWorkingDirectory } from '../../sessionManager/sessionWorkingDirectory'
import { PathCompare } from '../../shared/pathCompare'
import { WorktreePublication } from '../worktreePublication'
import type { WorktreeLifecycle } from '../worktreeState'

export class FinishCompletion {
  private readonly deps: Pick<FinishDriverDeps, 'changed' | 'ended' | 'landedDue' | 'now' | 'proposalsSpent' | 'records' | 'removal' | 'results' | 'steps' | 'stop' | 'stopRun' | 'awaitExit' | 'svn'>
  private readonly state: Pick<FinishState, 'write' | 'wait'>
  private readonly endings = new Map<string, SvnFinishWorktreeResult>()
  private readonly stopHelper: (record: SessionRecord) => Promise<void>

  constructor(deps: FinishCompletion['deps'], state: FinishCompletion['state'], stopHelper: FinishCompletion['stopHelper']) {
    this.deps = deps
    this.state = state
    this.stopHelper = stopHelper
  }

  async stop(sessionId: string): Promise<boolean> {
    await this.stopHelper(this.deps.records.get(sessionId)!)
    const record = this.deps.records.get(sessionId)!
    const root = record.worktree?.worktreePath
    for (const run of this.deps.records.list()) {
      if (root === undefined || run.scriptOf?.sessionId !== sessionId || run.scriptOf.scriptId !== 'requested'
        || !PathCompare.isInside(root, SessionWorkingDirectory.ofRecord(run))) continue
      if (!await this.deps.stopRun(run.sessionId)) {
        await this.state.wait(sessionId, 'removal-blocked', `Publication is retained. Stop the worktree run ${run.title} (${run.sessionId}) before cleanup.`)
        return false
      }
      if (!await this.deps.awaitExit(run.sessionId)) {
        await this.state.wait(sessionId, 'removal-blocked', `Publication is retained. The worktree run ${run.title} (${run.sessionId}) has not exited yet.`)
        return false
      }
    }
    if (record.life === 'live' || record.life === 'starting') {
      const stopped = await this.deps.stop(sessionId)
      // The Host refuses a stop whose owned children survive and names them; the worktree stays for them.
      if (!stopped.ok) { await this.state.wait(sessionId, 'removal-blocked', `The worker did not stop, so the worktree stays: ${stopped.detail}`); return false }
    }
    if (!await this.deps.awaitExit(sessionId)) { await this.state.wait(sessionId, 'removal-blocked', 'The worker process tree is still stopping'); return false }
    await this.state.write(sessionId, (current) => ({ ...current, step: 'removing', facts: { ...current.facts, worker: { ...current.facts.worker, liveness: 'stopped' } } }))
    return true
  }

  async remove(sessionId: string): Promise<void> {
    await this.observeRemaining(sessionId)
    const record = this.deps.records.get(sessionId)!
    const state = record.worktreeLifecycle!
    if (state.removalPermit === undefined) throw new Error('Removal requires a saved permit')
    await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!, removalAt: this.deps.now() } }))
    let removed: { state: SvnFinishWorktreeResult; lines: string[] }
    // The removal names each of its phases as the session's step; its caller ends the step.
    try {
      removed = record.worktree === undefined ? { state: 'removed' as const, lines: [] }
        : await this.deps.removal.remove(sessionId, SvnWorktreeRemoval.locationOf(record.worktree), WorktreePublication.retain(state).publication!.revisions.map(SvnRevisionLabels.textOf), state.removalPermit, state.actionId!)
    } finally { if (this.deps.steps.clear(sessionId)) this.deps.changed() }
    await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!, removal: removed.state, removalLines: removed.lines } }))
    if (removed.state !== 'removed') { await this.state.wait(sessionId, 'removal-blocked', removed.lines.join('\n')); await this.recordResult(sessionId, undefined, true); return }
    await this.state.write(sessionId, (current) => ({ ...current, step: 'recording' }))
  }

  async recordResult(sessionId: string, explicit?: 'kept', waiting = false): Promise<void> {
    if (explicit !== 'kept') await this.observeRemaining(sessionId)
    const record = this.deps.records.get(sessionId)!
    const state = record.worktreeLifecycle!
    const action = state.execution!
    const place = record.worktree ?? record.retiredWorktree
    const evidence = WorktreePublication.retain(state).publication!.revisions
    const published = evidence.length > 0
    const complete = WorktreePublication.complete(state)
    const result = published ? complete ? 'committed' : 'partial' : explicit
      ?? (state.purpose === 'discard' ? action.neverStartedReason === undefined ? 'discarded' : 'never-started' : 'nothing')
    const removal = explicit === 'kept' ? 'kept' : action.removal ?? 'in-use'
    const main = record.worktree?.repositoryRoot ?? record.retiredWorktree?.ownerDir ?? ''
    const logs = await this.deps.results.keepLogs(state.actionId!, sessionId, record.scriptRuns ?? [])
    const fixed = SvnConflictWords.resultLinesOf(state.syncConflictSet?.entries ?? [])
    const messages = FinishCompletion.messagesOf(state, evidence)
    const own = action.roots?.find((root) => root.own === '')?.bounds?.repository
    // With several repositories the top-level message is a hidden one; the worktree's own repository says what was published.
    const ownReview = state.review?.repositories?.find((row) => row.repository === own)
    const lines = [...action.neverStartedReason !== undefined ? [action.neverStartedReason] : FinishCompletion.endingLinesOf(result, removal === 'kept',
      state.purpose === 'discard', evidence, WorktreePublication.mountsOf(state), SvnConflictWords.remainingOf(WorktreePublication.retain(state).publication!.remaining ?? [], state.syncConflictSet?.entries ?? []),
      WorktreePublication.uncertain(state)), ...fixed, ...action.removalLines ?? [],
      ...(state.checks?.overridden ? ['checks-failed: explicitly accepted by the person'] : [])]
    if (!await this.deps.results.put(WorktreeResultsStore.recordOf({ actionId: state.actionId!, action: state.purpose ?? 'finish', result,
      sessionId, title: record.title, worktreePath: action.root, mainCopy: main, directoryId: place?.directoryId ?? null,
      removal: WorktreeResultsStore.removalOf(removal), revisions: evidence, lines, logs, at: this.deps.now(), caller: place?.caller,
      message: [...messages].reverse().find((row) => row.repository === own)?.message ?? state.review?.message ?? action.commit?.message,
      ...messages.length === 0 ? {} : { messages }, messageSource: result === 'kept' ? 'kept-attempt' : ownReview?.source ?? state.review?.source ?? action.commit?.messageSource ?? 'unknown',
      acknowledgedFindings: ownReview?.acknowledged ?? state.review?.acknowledged ?? action.commit?.acknowledgedFindings }))) throw new Error('The durable worktree result could not be saved')
    await this.deps.records.update(sessionId, (latest) => ({ ...latest, worktreeOutcome: { result: result === 'kept' ? 'not-committed' : result === 'never-started' || result === 'discarded' ? 'nothing' : result, revisions: evidence.map(SvnRevisionLabels.textOf),
      main: latest.worktreeOutcome?.main ?? 'none', worktree: removal, lines, at: this.deps.now(), labelled: evidence } }))
    if (published) this.deps.landedDue(main)
    if (waiting || explicit === 'kept') return
    await this.deps.records.update(sessionId, (latest) => {
      const next = { ...latest, svnAction: latest.svnAction?.kind === 'update-main' ? latest.svnAction : undefined,
        worktreeLifecycle: { ...latest.worktreeLifecycle!, version: latest.worktreeLifecycle!.version + 1,
          phase: state.purpose === 'discard' ? 'removed' as const : 'landed' as const, step: undefined, wait: undefined } }
      return latest.retiredWorktree === undefined || evidence.length === 0 ? next : LandedRows.retiredOf(next, main, evidence)
    })
    this.endings.set(sessionId, removal)
    this.endings.set(state.actionId!, removal)
    if (result === 'committed') this.deps.proposalsSpent(sessionId, [action.root, ...action.roots?.map((root) => root.path) ?? []])
    if (!published) this.deps.ended(sessionId)
  }

  endingOf(id: string): SvnFinishWorktreeResult | null { return this.endings.get(id) ?? null }

  /**
   * The first lines people read: how the worktree was left, which repository received which
   * revision, and the paths no repository received. The worktree's path is the result's own field.
   * `uncertain` names revisions an interrupted commit may have landed as: no line says nothing landed.
   */
  private static endingLinesOf(result: WorktreeResultKind, kept: boolean, discarded: boolean,
    evidence: readonly SvnLabelledRevision[], mounts: ReadonlyMap<string, string>, remaining: readonly string[], uncertain: readonly string[]): string[] {
    const revisions = evidence.map((entry) => SvnRevisionLabels.nameOf(entry, mounts)).join(', ')
    let published: string
    switch (result) {
      case 'committed': published = `Published: ${revisions}`; break
      case 'partial': published = `Partly published: ${revisions}`; break
      case 'kept': case 'discarded': case 'nothing': case 'not-committed': published = uncertain.length === 0 ? 'Nothing published' : 'No publication proven'; break
      case 'never-started': published = 'Never started; nothing published'; break
      case 'failed': published = 'Failed; nothing published'; break
      default: throw new Error(`Unknown worktree result: ${JSON.stringify(result satisfies never)}`)
    }
    const place = kept ? 'Worktree kept. ' : discarded ? 'Worktree discarded. ' : ''
    const unproven = uncertain.length === 0 ? []
      : [`May have landed, not proven ours: ${uncertain.join('; ')}. Inspect them before publishing these changes again.`]
    if (remaining.length === 0) return [`${place}${published}`, ...unproven]
    const paths = `${remaining.slice(0, FinishCompletion.pathsShownConst).join(', ')}${remaining.length > FinishCompletion.pathsShownConst ? ', …' : ''}`
    return [`${place}${published}`, ...unproven, `${uncertain.length === 0 ? 'Not published' : 'Not proven published'}${kept ? ', left in the worktree' : ''}: ${paths}`]
  }

  private static readonly pathsShownConst = 20

  /**
   * The message each published revision was committed with, from the journaled commit intent: the
   * approved draft may be older than a later approval, and it holds no message for an external.
   * A revision an earlier action of this worktree published keeps its message and names that action;
   * this action's roots no longer list its mount, so its verified proof binds the mount to the repository.
   */
  private static messagesOf(state: WorktreeLifecycle, evidence: readonly SvnLabelledRevision[]): WorktreeResultCommitMessage[] {
    const publication = WorktreePublication.retain(state).publication
    const roots = FinishCompletion.rootsOf(state)
    return evidence.flatMap((revision) => {
      const entry = [...state.journal].reverse().find((entry) => entry.kind === 'commit' && entry.revision === revision.revision && entry.message !== undefined
        && entry.recovered !== 'not-landed' && roots.some((root) => root.repository === revision.repository && entry.cwd !== undefined
          && PathCompare.comparable(root.path) === PathCompare.comparable(entry.cwd)))
      if (entry === undefined) return []
      const adoptedFrom = state.actionId !== null && entry.stepId.startsWith(`${state.actionId}-`) ? undefined
        : publication?.savedActions.find((actionId) => entry.stepId.startsWith(`${actionId}-`))
      // This action's review says who wrote the message; an adopted revision's review is gone.
      const reviewed = adoptedFrom === undefined ? state.review?.repositories?.find((row) => row.repository === revision.repository
        && PathCompare.comparable(row.root) === PathCompare.comparable(entry.cwd!)) : undefined
      return [{ repository: revision.repository, revision: revision.revision, message: entry.message!, ...adoptedFrom === undefined ? {} : { adoptedFrom },
        ...reviewed === undefined ? {} : { source: reviewed.source, acknowledgedFindings: reviewed.acknowledged } }]
    })
  }

  /** Each working copy the worktree published from, by its mount: the action's roots, and the mounts an earlier action's proofs bind. */
  private static rootsOf(state: WorktreeLifecycle): { path: string; own: string; repository: string }[] {
    const top = state.execution?.root
    return [...(state.execution?.roots ?? []).flatMap((root) => root.bounds === undefined ? [] : [{ path: root.path, own: root.own, repository: root.bounds.repository }]),
      ...(WorktreePublication.retain(state).publication?.proofs ?? []).flatMap((proof) => proof.repository === undefined ? []
        : [{ path: proof.root, own: top === undefined ? proof.root : relative(top, proof.root).replace(/\\/g, '/'), repository: proof.repository }])]
  }

  private async observeRemaining(sessionId: string): Promise<void> {
    const record = this.deps.records.get(sessionId)!
    const root = record.worktree?.worktreePath
    if (root === undefined || !await this.deps.svn.present(root)) return
    const changes = await this.deps.svn.changes(root)
    if (!changes.ok) throw new Error(changes.detail)
    await this.state.write(sessionId, (current) => ({ ...current,
      publication: { ...WorktreePublication.retain(current).publication!, remaining: SvnWorktreeEvidence.unpublished(changes.value) } }))
  }
}
