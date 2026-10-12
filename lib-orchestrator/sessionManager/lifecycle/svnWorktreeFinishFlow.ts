import { randomUUID } from 'node:crypto'

import type { SvnWorktreeLocation } from '../../svn/svn.types'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { ErrorText } from '../../shared/errorText'
import type {
  SessionRecord,
  SessionRecordWorktree,
  SessionRecordWorktreeCleanup,
} from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import { type WorktreeResultsPort, WorktreeResultsStore } from '../results/worktreeResultsStore'
import type {
  SessionFinishChoice,
  SessionsOpErrorCode,
  SessionFinishPress,
  SessionsOpResult,
  SessionWorktreeInfo,
  SvnFinishWorktreeResult,
  SvnLabelledRevision,
} from '../sessionManagerApi.types'
import { LandedRows } from './landedRows'
import { SvnRevisionLabels } from './svnRevisionLabels'
import { SvnWorktreeRemoval } from './svnWorktreeRemoval'
import type {
  WorktreeChoicesInput,
  WorktreeEnded,
  WorktreeFinishFacts,
  WorktreeFinisher,
} from './worktreeFinish.types'
import { WorktreeCleanupPacing } from './worktreeCleanupPacing'

/** The svn reads the cleanup and the facts make, named so a test can hand them a scripted set. */
export type SvnCleanupPort = Pick<SvnWorktreeManager, 'changes' | 'present' | 'facts'>

/** The SVN action of the lifecycle, as this facade reaches it. */
export interface SvnActionsPort {
  /** A press, on the operation queue. */
  start(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ actionId: string | null }>>
  /** Drives the action until it waits on a run or the person, or ended; how its removal went, if it ended. */
  settled(sessionId: string): Promise<SvnFinishWorktreeResult | null>
}

export interface SvnWorktreeFinishFlowDeps {
  records: SessionRecordsStore
  svn: SvnCleanupPort
  removal: Pick<SvnWorktreeRemoval, 'remove'>
  actions: SvnActionsPort
  /** What a worktree committed, read before the cleanup removes it. */
  labels: Pick<SvnRevisionLabels, 'ownCommits'>
  /** A cleanup finishes the result its Finish wrote, or writes its own. */
  results: WorktreeResultsPort
  /** Commit opens reviews in the commit dialog through the Jamat CLI; null when both are there. */
  finishRefusal: () => SessionsOpResult<never> | null
  /** The record moved outside an operation, so the snapshot is composed again. */
  changed: () => void
  /** A cleanup or a Discard that removed the worktree. */
  ended: WorktreeEnded
  /** A cleanup removed a worktree that committed: its session stays as a landed row of this main copy. */
  landedDue: (mainCopy: string) => void
  report: (message: string) => void
  now?: () => number
  newId?: () => string
}

/**
 * The SVN `WorktreeFinisher`: Finish, Keep and Discard are presses of an SVN action
 * (`SvnActionFlow`), which stops the session, runs the project's checks itself and answers once the
 * action is written. This class also owns the removal after the session's end (Jamat#37), which
 * never runs beside an action or another removal of the same worktree. A removal of a worktree that
 * committed leaves its session as a landed row, as a committed Finish does.
 */
export class SvnWorktreeFinishFlow implements WorktreeFinisher {
  readonly ownsChecks = true
  private readonly records: SessionRecordsStore
  private readonly svn: SvnCleanupPort
  private readonly removal: Pick<SvnWorktreeRemoval, 'remove'>
  private readonly actions: SvnActionsPort
  private readonly labels: Pick<SvnRevisionLabels, 'ownCommits'>
  private readonly results: WorktreeResultsPort
  private readonly refusalOf: () => SessionsOpResult<never> | null
  private readonly changed: () => void
  private readonly ended: WorktreeEnded
  private readonly landedDue: (mainCopy: string) => void
  private readonly report: (message: string) => void
  private readonly now: () => number
  private readonly newId: () => string
  /** Sessions a cleanup of this process judges now. */
  private readonly inFlight = new Set<string>()
  /** The cleanups running now, each settled once it let go of `inFlight`; a press waits for it. */
  private readonly cleaning = new Map<string, Promise<void>>()

  constructor(deps: SvnWorktreeFinishFlowDeps) {
    this.records = deps.records
    this.svn = deps.svn
    this.removal = deps.removal
    this.actions = deps.actions
    this.labels = deps.labels
    this.results = deps.results
    this.refusalOf = deps.finishRefusal
    this.changed = deps.changed
    this.ended = deps.ended
    this.landedDue = deps.landedDue
    this.report = deps.report
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? randomUUID
  }

  /** A press of Commit, Keep or Discard; a cleanup that removed the worktree meanwhile leaves nothing to do. */
  async finish(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ actionId: string | null }>> {
    if (await this.afterCleanup(sessionId)) return { ok: true, value: { actionId: null } }
    return this.actions.start(sessionId, press)
  }

  finishRefusal(): SessionsOpResult<never> | null {
    return this.refusalOf()
  }

