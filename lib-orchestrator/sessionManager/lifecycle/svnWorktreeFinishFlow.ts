import type {
  SvnBounds,
  SvnLoggedRow,
  SvnMainState,
  SvnRoot,
  SvnWorktreeLocation,
} from '../../svn/svn.types'
import { SvnWorktreeEvidence } from '../../svn/svnWorktreeEvidence'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import type {
  SessionRecord,
  SessionRecordWorktree,
  SessionRecordWorktreeCleanup,
  SessionRecordWorktreeFinish,
  SessionWorktreeCleanupTrigger,
} from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import { SessionTitle } from '../records/sessionTitle'
import type {
  SessionFinishChoice,
  SessionsOpErrorCode,
  SessionsOpResult,
  SessionWorktreeOutcome,
  SvnFinishResult,
  SvnFinishWorktreeResult,
} from '../sessionManagerApi.types'
import { SvnCodes } from './svnCodes'
import type { SessionReviewPort, SessionReviewSettled } from '../sessionReviewPort.types'
import type { WorktreeEnded, WorktreeFinishFacts, WorktreeFinisher } from './worktreeFinish.types'
import { WorktreeCleanupPacing } from './worktreeCleanupPacing'

/** The svn calls a finish makes, named so a test can hand it a scripted set instead. */
export type SvnFinishPort = Pick<SvnWorktreeManager,
  | 'ownerCheck' | 'roots' | 'recoverable' | 'updateWorktree' | 'lowerBounds' | 'proven' | 'reviewed'
  | 'changes' | 'updateMain' | 'renameAside' | 'purgeAside' | 'removeEmptyWorktreesDir' | 'facts' | 'unlanded' | 'present'>

export interface SvnWorktreeFinishFlowDeps {
  records: SessionRecordsStore
  svn: SvnFinishPort
  /** Read when a Commit starts: the client binds its commit dialog after it built the sessions. */
  reviewOf: () => SessionReviewPort | null
  /** Lets go of what this client itself holds below a path, so the rename probe meets only others. */
  releaseBelow: (path: string) => Promise<void>
  /** The queue reopen and restart run on, so a removal never races one. */
  onQueue: <T>(work: () => Promise<T>) => Promise<T>
  detach: (work: Promise<unknown>, what: string) => void
  /** A fact the person must know that no caller is waiting to be told. */
  report: (message: string) => void
  /** The record moved outside an operation, so the snapshot is composed again. */
  changed: () => void
  /** Only after `committed` or `nothing` with the main copy taken and the worktree removed, a Discard or a cleanup that removed it. */
  ended: WorktreeEnded
  now?: () => number
}

/** A commit of this worktree, by the repository it went to. */
interface Revision {
  repository: string
  revision: number
}

interface Recovery {
  revisions: Revision[]
  count: number
  main: SvnMainState
  lines: string[]
}

/** What a finish has landed so far, so a finish cut short by a throw still names it. */
interface Progress {
  revisions: Revision[]
  main: SvnMainState
}

type Proof = { ok: true; rows: SvnLoggedRow[] } | { ok: false; lines: string[] }

type Removal = { state: SvnFinishWorktreeResult; lines: string[] }

interface ReviewRun {
  sessionId: string
  review: SessionReviewPort
  location: SvnWorktreeLocation
  roots: readonly SvnRoot[]
  bounds: SvnBounds
  recovery: Recovery
  progress: Progress
  proposal: string
  commitSessionId: string
}

interface FinishOutcome {
  result: SvnFinishResult
  revisions: readonly Revision[]
  main: SvnMainState
  worktree: SvnFinishWorktreeResult
  lines: readonly string[]
}

/**
 * Finish Commit and Discard of an SVN worktree session: the TypeScript twin of the bash helper's
 * `worktree-finish` v2 and `worktree-remove --discard` (`docs/architecture/svn-worktrees.md`).
 *
 * The order is the mechanism. This worktree's own commits the main copy lacks land there first
 * (RECOVERED). The worktree then takes in everyone else's commits, so the review shows only this
 * session's change set; an incoming change to the same project stops the finish, because the tests
 * ran without it. Changed external mounts are reviewed first, each from its mount, because a parent
 * review refuses a changed external. What a review committed is proven by the revision it reports,
 * confirmed by `svn log -v`; without that receipt, by the worktree's own BASE. The main copy takes
 * the committed paths before anything is deleted, and only `committed` and `nothing` remove the
 * worktree.
 *
 * A Commit answers once the first review is open; the person works in it while the rest runs
 * detached and lands on `worktreeOutcome`. The phase on the record is write-ahead evidence, never a
 * program counter: a client that stops mid-finish leaves it behind, the next load reads it as
 * `interrupted`, and the next Finish recovers from the disk.
 */