  /**
   * The Discard of `sessions.discardWorktree`: the worktree goes whatever it holds, and the answer
   * waits for the removal, as it did before the action existed. A running session is refused; the
   * window's Discard stops it first through `finish`.
   */
  async discard(sessionId: string): Promise<SessionsOpResult> {
    if (await this.afterCleanup(sessionId)) return { ok: true, value: undefined }
    const record = this.records.get(sessionId)
    if (record?.life === 'live' || record?.life === 'starting')
      return { ok: false, code: 'live-refused', detail: 'This session is still running; stop it first' }
    const started = await this.actions.start(sessionId, { choice: 'discard', requestedBy: 'cli' })
    if (!started.ok) return started
    const removal = await this.actions.settled(sessionId)
    if (removal === 'removed') return { ok: true, value: undefined }
    const outcome = this.records.get(sessionId)?.svnAction?.needs?.reason
    const code = SvnWorktreeFinishFlow.removalCodeOf(removal ?? 'kept') ?? 'svn-failed'
    return { ok: false, code, detail: outcome ?? `The Discard of ${record?.worktree?.worktreePath ?? sessionId} left the worktree ${removal ?? 'in place'}` }
  }

  /** Ends an action that waits for the person; the worktree stays. */
  async keep(sessionId: string): Promise<SessionsOpResult> {
    const kept = await this.actions.start(sessionId, { choice: 'keep', requestedBy: 'window' })
    return kept.ok ? { ok: true, value: undefined } : kept
  }

  /**
   * The removal after the session's process ended, judged once per due attempt. A change left in
   * the worktree keeps it for good (`kept`): only a worktree with nothing left in it can go without
   * losing work. The checks read local state only; the removal is the one of an action, by identity
   * and after a re-read on the queue.
   */
  async cleanUp(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId)
    const worktree = record?.worktree
    const cleanup = record?.worktreeCleanup
    if (!record || !worktree || worktree.kind !== 'svn' || cleanup?.phase !== 'pending') return
    if (record.life === 'live' || record.life === 'starting' || record.svnAction !== undefined || this.inFlight.has(sessionId)) return
    this.inFlight.add(sessionId)
    let release!: () => void
    this.cleaning.set(sessionId, new Promise<void>((resolve) => { release = resolve }))
    this.changed()
    try {
      const location = SvnWorktreeRemoval.locationOf(worktree)
      // A run after an unfinished Discard made work that Discard never threw away.
      const checksChanges = WorktreeCleanupPacing.checksChanges(cleanup.trigger)
        || WorktreeCleanupPacing.ranSince(record, cleanup.requestedAt)
      // A worktree already gone has nothing to judge; the removal finishes its own leftover.
      const present = await this.svn.present(location.worktreePath)
      if (checksChanges && present) {
        const kept = await this.keeps(location)
        if (kept !== null) return await this.noteCleanup(sessionId, kept)
      }
      // A Finish or Discard that left the worktree to this removal already wrote the result.
      const unfinished = this.results.pendingRemovalsOf(sessionId)
      const labelled = unfinished.length === 0 && present ? await this.ownCommits(record, location.worktreePath) : []
      const removal = await this.removal.remove(sessionId, location, labelled.map(SvnRevisionLabels.textOf))
      if (removal.state === 'removed') {
        for (const actionId of unfinished) await this.results.removalDone(actionId)
        if (unfinished.length === 0) await this.cleanupResult(record, worktree, labelled)
        // What a Finish that left the removal here committed, or what this worktree committed itself.
        const landed = [...this.results.landedOf(unfinished), ...labelled]
        if (landed.length > 0 && await this.landedRow(sessionId, worktree.repositoryRoot, landed)) this.landedDue(worktree.repositoryRoot)
        else this.ended(sessionId)
      }
      else if (removal.state === 'in-use') await this.noteCleanup(sessionId, { phase: 'pending', reason: 'in use' })
      else if (removal.state === 'undeleted') await this.noteCleanup(sessionId, { phase: 'pending', reason: 'undeleted' })
      else if (removal.state === 'kept') {
        // A reopen won the race; its next end judges the worktree again.
        const now = this.records.get(sessionId)
        if (now && now.life !== 'live' && now.life !== 'starting' && now.pendingOperationId === undefined)
          await this.noteCleanup(sessionId, { phase: 'pending', reason: removal.lines.join(' ') })
      }
      else throw new Error(`Unknown worktree removal: ${JSON.stringify(removal.state satisfies never)}`)
    } finally {
      this.inFlight.delete(sessionId)
      this.cleaning.delete(sessionId)
      release()
      this.changed()
    }
  }

  /** The tombstone the removal wrote becomes a landed row; false when the record is gone or cannot be written. */
  private async landedRow(sessionId: string, ownerDir: string, landed: readonly SvnLabelledRevision[]): Promise<boolean> {
    return this.records.update(sessionId, (latest) => latest.retiredWorktree === undefined || latest.worktree !== undefined
      ? null
      : LandedRows.retiredOf(latest, ownerDir, landed))
  }

  /** Whether this client judges the removal of the session's worktree now; a press waits for it. */
  cleaningNow(sessionId: string): boolean {
    return this.cleaning.has(sessionId)
  }

  async facts(worktree: SessionRecordWorktree): Promise<WorktreeFinishFacts> {
    const capturedAt = this.now()
    const facts = await this.svn.facts(worktree.worktreePath)
    return { diff: facts.ok ? { ...facts.value, capturedAt } : null, baseMoved: false }
  }

  choicesOf(input: Pick<WorktreeChoicesInput, 'record' | 'diff'>): readonly SessionFinishChoice[] {
    return SvnWorktreeFinishFlow.choicesFor(input.record, input.diff, this.cleaning.has(input.record.sessionId))
  }

  /**
   * Commit only while the worktree may hold something to land. After a confirmed end the pending
   * cleanup removes a clean worktree and keeps a changed one, so while it owns the removal Commit
   * waits for a measured change.
   */
  static choicesFor(record: SessionRecord, diff: SessionWorktreeInfo['diff'], cleaning: boolean): readonly SessionFinishChoice[] {
    return cleaning || SvnWorktreeFinishFlow.cleanupOwns(record, diff) ? ['keep', 'discard'] : ['commit', 'keep', 'discard']
  }

  private static cleanupOwns(record: SessionRecord, diff: SessionWorktreeInfo['diff']): boolean {
    const cleanup = record.worktreeCleanup
    if (cleanup?.phase !== 'pending' || !WorktreeCleanupPacing.processGone(record) || record.svnAction !== undefined) return false
    return diff === null || diff.changedFiles === 0
  }

  /**
   * A press while the cleanup judges the worktree waits for it instead of running svn beside its
   * removal. True: the cleanup removed the worktree, so nothing is left to finish.
   */
  private async afterCleanup(sessionId: string): Promise<boolean> {
    const running = this.cleaning.get(sessionId)
    if (running === undefined) return false
    await running
    return this.records.get(sessionId)?.worktree === undefined
  }

  /** What the worktree committed itself and through its split; an unreadable answer proves nothing and keeps nothing. */
  private async ownCommits(record: SessionRecord, worktreePath: string): Promise<SvnLabelledRevision[]> {
    const own = await this.labels.ownCommits(worktreePath, record.commitReceipts, record.createdAt)
    return own.ok ? own.value : []
  }

  /**
   * A worktree that committed (labelled revisions, or receipts of its split) gets a `cleanup` result;
   * one that never committed ends without a result, as it ended before results existed.
   */
  private async cleanupResult(record: SessionRecord, worktree: SessionRecordWorktree, labelled: SvnLabelledRevision[]): Promise<void> {
    if (labelled.length === 0 && (record.commitReceipts ?? []).length === 0) return
    const committed = labelled.length > 0
    try {
      const written = await this.results.put(WorktreeResultsStore.recordOf({
        actionId: this.newId(),
        action: 'cleanup',
        result: committed ? 'committed' : 'nothing',
        sessionId: record.sessionId,
        title: record.title,
        worktreePath: worktree.worktreePath,
        mainCopy: worktree.repositoryRoot,
        directoryId: worktree.directoryId ?? null,
        removal: 'removed',
        revisions: labelled,
        lines: [
          committed
            ? `-> committed ${labelled.map(SvnRevisionLabels.textOf).join(', ')} from ${worktree.worktreePath}`
            : `NOTHING PROVEN: the receipts of ${worktree.worktreePath} name no revision`,
          '   worktree removed after the session',
        ],
        logs: [],
        at: this.now(),
        caller: worktree.caller,
      }))
      if (!written) this.report(`Session ${record.sessionId}: the result of its worktree cleanup was not written`)
    } catch (error) {
      this.report(`Session ${record.sessionId}: the result of its worktree cleanup was not written: ${ErrorText.of(error)}`)
    }
  }

  /** Why the cleanup keeps the worktree, or null when it may go. Unversioned files count, ignored ones do not. */
  private async keeps(location: SvnWorktreeLocation): Promise<Pick<SessionRecordWorktreeCleanup, 'phase' | 'reason'> | null> {
    const changes = await this.svn.changes(location.worktreePath)
    if (!changes.ok) return { phase: 'pending', reason: `svn status failed: ${changes.detail}` }
    if (changes.value.length > 0) return { phase: 'kept', reason: `${changes.value.length} change${changes.value.length === 1 ? '' : 's'}` }
    return null
  }

  /** The verdict lands on the cleanup the record holds now, so a trigger written meanwhile keeps its own fields. */
  private async noteCleanup(sessionId: string, verdict: Pick<SessionRecordWorktreeCleanup, 'phase' | 'reason'>): Promise<void> {
    const current = this.records.get(sessionId)
    if (!current?.worktreeCleanup) return
    await this.records.put({ ...current, worktreeCleanup: { ...current.worktreeCleanup, ...verdict } })
    this.changed()
  }

  private static removalCodeOf(state: SvnFinishWorktreeResult): SessionsOpErrorCode | null {
    if (state === 'removed') return null
    else if (state === 'in-use') return 'locked'
    else if (state === 'kept' || state === 'undeleted') return 'svn-failed'
    else throw new Error(`Unknown worktree removal: ${JSON.stringify(state satisfies never)}`)
  }
}