export class SvnWorktreeFinishFlow implements WorktreeFinisher {
  private static readonly listedPathsConst = 20
  private readonly records: SessionRecordsStore
  private readonly svn: SvnFinishPort
  private readonly reviewOf: () => SessionReviewPort | null
  private readonly releaseBelow: (path: string) => Promise<void>
  private readonly onQueue: <T>(work: () => Promise<T>) => Promise<T>
  private readonly detach: (work: Promise<unknown>, what: string) => void
  private readonly report: (message: string) => void
  private readonly changed: () => void
  private readonly ended: WorktreeEnded
  private readonly now: () => number
  /** Sessions a Commit or Discard of this process is working on, before and after its record says so. */
  private readonly inFlight = new Set<string>()
  /** One writer of a main copy at a time; a review wait never holds it. */
  private readonly ownerTurns = new Map<string, Promise<void>>()
  private readonly stopping = new AbortController()

  constructor(deps: SvnWorktreeFinishFlowDeps) {
    this.records = deps.records
    this.svn = deps.svn
    this.reviewOf = deps.reviewOf
    this.releaseBelow = deps.releaseBelow
    this.onQueue = deps.onQueue
    this.detach = deps.detach
    this.report = deps.report
    this.changed = deps.changed
    this.ended = deps.ended
    this.now = deps.now ?? (() => Date.now())
  }

  async finish(sessionId: string): Promise<SessionsOpResult> {
    const refusal = this.refusal(sessionId)
    if (refusal) return refusal
    const review = this.reviewOf()
    if (review === null)
      return {
        ok: false,
        code: 'review-unavailable',
        detail: 'Commit needs the AppJamatV3 commit dialog, and this client has none; Keep and Discard still work',
      }
    this.inFlight.add(sessionId)
    const handoff = { detached: false }
    const progress: Progress = { revisions: [], main: 'none' }
    try {
      return await this.begin(sessionId, review, handoff, progress)
    } catch (error) {
      await this.endAfterThrow(sessionId, error, progress)
      throw error
    } finally {
      if (!handoff.detached) this.inFlight.delete(sessionId)
    }
  }

  /** The worktree goes whatever it holds: the person chose to throw the changes away. */
  async discard(sessionId: string): Promise<SessionsOpResult> {
    const refusal = this.refusal(sessionId)
    if (refusal) return refusal
    this.inFlight.add(sessionId)
    try {
      const record = this.mustRecord(sessionId)
      const location = SvnWorktreeFinishFlow.locationOf(SvnWorktreeFinishFlow.worktreeOf(record))
      const removal = await this.remove(sessionId, location, [])
      await this.clearFinish(sessionId, 'the end of the Discard',
        SvnWorktreeFinishFlow.unfinished(removal.state) ? 'discard-unfinished' : undefined)
      const code = SvnWorktreeFinishFlow.removalCodeOf(removal.state)
      if (code !== null) return { ok: false, code, detail: removal.lines.join('\n') }
      this.ended(sessionId)
      return { ok: true, value: undefined }
    } catch (error) {
      await this.clearFinish(sessionId, 'the end of the Discard')
      throw error
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  /**
   * The removal after the session's process ended (Jamat#37), judged once per due attempt. It never
   * writes a main copy: a change left in the worktree keeps it for good (`kept`), and a commit of it
   * that the main copy lacks keeps it until the main copy holds that revision. The checks read local
   * state only; the removal is the one of a finish, by identity and after a re-read on the queue.
   */
  async cleanUp(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId)
    const worktree = record?.worktree
    const cleanup = record?.worktreeCleanup
    if (!record || !worktree || worktree.kind !== 'svn' || cleanup?.phase !== 'pending') return
    if (record.life === 'live' || record.life === 'starting' || record.worktreeFinish !== undefined || this.inFlight.has(sessionId)) return
    this.inFlight.add(sessionId)
    try {
      const location = SvnWorktreeFinishFlow.locationOf(worktree)
      // A run after an unfinished Discard made work that Discard never threw away.
      const checksChanges = WorktreeCleanupPacing.checksChanges(cleanup.trigger)
        || WorktreeCleanupPacing.ranSince(record, cleanup.requestedAt)
      // A worktree already gone has nothing to judge; the removal finishes its own leftover.
      if (checksChanges && await this.svn.present(location.worktreePath)) {
        const kept = await this.keeps(location)
        if (kept !== null) return await this.noteCleanup(sessionId, kept)
      }
      const removal = await this.remove(sessionId, location, [])
      await this.clearFinish(sessionId, 'the end of the cleanup')
      if (removal.state === 'removed') {
        // A main copy a Finish left in conflict or failed to update still needs the person, so the session stays.
        const main = this.records.get(sessionId)?.worktreeOutcome?.main ?? 'none'
        if (SvnWorktreeFinishFlow.problemOf({ main, worktree: 'removed' }) === null) this.ended(sessionId)
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
    } catch (error) {
      await this.clearFinish(sessionId, 'the end of the cleanup')
      throw error
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  async facts(worktree: SessionRecordWorktree): Promise<WorktreeFinishFacts> {
    const capturedAt = this.now()
    const facts = await this.svn.facts(worktree.worktreePath)
    return { diff: facts.ok ? { ...facts.value, capturedAt } : null, baseMoved: false }
  }

  choicesOf(): readonly SessionFinishChoice[] {
    return ['commit', 'keep', 'discard']
  }

  /** Stops waiting for reviews; a finish still waiting keeps its phase and loads as `interrupted`. */
  stop(): void {
    this.stopping.abort()
  }

  /** Steps 0 and 1, then the first review; what follows runs detached. */
  private async begin(
    sessionId: string,
    review: SessionReviewPort,
    handoff: { detached: boolean },
    progress: Progress,
  ): Promise<SessionsOpResult> {
    const record = this.mustRecord(sessionId)
    const location = SvnWorktreeFinishFlow.locationOf(SvnWorktreeFinishFlow.worktreeOf(record))
    const path = location.worktreePath
    const nothingRecovered: Recovery = { revisions: [], count: 0, main: 'none', lines: [] }
    if (!await this.phase(sessionId, { phase: 'updating' })) return SvnWorktreeFinishFlow.latched()
    const checked = await this.svn.ownerCheck(location)
    if (!checked.ok)
      return this.endEarly(sessionId, 'failed', nothingRecovered, [`REFUSED: ${checked.detail}`], SvnCodes.sessionCodeOf(checked.code))
    const recovery = await this.recover(location)
    if (!recovery.ok) return this.endEarly(sessionId, 'failed', nothingRecovered, recovery.lines, 'svn-failed')
    progress.revisions.push(...recovery.value.revisions)
    progress.main = recovery.value.main

    const update = await this.svn.updateWorktree(path)
    if (!update.ok)
      return this.endEarly(sessionId, 'failed', recovery.value, [update.detail], SvnCodes.sessionCodeOf(update.code))
    const state = update.value
    if (state.kind === 'conflict')
      return this.endEarly(sessionId, 'conflict', recovery.value, [
        `CONFLICT: ${path}`,
        ...SvnWorktreeFinishFlow.listed(state.paths),
        '  Resolve them there (Reopen the session, or an SVN client), then press Finish again. Nothing was committed.',
      ], 'worktree-conflict')
    else if (state.kind === 'updated')
      return this.endEarly(sessionId, 'updated', recovery.value, [
        `UPDATED to r${state.toRevision}: other commits changed the project of this change set:`,
        ...SvnWorktreeFinishFlow.listed(state.paths),
        '  Reopen the session to rerun the tests, or press Finish again to commit as it is. Nothing was committed.',
      ], 'worktree-updated')
    else if (state.kind !== 'current')
      throw new Error(`Unknown worktree update: ${JSON.stringify(state satisfies never)}`)

    if (state.changed.length === 0) {
      const committed = recovery.value.count > 0
      const line = committed
        ? `-> committed ${SvnWorktreeFinishFlow.revisionText(recovery.value.revisions)} from ${path}`
        : `NOTHING TO COMMIT: ${path} matches ${location.url}`
      const removal = await this.remove(sessionId, location, SvnWorktreeFinishFlow.revisionsOf(recovery.value.revisions))
      const outcome: FinishOutcome = {
        result: committed ? 'committed' : 'nothing',
        revisions: recovery.value.revisions,
        main: recovery.value.main,
        worktree: removal.state,
        lines: [...recovery.value.lines, line, ...removal.lines],
      }
      await this.end(sessionId, outcome)
      this.tell(sessionId, path, outcome)
      const code = SvnWorktreeFinishFlow.problemOf(outcome)
      if (code !== null) return { ok: false, code, detail: outcome.lines.join('\n') }
      this.ended(sessionId)
      return { ok: true, value: undefined }
    }

    const bounds = await this.svn.lowerBounds(state.roots)
    if (!bounds.ok)
      return this.endEarly(sessionId, 'failed', recovery.value, [`ERROR: svn cannot report the state of ${path}; the worktree is kept: ${bounds.detail}`], SvnCodes.sessionCodeOf(bounds.code))
    const proposal = SessionTitle.partsOf(record.title).name.trim() || record.title
    const opened = await this.openReview(sessionId, review, state.roots[0], proposal)
    if (!opened.ok)
      return this.endEarly(sessionId, 'failed', recovery.value, [`ERROR: the review of ${state.roots[0].path} could not be opened: ${opened.detail}`], opened.code)
    handoff.detached = true
    this.detach(
      this.reviewLoop({
        sessionId, review, location, roots: state.roots, bounds: bounds.value, recovery: recovery.value, progress, proposal,
        commitSessionId: opened.value.commitSessionId,
      })
        .catch(async (error: unknown) => {
          await this.endAfterThrow(sessionId, error, progress)
          throw error
        })
        .finally(() => { this.inFlight.delete(sessionId) }),
      `Finishing the worktree of session ${sessionId}`,
    )
    return { ok: true, value: undefined }
  }

  /** Steps 3 to 6: one review per changed root, mounts first, then the main copy and the removal. */
  private async reviewLoop(run: ReviewRun): Promise<void> {
    const { sessionId, review, location, roots, bounds, recovery, progress } = run
    const path = location.worktreePath
    const lines = [...recovery.lines]
    const revisions = progress.revisions
    const committed: string[] = []
    const landed: SvnLoggedRow[] = []
    let commitSessionId = run.commitSessionId
    let externalStop = false
    let proofFailure = false
    let outdated = false
    for (const [index, root] of roots.entries()) {
      const bound = bounds[root.own]
      if (index > 0) {
        const opened = await this.openReview(sessionId, review, root, run.proposal)
        if (!opened.ok) {
          lines.push(`ERROR: the review of ${root.path} could not be opened: ${opened.detail}`)
          proofFailure = true
          break
        }
        commitSessionId = opened.value.commitSessionId
      }
      let settled: SessionReviewSettled
      try {
        settled = await review.settled(commitSessionId, this.stopping.signal)
      } catch (error) {
        if (this.stopping.signal.aborted) return
        throw error
      }
      if (settled.state === 'failed' && settled.outOfDate) outdated = true
      const proof = await this.prove(root, bounds, settled)
      if (!proof.ok) {
        lines.push(...proof.lines)
        proofFailure = true
        break
      }
      const attribution = SvnWorktreeEvidence.attribution(root.changed, proof.rows)
      committed.push(...attribution.committed)
      revisions.push(...attribution.revisions.map((revision) => ({ repository: bound.repository, revision })))
      if (attribution.committed.length > 0) landed.push(...proof.rows)
      if (root.own === '') continue
      const rest = await this.svn.changes(root.path)
      if (rest.ok && rest.value.length === 0 && attribution.committed.length > 0) {
        const newest = Math.max(...revisions.filter((entry) => entry.repository === bound.repository).map((entry) => entry.revision))
        lines.push(`EXTERNAL PUBLISHED r${newest} ${SvnWorktreeFinishFlow.repositoryName(bound.repository)} ${attribution.committed.join(' ')}`)
        continue
      }
      const stop = attribution.committed.length === 0 ? `NOT COMMITTED: external ${root.own}` : `PARTIAL: external ${root.own}`
      lines.push(`${stop}; ${path} is kept and nothing outside that mount was reviewed`)
      externalStop = true
      break
    }

    // What SVN holds now decides the outcome; an unreadable state counts as a change left.
    const left = await this.svn.changes(path)
    const remaining = left.ok ? left.value.map((row) => row.path) : ['(svn status failed)']
    const result = SvnWorktreeFinishFlow.classify({
      proofFailure, outdated, landed: committed.length + recovery.count, remaining: remaining.length,
    })
    lines.push(...SvnWorktreeFinishFlow.resultLines(result, { path, revisions, remaining, proofFailure, externalStop }))

    if (committed.length > 0) {
      await this.phase(sessionId, { phase: 'main-updating' })
      const owner = location.ownerDir
      const updated = await this.underOwner(owner, () => this.svn.updateMain(owner, landed))
      const state: SvnMainState = updated.ok ? updated.value.main : 'failed'
      lines.push(...updated.ok ? updated.value.lines : [`MAIN UPDATE FAILED: ${updated.detail}`])
      progress.main = SvnWorktreeFinishFlow.worse(progress.main, state)
    }

    const removal = result === 'committed' || result === 'nothing'
      ? await this.remove(sessionId, location, SvnWorktreeFinishFlow.revisionsOf(revisions))
      : { state: 'kept' as const, lines: [] }
    lines.push(...removal.lines)
    const outcome: FinishOutcome = { result, revisions, main: progress.main, worktree: removal.state, lines }
    await this.end(sessionId, outcome)
    this.tell(sessionId, path, outcome)
    if ((result === 'committed' || result === 'nothing') && SvnWorktreeFinishFlow.problemOf(outcome) === null)
      this.ended(sessionId)
  }

  /** Step 0: per root, mounts first, this worktree's own commits the main copy lacks go there. */
  private async recover(location: SvnWorktreeLocation): Promise<{ ok: true; value: Recovery } | { ok: false; lines: string[] }> {
    const unread = (path: string, detail: string): { ok: false; lines: string[] } =>
      ({ ok: false, lines: [`ERROR: svn cannot report the state of ${path}; the worktree is kept: ${detail}`] })
    const roots = await this.svn.roots(location.worktreePath)
    if (!roots.ok) return unread(location.worktreePath, roots.detail)
    const rows: SvnLoggedRow[] = []
    const revisions: Revision[] = []
    const paths = new Map<string, string[]>()
    for (const root of roots.value) {
      const recovered = await this.svn.recoverable(root, location.ownerDir)
      if (!recovered.ok) return unread(root.path, recovered.detail)
      if (recovered.value.length === 0) continue
      const bounds = await this.svn.lowerBounds([root])
      if (!bounds.ok) return unread(root.path, bounds.detail)
      const repository = bounds.value[root.own].repository
      for (const row of recovered.value) {
        rows.push(row)
        revisions.push({ repository, revision: row.revision })
        const key = `${SvnWorktreeFinishFlow.repositoryName(repository)}:r${row.revision}`
        paths.set(key, [...paths.get(key) ?? [], row.path])
      }
    }
    if (rows.length === 0) return { ok: true, value: { revisions: [], count: 0, main: 'none', lines: [] } }
    const lines = SvnWorktreeFinishFlow.sortedRevisions(revisions)
      .map((entry) => `${SvnWorktreeFinishFlow.repositoryName(entry.repository)}:r${entry.revision}`)
      .map((key) => `RECOVERED ${key} ${(paths.get(key) ?? []).join(' ')}`)
    const owner = location.ownerDir
    const updated = await this.underOwner(owner, () => this.svn.updateMain(owner, rows))
    lines.push(...updated.ok ? updated.value.lines : [`MAIN UPDATE FAILED: ${updated.detail}`])
    return { ok: true, value: { revisions, count: rows.length, main: updated.ok ? updated.value.main : 'failed', lines } }
  }

  /**
   * A numeric revision is the receipt, once `svn log -v` confirms it below this root. A cancelled
   * review committed nothing. Anything else, a comma list of several scopes included, falls back to
   * the BASE proof; neither proves anything and the finish stops there.
   */
  private async prove(root: SvnRoot, bounds: SvnBounds, settled: SessionReviewSettled): Promise<Proof> {
    let why: string
    if (settled.state === 'cancelled') return { ok: true, rows: [] }
    else if (settled.state === 'committed') {
      const receipt = settled.revision.trim()
      if (/^[1-9]\d*$/.test(receipt)) {
        const reviewed = await this.svn.reviewed(root, bounds, Number(receipt))
        if (reviewed.ok) return { ok: true, rows: reviewed.value }
        why = reviewed.detail
      }
      else why = `the review committed ${receipt}, which is no receipt of one revision`
    }
    else if (settled.state === 'external-closed') why = 'the review was taken to an external SVN client'
    else if (settled.state === 'failed') why = settled.reason
    else if (settled.state === 'lost') why = 'the commit dialog no longer knows the review'
    else throw new Error(`Unknown review state: ${JSON.stringify(settled satisfies never)}`)
    const proven = await this.svn.proven(root, bounds)
    if (proven.ok) return { ok: true, rows: proven.value }
    return {
      ok: false,
      lines: [
        `UNVERIFIED: the review of ${root.path} has no review receipt and no BASE proof; the worktree is kept. `
        + 'Press Finish again once; it recovers proven commits first.',
        `  ${why}`,
        `  ${proven.detail}`,
      ],
    }
  }

  private async openReview(
    sessionId: string,
    review: SessionReviewPort,
    root: SvnRoot,
    proposal: string,
  ): Promise<SessionsOpResult<{ commitSessionId: string }>> {
    if (!await this.phase(sessionId, { phase: 'reviewing', scopeRoot: root.path })) return SvnWorktreeFinishFlow.latched()
    const opened = await review.open({ sessionId, scopeRoot: root.path, proposal })
    if (!opened.ok) return opened
    await this.phase(sessionId, { phase: 'reviewing', scopeRoot: root.path, commitSessionId: opened.value.commitSessionId })
    return opened
  }

  /**
   * Step 6, by identity: this client's own handles are released, the worktree is renamed aside (a
   * holder makes that fail, and then the worktree stays whole), the rest is purged, and the record
   * keeps a tombstone. The rename runs on the operation queue after a re-read, so a reopen that won
   * the race keeps its directory.
   */
  private async remove(sessionId: string, location: SvnWorktreeLocation, revisions: readonly string[]): Promise<Removal> {
    const path = location.worktreePath
    if (!await this.phase(sessionId, { phase: 'removing' }))
      return { state: 'kept', lines: ['ERROR: the session records could not be written; the worktree is kept'] }
    const renamed = await this.onQueue(async () => {
      const now = this.records.get(sessionId)
      if (!now || now.life === 'live' || now.life === 'starting' || now.pendingOperationId !== undefined) return null
      await this.releaseBelow(path)
      return this.svn.renameAside(location)
    })
    if (renamed === null) return { state: 'kept', lines: [`KEPT: session ${sessionId} runs again, so ${path} stays`] }
    if (!renamed.ok) return { state: 'kept', lines: [`ERROR: ${renamed.detail}; the worktree is kept`] }
    if (renamed.value === 'in-use')
      return { state: 'in-use', lines: [`IN USE: ${path} (a process has its working directory or an open file there; the worktree is kept)`] }
    else if (renamed.value !== 'renamed' && renamed.value !== 'absent')
      throw new Error(`Unknown rename result: ${JSON.stringify(renamed.value satisfies never)}`)
    const purged = await this.svn.purgeAside(location)
    if (!purged.ok || purged.value === 'undeleted')
      return {
        state: 'undeleted',
        lines: [`ERROR: ${path}.deleting is left half deleted${purged.ok ? '' : ` (${purged.detail})`}; Discard finishes it`],
      }
    await this.underOwner(location.ownerDir, () => this.svn.removeEmptyWorktreesDir(location.ownerDir))
    await this.onQueue(async () => {
      const current = this.records.get(sessionId)
      if (!current) return
      const next: SessionRecord = {
        ...current,
        retiredWorktree: {
          worktreePath: path,
          kind: 'svn',
          revisions: SvnWorktreeFinishFlow.joined(current.worktreeOutcome?.revisions ?? [], revisions),
          removedAt: this.now(),
        },
        completed: true,
      }
      delete next.worktree
      delete next.worktreeCleanup
      await this.records.put(next)
    })
    this.changed()
    return { state: 'removed', lines: ['   worktree removed'] }
  }

  /** Why the cleanup keeps the worktree, or null when it may go. Unversioned files count, ignored ones do not. */
  private async keeps(location: SvnWorktreeLocation): Promise<Pick<SessionRecordWorktreeCleanup, 'phase' | 'reason'> | null> {
    const changes = await this.svn.changes(location.worktreePath)
    if (!changes.ok) return { phase: 'pending', reason: `svn status failed: ${changes.detail}` }
    if (changes.value.length > 0) return { phase: 'kept', reason: `${changes.value.length} change${changes.value.length === 1 ? '' : 's'}` }
    const unlanded = await this.svn.unlanded(location.worktreePath, location.ownerDir)
    if (!unlanded.ok) return { phase: 'pending', reason: `svn status failed: ${unlanded.detail}` }
    if (unlanded.value.length > 0) return { phase: 'pending', reason: WorktreeCleanupPacing.unlandedReason(unlanded.value) }
    return null
  }

  /** The verdict lands on the cleanup the record holds now, so a trigger written meanwhile keeps its own fields. */
  private async noteCleanup(sessionId: string, verdict: Pick<SessionRecordWorktreeCleanup, 'phase' | 'reason'>): Promise<void> {
    const current = this.records.get(sessionId)
    if (!current?.worktreeCleanup) return
    await this.records.put({ ...current, worktreeCleanup: { ...current.worktreeCleanup, ...verdict } })
    this.changed()
  }

  /** What every refusal before the first svn call has in common. */
  private refusal(sessionId: string): SessionsOpResult | null {
    if (this.records.latched) return SvnWorktreeFinishFlow.latched()
    const record = this.records.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    if (!record.worktree) return { ok: false, code: 'invalid-spec', detail: 'This session has no worktree' }
    const kind = record.worktree.kind ?? 'git'
    if (kind === 'git')
      return { ok: false, code: 'invalid-spec', detail: `${record.worktree.worktreePath} is a Git worktree, not an SVN checkout` }
    else if (kind !== 'svn') throw new Error(`Unknown worktree kind: ${JSON.stringify(kind satisfies never)}`)
    // The removal takes the directory the session runs in.
    if (record.life === 'live' || record.life === 'starting')
      return { ok: false, code: 'live-refused', detail: 'This session is still running; stop it first' }
    if (this.inFlight.has(sessionId) || record.worktreeFinish !== undefined)
      return {
        ok: false,
        code: 'merge-pending',
        detail: `A finish of session ${sessionId} is already running${
          record.worktreeFinish === undefined ? '' : ` (${record.worktreeFinish.phase})`}`,
      }
    return null
  }

  /** Write-ahead: the record says what is being attempted before svn is run. */
  private async phase(
    sessionId: string,
    finish: Omit<SessionRecordWorktreeFinish, 'startedAt'>,
  ): Promise<boolean> {
    const current = this.records.get(sessionId)
    if (!current) return false
    const written = await this.records.put({
      ...current,
      worktreeFinish: { ...finish, startedAt: current.worktreeFinish?.startedAt ?? this.now() },
    })
    this.changed()
    return written
  }

  /** A finish that ended before any review: the answer carries the lines, and the record keeps them. */
  private async endEarly(
    sessionId: string,
    result: SvnFinishResult,
    recovery: Recovery,
    lines: readonly string[],
    code: SessionsOpErrorCode,
  ): Promise<SessionsOpResult> {
    const all = [...recovery.lines, ...lines]
    await this.end(sessionId, { result, revisions: recovery.revisions, main: recovery.main, worktree: 'kept', lines: all })
    return { ok: false, code, detail: all.join('\n') }
  }

  /** The commits of an earlier finish stay this worktree's: a later finish no longer recovers them. */
  private async end(sessionId: string, outcome: FinishOutcome): Promise<void> {
    await this.closingWrite(sessionId, (current) => {
      const next: SessionRecord = {
        ...current,
        worktreeOutcome: {
          result: outcome.result,
          revisions: SvnWorktreeFinishFlow.joined(
            current.worktreeOutcome?.revisions ?? [], SvnWorktreeFinishFlow.revisionsOf(outcome.revisions)),
          main: outcome.main,
          worktree: outcome.worktree,
          lines: [...outcome.lines],
          at: this.now(),
        } satisfies SessionWorktreeOutcome,
      }
      delete next.worktreeFinish
      // The holder goes some time after the finish; the cleanup takes the worktree then.
      if (SvnWorktreeFinishFlow.unfinished(outcome.worktree))
        next.worktreeCleanup = WorktreeCleanupPacing.pending('removal-unfinished', this.now())
      return next
    }, `the end of the finish (${outcome.result})\n${outcome.lines.join('\n')}`)
  }

  /** A removal that a holder or a half-done purge stopped, which the cleanup finishes once nothing holds it. */
  private static unfinished(state: SvnFinishWorktreeResult): boolean {
    if (state === 'in-use' || state === 'undeleted') return true
    else if (state === 'removed' || state === 'kept') return false
    else throw new Error(`Unknown worktree removal: ${JSON.stringify(state satisfies never)}`)
  }


  /** A finish that threw never holds its session: the row says what broke and what had landed, and Finish runs again. */
  private async endAfterThrow(sessionId: string, error: unknown, progress: Progress): Promise<void> {
    await this.end(sessionId, {
      result: 'failed', revisions: progress.revisions, main: progress.main, worktree: 'kept',
      lines: [`ERROR: the finish stopped on an unexpected failure; the worktree is kept: ${ErrorText.of(error)}`],
    })
  }

  /** `cleanup` asks for the removal after the end in the same write, for a removal that did not finish. */
  private async clearFinish(sessionId: string, what: string, cleanup?: SessionWorktreeCleanupTrigger): Promise<void> {
    if (this.records.get(sessionId)?.worktreeFinish === undefined) return
    await this.closingWrite(sessionId, (current) => {
      const next: SessionRecord = { ...current }
      delete next.worktreeFinish
      if (cleanup !== undefined && next.worktree !== undefined)
        next.worktreeCleanup = WorktreeCleanupPacing.pending(cleanup, this.now())
      return next
    }, what)
  }

  /**
   * The write that ends a finish, tried twice: a failed atomic rename is often transient. When neither
   * lands, memory still lets go of the phase, or the session would stay held until a restart.
   */
  private async closingWrite(sessionId: string, compose: (current: SessionRecord) => SessionRecord, what: string): Promise<void> {
    let landed = false
    for (let attempt = 0; attempt < 2 && !landed; attempt += 1) {
      const current = this.records.get(sessionId)
      landed = current === null || await this.records.put(compose(current))
    }
    if (!landed) {
      await this.records.forgetFinish(sessionId)
      this.report(`Session ${sessionId}: the session records could not be written, so they do not hold ${what}`)
    }
    this.changed()
  }

  /** The row alone is easy to miss, so a problem of a finish also goes to the report channel. */
  private tell(sessionId: string, path: string, outcome: FinishOutcome): void {
    if (SvnWorktreeFinishFlow.needsTelling(outcome))
      this.report(`Session ${sessionId}: the finish of ${path} ended ${outcome.result}\n${outcome.lines.join('\n')}`)
  }

  private async underOwner<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const key = PathCompare.comparable(owner)
    const previous = this.ownerTurns.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = previous.then(() => new Promise<void>((resolve) => { release = resolve }))
    this.ownerTurns.set(key, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.ownerTurns.get(key) === tail) this.ownerTurns.delete(key)
    }
  }

  private mustRecord(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId)
    if (!record) throw new Error(`A refused finish of ${sessionId} reached the work itself`)
    return record
  }

  private static worktreeOf(record: SessionRecord): SessionRecordWorktree {
    if (!record.worktree) throw new Error(`A refused finish of ${record.sessionId} reached the work itself`)
    return record.worktree
  }

  private static locationOf(worktree: SessionRecordWorktree): SvnWorktreeLocation {
    return {
      worktreePath: worktree.worktreePath,
      ownerDir: worktree.repositoryRoot,
      url: worktree.branch,
      ...worktree.directoryId === undefined ? {} : { directoryId: worktree.directoryId },
    }
  }

  /** The v2 precedence: a failed proof first, then nothing landed, then a remainder. */
  static classify(input: { proofFailure: boolean; outdated: boolean; landed: number; remaining: number }): SvnFinishResult {
    const { proofFailure, outdated, landed, remaining } = input
    if (proofFailure && landed > 0) return 'partial'
    if (proofFailure) return outdated ? 'out-of-date' : 'failed'
    if (landed === 0 && outdated) return 'out-of-date'
    if (landed === 0 && remaining > 0) return 'not-committed'
    if (remaining > 0) return 'partial'
    if (landed > 0) return 'committed'
    return 'failed'
  }

  private static resultLines(
    result: SvnFinishResult,
    facts: { path: string; revisions: readonly Revision[]; remaining: readonly string[]; proofFailure: boolean; externalStop: boolean },
  ): string[] {
    const { path, revisions, remaining } = facts
    if (result === 'out-of-date')
      return ['OUT OF DATE: SVN received newer content for this change set during the review; press Finish again.']
    else if (result === 'not-committed')
      return facts.externalStop ? [] : [`NOT COMMITTED: the review ended without a commit; ${path} is kept`]
    else if (result === 'partial')
      return [
        `PARTIAL: ${SvnWorktreeFinishFlow.revisionText(revisions)} left ${remaining.length} change(s) in ${path}; the worktree is kept`,
        ...SvnWorktreeFinishFlow.listed(remaining),
      ]
    else if (result === 'committed') return [`-> committed ${SvnWorktreeFinishFlow.revisionText(revisions)} from ${path}`]
    else if (result === 'failed')
      return [facts.proofFailure
        ? 'ERROR: no verified revision can be attributed to this review'
        : `ERROR: the changes of ${path} are gone, but no revision holds them`]
    else if (result === 'updated' || result === 'conflict' || result === 'nothing' || result === 'interrupted')
      throw new Error(`A review never ends ${result}`)
    else throw new Error(`Unknown finish result: ${JSON.stringify(result satisfies never)}`)
  }

  /** Whether the person has to hear about a detached finish: the row alone is easy to miss. */
  private static needsTelling(outcome: { result: SvnFinishResult; main: SvnMainState; worktree: SvnFinishWorktreeResult }): boolean {
    const { result, main, worktree } = outcome
    if (result === 'partial' || result === 'out-of-date' || result === 'failed') return true
    else if (result === 'not-committed') return false
    else if (result === 'committed' || result === 'nothing')
      return main === 'failed' || main.startsWith('conflict:') || (worktree !== 'removed' && worktree !== 'kept')
    else if (result === 'updated' || result === 'conflict' || result === 'interrupted') return true
    else throw new Error(`Unknown finish result: ${JSON.stringify(result satisfies never)}`)
  }

  /** Why a finish that ended `committed` or `nothing` did not do all it promised, or null. */
  private static problemOf(outcome: Pick<FinishOutcome, 'main' | 'worktree'>): SessionsOpErrorCode | null {
    if (outcome.main === 'failed' || outcome.main.startsWith('conflict:')) return 'svn-failed'
    return SvnWorktreeFinishFlow.removalCodeOf(outcome.worktree)
  }

  private static removalCodeOf(state: SvnFinishWorktreeResult): SessionsOpErrorCode | null {
    if (state === 'removed') return null
    else if (state === 'in-use') return 'locked'
    else if (state === 'kept' || state === 'undeleted') return 'svn-failed'
    else throw new Error(`Unknown worktree removal: ${JSON.stringify(state satisfies never)}`)
  }

  /** The worse of two main-copy states; two of one kind add their counts. */
  static worse(a: SvnMainState, b: SvnMainState): SvnMainState {
    const kindOf = (state: SvnMainState): string => state.split(':')[0]
    if (kindOf(a) === kindOf(b) && a.includes(':'))
      return `${kindOf(a)}:${Number(a.split(':')[1]) + Number(b.split(':')[1])}` as SvnMainState
    return SvnWorktreeFinishFlow.rankOf(a) >= SvnWorktreeFinishFlow.rankOf(b) ? a : b
  }

  private static rankOf(state: SvnMainState): number {
    if (state === 'failed') return 4
    else if (state.startsWith('conflict:')) return 3
    else if (state.startsWith('merged:')) return 2
    else if (state === 'updated') return 1
    else if (state === 'none') return 0
    else throw new Error(`Unknown main-copy state: ${JSON.stringify(state)}`)
  }

  private static listed(paths: readonly string[]): string[] {
    return paths.slice(0, SvnWorktreeFinishFlow.listedPathsConst).map((path) => `  ${path}`)
  }

  private static sortedRevisions(revisions: readonly Revision[]): Revision[] {
    const unique = new Map(revisions.map((entry) => [`${entry.repository}\t${entry.revision}`, entry]))
    return [...unique.values()].sort((a, b) =>
      a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : a.revision - b.revision)
  }

  private static revisionsOf(revisions: readonly Revision[]): string[] {
    return SvnWorktreeFinishFlow.sortedRevisions(revisions).map((entry) => `${entry.repository}:r${entry.revision}`)
  }

  /** Two lists of `<repository>:r<N>`, once each, by repository and number; a hand-edited entry sorts by its text. */
  private static joined(earlier: readonly string[], later: readonly string[]): string[] {
    const keyOf = (entry: string): [string, number] => {
      const match = /^(.*):r(\d+)$/.exec(entry)
      return match === null ? [entry, 0] : [match[1], Number(match[2])]
    }
    return [...new Set([...earlier, ...later])].sort((a, b) => {
      const [left, right] = [keyOf(a), keyOf(b)]
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] - right[1]
    })
  }

  /** The bash helper's spelling: the repository's last segment, so a line stays readable. */
  private static revisionText(revisions: readonly Revision[]): string {
    return SvnWorktreeFinishFlow.sortedRevisions(revisions)
      .map((entry) => `${SvnWorktreeFinishFlow.repositoryName(entry.repository)}:r${entry.revision}`).join(',') || '-'
  }

  private static repositoryName(repository: string): string {
    return repository.replace(/\/+$/, '').split('/').pop() || repository
  }

  private static latched(): { ok: false; code: 'records-latched'; detail: string } {
    return {
      ok: false,
      code: 'records-latched',
      detail: 'The session records could not be written; the file was left as this write found it',
    }
  }
}
