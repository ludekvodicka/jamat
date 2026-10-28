import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { relative } from 'node:path'
import { FileChangesFingerprint } from '../../fileChangesManager/fileChangesFingerprint'

import type { GitErrorCode, GitResult, WorktreeFacts } from '../../git/git.types'
import type { GitMergeManager } from '../../git/gitMergeManager'
import type { SessionScriptsManager } from '../../sessionManager/worktreeSessionScripts'
import type { StoreCutWorktrees } from '../../git/storeCutWorktrees'
import { PathCompare } from '../../shared/pathCompare'
import { ErrorText } from '../../shared/errorText'
import { ErrnoCode } from '../../shared/errnoCode'
import type {
  SessionMergePhase,
  SessionRecord,
  SessionRecordScriptLink,
} from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { AgentPresets } from '../../sessionManager/worktreeSessionRuntime'
import { SessionScriptDefinitions } from '../../sessionManager/worktreeSessionScripts'
import type {
  SessionCreateSpec,
  SessionFinishChoice,
  SessionFinishPress,
  SessionsOpErrorCode,
  SessionsOpResult,
} from '../../sessionManager/sessionManagerApi.types'
import { GitCodes } from './gitCodes'
import type { WorktreeEnded, WorktreeFinisher } from '../finish/worktreeFinish.types'

/** The git calls this flow makes, named so a test can hand it a scripted set instead. */
export type SessionMergePort = Pick<GitMergeManager, 'currentBranch' | 'mergeStatus' | 'commitAll'
  | 'revision' | 'mergeIntoWorktree' | 'isMerged' | 'mergeToMain' | 'removeWorktreeForced' | 'deleteBranch'>

/** What launching a resolve session takes, kept narrow so the flow never sees the whole lifecycle. */
export type ResolveLauncher = (
  spec: SessionCreateSpec,
  marks: { sessionId: string; oneShot: true; scriptOf: SessionRecordScriptLink },
) => Promise<SessionsOpResult<{ sessionId: string }>>

export interface WorktreeMergeFlowDeps {
  records: SessionRecordsStore
  merge: SessionMergePort
  /** The legacy worktrees cut from the checkpoint store: never landed, only discarded. */
  storeCut: Pick<StoreCutWorktrees, 'recognize' | 'discard'>
  /** Absent in the tests that only cover the manual path; then every conflict takes it. */
  launchResolve?: ResolveLauncher
  /** Where a fact the user has to know but cannot act on through the result goes. */
  report: (message: string) => void
  /** After a landed teardown or a Discard, once the record no longer names the worktree. */
  ended: WorktreeEnded
  scripts?: Pick<SessionScriptsManager, 'runLocal'>
  changed?: () => void
  newId?: () => string
  now?: () => number
}

/**
 * Bringing a worktree session home, and taking the worktree away with it.
 *
 * **Every call reads the disk and continues from what it finds.** The phase on the record is
 * write-ahead evidence - it says what was being attempted, so the tree can show it and a crash
 * leaves a trace - and it is never a program counter to resume from. That is what makes "run Merge
 * again" the answer to every interruption, including a conflict, a failed step and a client that
 * died mid-merge: the second run establishes the state itself and does whatever is still missing.
 *
 * **The base branch goes into the feature branch first, inside the worktree.** Conflicts then
 * surface where the work was done, next to the session that did it, rather than in the main copy
 * somebody else is using. Only when that is clean does the feature branch go into the main copy,
 * with `--no-ff` so the session leaves a trace in the history.
 *
 * The git steps run OUTSIDE the manager's operation queue - a merge can take a while, and 011e
 * measured what a long job on that queue costs. What the queue is used for here is what it is for
 * everywhere: the record writes.
 *
 * The merge ends at git. The final commit is a person's, through TortoiseSVN or Jamat's confirmed
 * commit dialog; see docs/architecture/versioning-commit-dialog.md.
 *
 * It finishes Git worktrees only, and reads no versioning mode: a Git worktree is cut from the
 * project's own repository whichever mode created it, so it lands there the same way.
 */
export class WorktreeMergeFlow implements WorktreeFinisher {
  /** The Finish checks gate of `SessionManager` runs `scripts.after` before a merge. */
  readonly ownsChecks = false
  /**
   * One merge at a time per repository. Two worktrees of one repository merging into the same branch
   * at once is the case git does NOT protect against - 009e measured that worktree add and remove
   * are safe concurrently, and a merge into one HEAD is a different question.
   */
  private readonly repositories = new Set<string>()
  private readonly records: SessionRecordsStore
  private readonly merge: SessionMergePort
  private readonly storeCut: Pick<StoreCutWorktrees, 'recognize' | 'discard'>
  private readonly launchResolve: ResolveLauncher | null
  private readonly report: (message: string) => void
  private readonly ended: WorktreeEnded
  private readonly newId: () => string
  private readonly now: () => number
  private readonly scripts: Pick<SessionScriptsManager, 'runLocal'> | undefined
  private readonly changed: () => void

  constructor(deps: WorktreeMergeFlowDeps) {
    this.scripts = deps.scripts
    this.changed = deps.changed ?? (() => {})
    this.records = deps.records
    this.merge = deps.merge
    this.storeCut = deps.storeCut
    this.launchResolve = deps.launchResolve ?? null
    this.report = deps.report
    this.ended = deps.ended
    this.newId = deps.newId ?? randomUUID
    this.now = deps.now ?? (() => Date.now())
  }

  async mergeSession(sessionId: string): Promise<SessionsOpResult> {
    return this.underRepositoryLock(sessionId, (record) => this.run(record))
  }

  async prepare(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ ready: boolean }>> {
    if (this.records.latched) return WorktreeMergeFlow.latched()
    const record = this.records.get(sessionId)
    if (!record?.worktree) return { ok: false, code: 'invalid-spec', detail: 'This session has no worktree' }
    const root = record.worktree.worktreePath
    if (this.repositories.has(record.worktree.repositoryRoot))
      return { ok: false, code: 'merge-pending', detail: 'A merge is already running in this repository' }
    const legacy = await this.legacyRefusal(record.worktree)
    if (legacy && !legacy.ok) return legacy
    if (press.requestedBy === 'window' && press.selection !== undefined) {
      if (press.selection.length === 0) {
        const status = await this.merge.mergeStatus(root)
        if (!status.ok) return WorktreeMergeFlow.gitRefusal(status)
        if (!status.value.dirty) {
          if (!await this.records.update(sessionId, (current) => ({ ...current,
            worktreeMerge: { ...this.finishStateOf(current), phase: 'base-merging',
              changes: undefined, approval: undefined, endedAt: undefined, failure: undefined } }))) return WorktreeMergeFlow.latched()
          this.changed()
          return { ok: true, value: { ready: true } }
        }
      }
      if (press.selection.length === 0 || !press.message?.trim() || press.message.includes('\0')
        || press.selection.some((path) => !PathCompare.isInside(root, path) || relative(root, path) === '' || /[\0\r\n]/.test(path)))
        return { ok: false, code: 'invalid-spec', detail: 'Select files inside the worktree and enter a commit message' }
      let hashes: Record<string, string>
      try { hashes = await WorktreeMergeFlow.hashesOf(press.selection) }
      catch (error) { return { ok: false, code: 'invalid-spec', detail: ErrorText.of(error) } }
      if (press.reviewed !== undefined) {
        try {
          for (const path of press.selection)
            if (press.reviewed[path] === undefined || await FileChangesFingerprint.of(path) !== press.reviewed[path])
              return { ok: false, code: 'review-unavailable', detail: `${path} changed after review; review the selected files again` }
        } catch (error) { return { ok: false, code: 'review-unavailable', detail: ErrorText.of(error) } }
      }
      const written = await this.records.update(sessionId, (current) => ({ ...current,
        worktreeMerge: { ...this.finishStateOf(current), phase: 'base-merging',
          changes: undefined, failure: undefined, endedAt: undefined,
          approval: { selection: [...press.selection!], message: press.message!, hashes } } }))
      this.changed()
      return written ? { ok: true, value: { ready: true } } : WorktreeMergeFlow.latched()
    }
    if (press.requestedBy === 'window') {
      if (!await this.waitForChanges(record)) return WorktreeMergeFlow.latched()
      return { ok: true, value: { ready: false } }
    }
    const status = await this.merge.mergeStatus(root)
    if (!status.ok) return WorktreeMergeFlow.gitRefusal(status)
    if (status.value.dirty && !status.value.inProgress) {
      if (!await this.waitForChanges(record)) return WorktreeMergeFlow.latched()
      return { ok: false, code: 'review-unavailable', detail: 'Review the changes in Session actions and press Commit & merge.' }
    }
    if (record.worktreeMerge?.discard === true && !await this.phase(record, 'base-merging')) return WorktreeMergeFlow.latched()
    await this.records.update(sessionId, (current) => current.worktreeMerge === undefined ? null
      : { ...current, worktreeMerge: { ...current.worktreeMerge, approval: undefined, changes: undefined } })
    return { ok: true, value: { ready: true } }
  }

  async finish(sessionId: string, press: SessionFinishPress = { choice: 'merge', requestedBy: 'cli' }): Promise<SessionsOpResult<{ actionId: string | null }>> {
    const merged = await this.underRepositoryLock(sessionId, async (record) => {
      const worktree = record.worktree!
      const legacy = await this.legacyRefusal(worktree)
      if (legacy) return legacy
      if (record.worktreeMerge?.discard === true && !await this.phase(record, 'base-merging')) return WorktreeMergeFlow.latched()
      const state = await this.merge.mergeStatus(worktree.worktreePath)
      if (!state.ok) return WorktreeMergeFlow.gitRefusal(state)
      if (!state.value.inProgress && !state.value.unresolved && state.value.dirty) {
        if (press.requestedBy !== 'window' || press.selection === undefined || !press.message?.trim()) {
          if (!await this.waitForChanges(record)) return WorktreeMergeFlow.latched()
          return { ok: false as const, code: 'review-unavailable' as const, detail: 'Review the changes in Session actions and press Commit & merge.' }
        }
        const approved = record.worktreeMerge?.approval
        if (approved !== undefined) {
          let unchanged = false
          try {
            const current = await WorktreeMergeFlow.hashesOf(press.selection)
            unchanged = approved.hashes !== undefined && approved.message === press.message
              && approved.selection.length === press.selection.length
              && press.selection.every((path) => current[path] === approved.hashes?.[path])
          } catch { /* A selection that cannot be read needs a fresh review. */ }
          if (!unchanged) {
            if (!await this.waitForChanges(record)) return WorktreeMergeFlow.latched()
            return { ok: false as const, code: 'review-unavailable' as const, detail: 'Selected content changed after approval. Review the changes again.' }
          }
        }
        const committed = await this.logged(record, 'commit', (output) =>
          this.merge.commitAll(worktree.worktreePath, press.message!, press.selection, output))
        if (!committed.ok) return this.failed(record, committed.detail, committed.code)
        const receipt = await this.merge.revision(worktree.worktreePath)
        if (!receipt.ok) return this.failed(record, receipt.detail, receipt.code)
        if (!await this.records.update(sessionId, (current) => ({ ...current,
          worktreeMerge: { ...this.finishStateOf(current), revisions: [...new Set([...(current.worktreeMerge?.revisions ?? []), receipt.value])] } })))
          return WorktreeMergeFlow.latched()
        const left = await this.merge.mergeStatus(worktree.worktreePath)
        if (!left.ok) return this.failed(record, left.detail, left.code)
        if (left.value.dirty) {
          if (!await this.waitForChanges(record)) return WorktreeMergeFlow.latched()
          return { ok: true as const, value: undefined }
        }
      }
      await this.records.update(sessionId, (current) => current.worktreeMerge === undefined ? null
        : { ...current, worktreeMerge: { ...current.worktreeMerge, approval: undefined, changes: undefined } })
      return this.run(record)
    })
    return merged.ok ? { ok: true, value: { actionId: null } } : merged
  }

  async keep(sessionId: string): Promise<SessionsOpResult> {
    const record = this.records.get(sessionId)
    if (record?.finishChecks !== undefined && record.finishChecks.result === undefined)
      return { ok: false, code: 'merge-pending', detail: 'The Finish checks are still running' }
    if (record?.worktree && this.repositories.has(record.worktree.repositoryRoot))
      return { ok: false, code: 'merge-pending', detail: 'A merge is already running in this repository' }
    const written = await this.records.update(sessionId, (current) => {
      const next = { ...current }
      delete next.worktreeMerge
      delete next.finishChecks
      return next
    })
    this.changed()
    return written ? { ok: true, value: undefined } : WorktreeMergeFlow.latched()
  }

  private async waitForChanges(record: SessionRecord): Promise<boolean> {
    const written = await this.records.update(record.sessionId, (current) => ({ ...current,
      worktreeMerge: { ...this.finishStateOf(current), phase: 'base-merging',
        changes: true, approval: undefined, failure: undefined, endedAt: undefined } }))
    this.changed()
    return written
  }

  private static async hashesOf(selection: readonly string[]): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {}
    for (const path of selection) {
      const stat = await lstat(path).catch((error: unknown) => {
        if (ErrnoCode.of(error) === 'ENOENT') return null
        throw error
      })
      if (stat === null) hashes[path] = 'missing'
      else if (stat.isSymbolicLink()) hashes[path] = `link:${await readlink(path)}`
      else if (stat.isFile()) {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(path)) hash.update(chunk)
        hashes[path] = `${stat.mode}:${hash.digest('hex')}`
      }
      else throw new Error(`Select individual files inside the worktree: ${path}`)
    }
    return hashes
  }

  private async logged<T>(record: SessionRecord, phase: 'commit' | SessionMergePhase,
    work: (output: (text: string) => void) => Promise<GitResult<T>>): Promise<GitResult<T>> {
    if (!await this.phase(record, phase === 'commit' ? 'base-merging' : phase))
      return { ok: false, code: 'git-failed', detail: 'The session records could not be written' }
    const runId = randomUUID()
    if (!await this.records.update(record.sessionId, (current) => ({ ...current, worktreeMerge: { ...current.worktreeMerge!,
      runs: [...current.worktreeMerge?.runs ?? [], { phase, runId, startedAt: this.now() }].slice(-10) } })))
      return { ok: false, code: 'git-failed', detail: 'The session records could not be written' }
    this.changed()
    let result: GitResult<T>
    try {
      result = this.scripts === undefined ? await work(() => {})
        : await this.scripts.runLocal(record.sessionId, runId, phase === 'commit' ? 'Commit selected changes' : phase, work, this.changed)
    } catch (error) {
      result = { ok: false, code: 'git-failed', detail: ErrorText.of(error) }
    }
    await this.records.update(record.sessionId, (current) => ({ ...current, worktreeMerge: { ...current.worktreeMerge!,
      runs: current.worktreeMerge?.runs?.map((run) => run.runId === runId
        ? { ...run, endedAt: this.now(), ...result.ok ? {} : { failed: true as const } } : run) } }))
    this.changed()
    return result
  }

  /**
   * Abandoning the work instead of bringing it home. It is the same teardown with `-D` on the
   * branch, and the two-step confirmation in front of it belongs to whatever draws the button.
   */
  async discard(sessionId: string): Promise<SessionsOpResult> {
    return this.underRepositoryLock(sessionId, async (record) => {
      const worktree = record.worktree
      if (!worktree) throw new Error('A refused discard reached the discard itself')
      // Write-ahead, for the same reason the merge writes one: two destructive commands with no
      // trace between them leave a crash looking exactly like a discard that never started.
      if (!await this.records.update(sessionId, (current) => ({ ...current, finishChecks: undefined,
        worktreeMerge: { phase: 'tearing-down', discard: true, startedAt: this.now() } }))) return WorktreeMergeFlow.latched()
      if (await this.storeCut.recognize(worktree.worktreePath) !== null) {
        const discarded = await this.logged(record, 'tearing-down', async (output) => {
          const result = await this.storeCut.discard(worktree)
          output(result.ok ? 'Discarded the legacy worktree\n' : result.detail)
          return result
        })
        if (!discarded.ok) return this.failed(record, discarded.detail, discarded.code)
        return this.clearWorktree(record)
      }
      const removed = await this.logged(record, 'tearing-down', (output) => this.merge.removeWorktreeForced(
        worktree.repositoryRoot,
        worktree.worktreePath,
        output,
      ))
      if (!removed.ok) return this.failed(record, removed.detail, removed.code)
      const deleted = await this.logged(record, 'tearing-down', (output) => this.merge.deleteBranch(worktree.repositoryRoot, worktree.branch, true, output))
      if (!deleted.ok) {
        // The directory is already gone, so saying nothing would leave a branch nobody can see.
        // Discard again finishes the job: the removal answers "already gone" as success.
        this.report(
          `Session ${record.sessionId}: the worktree was removed but the branch ${worktree.branch} `
          + `could not be deleted (${deleted.detail})`,
        )
        return this.failed(record, deleted.detail, deleted.code)
      }
      // As with the merge: a discard that did what it was asked is not reported as a fault.
      return this.clearWorktree(record)
    })
  }

  /** A legacy store-cut worktree is offered Merge back too, which refuses it by name. */
  choicesOf(): readonly SessionFinishChoice[] {
    return ['merge', 'keep', 'discard']
  }

  /**
   * What both endings share before they touch git: the refusals, and one worker per repository.
   *
   * The lock is per repository rather than per session because that is what the operations collide
   * over - two of them merging into the same main copy, or one deleting the worktree the other is
   * mid-merge in. Discard is inside it for the second reason: it used to run beside a merge the
   * reconciler had resumed, and the two writing the same record in turn produced a row with a merge
   * phase and no worktree, which no action could clear.
   */
  private async underRepositoryLock(
    sessionId: string,
    work: (record: SessionRecord) => Promise<SessionsOpResult>,
  ): Promise<SessionsOpResult> {
    const refusal = this.refuse(sessionId)
    if (refusal) return this.refusedBeforeWork(sessionId, refusal)
    const record = this.records.get(sessionId)
    if (!record?.worktree) throw new Error('A refused operation reached the work itself')
    const root = record.worktree.repositoryRoot
    if (this.repositories.has(root))
      return {
        ok: false,
        code: 'merge-pending',
        detail: `another merge is already running in ${root}`,
      }
    this.repositories.add(root)
    try {
      return await work(record)
    } finally {
      this.repositories.delete(root)
    }
  }

  /**
   * The state machine, and the reason it reads as one pass rather than as a resumption: each step
   * asks the disk what is true before doing anything about it.
   */
  private async run(record: SessionRecord): Promise<SessionsOpResult> {
    const worktree = record.worktree
    if (!worktree) throw new Error('A merge ran on a record with no worktree')
    const legacy = await this.legacyRefusal(worktree)
    if (legacy) return legacy
    if (record.worktreeMerge?.discard === true && !await this.phase(record, 'base-merging')) return WorktreeMergeFlow.latched()
    const base = await this.merge.currentBranch(worktree.repositoryRoot)
    if (!base.ok) return this.failed(record, base.detail, base.code)
    if (base.value.branch === null)
      return this.stopped(
        record,
        'git-failed',
        `${worktree.repositoryRoot} is on a detached HEAD, so there is no branch to merge into`,
      )
    const baseBranch = base.value.branch

    /*
     * The worktree is asked about FIRST, and the already-merged shortcut below comes second. The
     * order is the difference between landing an afternoon's work and deleting it: every ending here
     * runs `worktree remove --force`, and the only thing standing between that and a directory full
     * of uncommitted work is this block. A branch can be contained in HEAD while the worktree still
     * holds edits - it is contained from the moment it is cut, until the first commit lands on it -
     * so the shortcut is no evidence at all about what is on disk.
     */
    const state = await this.merge.mergeStatus(worktree.worktreePath)
    if (!state.ok) return this.failed(record, state.detail, state.code)
    if (state.value.inProgress) return this.conflicted(record, baseBranch)
    if (state.value.dirty)
      return this.stopped(
        record,
        'dirty',
        `${worktree.worktreePath} holds uncommitted work; commit it first`,
      )

    // A crash after the main merge landed leaves a branch that is already contained. Merging it a
    // second time would make an empty commit; what is actually left to do is the teardown.
    const merged = await this.merge.isMerged(worktree.repositoryRoot, worktree.branch)
    if (!merged.ok) return this.failed(record, merged.detail, merged.code)
    if (merged.value) return this.teardown(record)

    if (!await this.phase(record, 'base-merging')) return WorktreeMergeFlow.latched()
    const intoWorktree = await this.logged(record, 'base-merging', (output) => this.merge.mergeIntoWorktree(worktree.worktreePath, baseBranch, output))
    if (!intoWorktree.ok) return this.failed(record, intoWorktree.detail, intoWorktree.code)
    if (intoWorktree.value.conflict) return this.conflicted(record, baseBranch)

    /*
     * The user's OWN checkout, asked before anything is written into it, which is what plan 013e
     * specified and what this step did not do: it merged straight into whatever state that copy
     * happened to be in and reported git's own failure afterwards.
     *
     * A foreign merge is NEVER aborted here. It is somebody's unfinished work in their own
     * directory, and the one useful thing to do about it is to say where it is and stop.
     *
     * The dirty half asks about TRACKED changes only, and the asymmetry with the worktree check
     * above is the point. There, untracked files are work a force-remove would delete. Here, a
     * merge only touches tracked paths - and every project root holds `.worktrees/`, so counting
     * untracked files would refuse every merge this feature exists to make. It is still stricter
     * than git, which merges over tracked changes it does not touch; a refusal naming the path,
     * before anything moves, beats a half-applied merge explained as `git-failed`.
     */
    const main = await this.merge.mergeStatus(worktree.repositoryRoot)
    if (!main.ok) return this.failed(record, main.detail, main.code)
    if (main.value.inProgress)
      return this.stopped(
        record,
        'merge-pending',
        `${worktree.repositoryRoot} is in the middle of a merge; finish that one there first`,
      )
    if (main.value.dirtyTracked)
      return this.stopped(
        record,
        'dirty',
        `${worktree.repositoryRoot} holds uncommitted changes to tracked files; commit or `
        + 'stash them first',
      )

    if (!await this.phase(record, 'main-merging')) return WorktreeMergeFlow.latched()
    const intoMain = await this.logged(record, 'main-merging', (output) => this.merge.mergeToMain(worktree.repositoryRoot, worktree.branch, output))
    if (!intoMain.ok) return this.failed(record, intoMain.detail, intoMain.code)
    // Not `conflicted()`: that one is about the WORKTREE, where a resolver can be launched into
    // the conflict. This one is in the user's own copy, which no session owns and nothing here
    // may touch. The copy is now mid-merge, so the next Merge meets the guard above and says the
    // same thing.
    if (intoMain.value.conflict)
      return this.stopped(
        record,
        'merge-pending',
        `${worktree.branch} conflicts with ${baseBranch} in ${worktree.repositoryRoot}. `
        + 'Resolve it there, commit, and run Merge again.',
      )
    return this.teardown(record)
  }

  /**
   * The worktree and the branch go away together, and what the merge left behind is named on the
   * report channel: a result can say it worked, but not which commit to look at.
   */
  private async teardown(record: SessionRecord): Promise<SessionsOpResult> {
    const worktree = record.worktree
    if (!worktree) throw new Error('A teardown ran on a record with no worktree')
    if (!await this.phase(record, 'tearing-down')) return WorktreeMergeFlow.latched()
    if (!this.records.get(record.sessionId)?.worktreeMerge?.mergedRevision) {
      const branch = await this.merge.revision(worktree.repositoryRoot, worktree.branch)
      if (!branch.ok) return this.failed(record, branch.detail, branch.code)
      const main = await this.merge.revision(worktree.repositoryRoot)
      if (!main.ok) return this.failed(record, main.detail, main.code)
      if (!await this.records.update(record.sessionId, (current) => ({ ...current,
        worktreeMerge: { ...this.finishStateOf(current),
          revisions: [...new Set([...(current.worktreeMerge?.revisions ?? []), branch.value])], mergedRevision: main.value } })))
        return WorktreeMergeFlow.latched()
    }
    const removed = await this.logged(record, 'tearing-down', async (output) => {
      const removed = await this.merge.removeWorktreeForced(worktree.repositoryRoot, worktree.worktreePath, output)
      if (!removed.ok) return removed
      return this.merge.deleteBranch(worktree.repositoryRoot, worktree.branch, false, output)
    })
    if (!removed.ok) return this.failed(record, removed.detail, removed.code)
    // Nothing is reported here on purpose. `report` reaches the user as an app ERROR, and a merge
    // that worked is not one: the worktree badge leaving the row is what says it is done, and the
    // commit is in the history where a person looks for commits.
    return this.clearWorktree(record)
  }

  /**
   * Conflicts are a state to be in, not a failure. The phase is recorded so the tree can say so, and
   * the worktree is left exactly as git left it - markers and all - because that is what whoever
   * resolves them needs to see. Running Merge again continues from there.
   */
  private async conflicted(record: SessionRecord, baseBranch: string): Promise<SessionsOpResult> {
    // Read BEFORE the phase write. A pointer already on the record means a resolver has had its
    // turn and the conflict outlived it, which is a different situation from arriving here fresh.
    const spent = this.records.get(record.sessionId)?.worktreeMerge?.resolveSessionId !== undefined
    if (!await this.phase(record, 'resolving')) return WorktreeMergeFlow.latched()
    const where = record.worktree?.worktreePath ?? 'the worktree'
    if (!spent) {
      const launched = await this.launchResolver(record, baseBranch)
      if (launched !== null) return launched
      return {
        ok: false,
        code: 'merge-conflict',
        detail: `${baseBranch} conflicts with this session's work. Resolve it in ${where}, `
          + 'commit, and run Merge again.',
      }
    }
    /*
     * One automatic attempt per merge, and this is where that is enforced. `script-succeeded` on
     * the merge gate is the one reconcile change that writes nothing of its own, so its trigger - a
     * `resolving` phase, a pointer, and no failure - survives it. Coming back here without a
     * failure beside the phase would leave exactly that shape on disk, and the reconciler would reach
     * the same verdict and resume the same merge every two seconds, for ever, on a record that never
     * moves.
     *
     * The pointer is kept rather than cleared: the tree still nests the resolver under the session
     * it ran for, and clearing it would only mint a second resolver on the next pass, which is the
     * same loop with a subprocess in it.
     */
    const detail = `${baseBranch} still conflicts with this session's work after the resolver ran. `
      + `Resolve it in ${where}, commit, and run Merge again.`
    await this.noteFailure(record, 'the resolver finished and the conflict is still there')
    return { ok: false, code: 'merge-conflict', detail }
  }

  /**
   * The conflict is handed back to the conversation that caused it: a one-shot fork of this
   * session's own transcript, run inside the worktree. It has the context nobody else has, and
   * because print mode exits on its own the reconciler can judge it by its exit code exactly as it
   * judges an install.
   *
   * Null means there is nothing to launch and the caller should word the manual path. That covers a
   * shell session, a session whose conversation was never named, and an agent with no print mode -
   * the manual path is never taken away by any of them. Whether a resolver has already had its turn
   * is the caller's question, not this one's, because the answer changes what the caller says.
   */
  private async launchResolver(
    record: SessionRecord,
    baseBranch: string,
  ): Promise<SessionsOpResult | null> {
    const agent = record.agent
    const worktree = record.worktree
    if (!this.launchResolve || !worktree || !agent?.nativeSessionId) return null
    if (AgentPresets.headlessUnsupported(agent.agentId)) return null

    // The id is minted HERE and the pointer written BEFORE the launch, the same ordering
    // `createWithSetup` uses: a crash in between leaves a record naming a session that does not
    // exist, which the judgement reads as gone and turns into a failure with the manual path open.
    const resolveSessionId = this.newId()
    const current = this.records.get(record.sessionId)
    if (!current?.worktreeMerge) return null
    if (!await this.records.put({
      ...current,
      worktreeMerge: { ...current.worktreeMerge, resolveSessionId },
    }))
      return WorktreeMergeFlow.latched()

    const created = await this.launchResolve(
      {
        kind: 'agent',
        directory: { mode: 'adHoc', path: worktree.worktreePath },
        agent: {
          agentId: agent.agentId,
          mode: 'fork',
          forkParentId: agent.nativeSessionId,
          initialPrompt: WorktreeMergeFlow.promptOf(baseBranch, worktree.branch),
        },
        title: `Resolve merge ${worktree.branch}`,
      },
      {
        sessionId: resolveSessionId,
        oneShot: true,
        scriptOf: SessionScriptDefinitions.linkOf(record.sessionId, 'after', 'merge-resolve', 'resolver'),
      },
    )
    if (!created.ok) {
      /*
       * A refused launch is not always a launch that did not happen. `create` writes the
       * resolver's record as `starting` under its pending pair BEFORE the wire call, and every
       * UNDECIDED failure - an unreachable Host, no lease, a 409/429/401/5xx - leaves that record
       * on disk for the reconciler to replay under the same operation id.
       *
       * So the store is asked rather than the result: is there still a resolver that will run?
       * Taking the pointer back while one is pending would leave an agent running in the worktree
       * that no record names, and the next Merge would mint a SECOND resolver into the same
       * conflict, both of them committing.
       */
      const resolver = this.records.get(resolveSessionId)
      const pending = resolver?.life === 'starting'
        && resolver.pendingOperationId !== undefined
        && resolver.pendingOperationKind !== undefined
      if (pending)
        // Not the manual wording: nothing here is waiting on the person yet. Running Merge again
        // stays open and is what the message everywhere else in this flow already asks for.
        return {
          ok: false,
          code: 'merge-conflict',
          detail: `${baseBranch} conflicts with this session's work; the resolver could not be `
            + `started yet (${created.detail}) and is being retried. Merge continues on its own `
            + 'if it finishes cleanly.',
        }
      // Decided by the Host, so there is no resolver and never will be: the pointer would name
      // nothing, and taking it back is what leaves the merge where the manual path expects it.
      const latest = this.records.get(record.sessionId)
      if (latest?.worktreeMerge)
        await this.records.put({
          ...latest,
          worktreeMerge: { ...latest.worktreeMerge, resolveSessionId: undefined },
        })
      return null
    }
    return {
      ok: false,
      code: 'merge-conflict',
      detail: `${baseBranch} conflicts with this session's work; it is being resolved in `
        + `${worktree.worktreePath}. Merge continues on its own if that finishes cleanly.`,
    }
  }

  /** Short on purpose: it travels as a command-line argument. */
  private static promptOf(baseBranch: string, branch: string): string {
    return `Merging ${baseBranch} into ${branch} stopped on conflicts in this worktree. `
      + 'Resolve every conflict, keeping both sides where both are wanted, then stage the files and '
      + 'commit. Do not merge anything else and do not push.'
  }

  /** What every refusal before the first git call has in common. */
  private refuse(sessionId: string): SessionsOpResult | null {
    if (this.records.latched) return WorktreeMergeFlow.latched()
    const record = this.records.get(sessionId)
    if (!record) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    if (!record.worktree)
      return { ok: false, code: 'invalid-spec', detail: 'This session has no worktree' }
    // Git run inside an SVN checkout would find a human .git above it and commit there.
    const kind = record.worktree.kind ?? 'git'
    if (kind === 'svn')
      return { ok: false, code: 'invalid-spec', detail: `${record.worktree.worktreePath} is an SVN checkout, not a Git worktree` }
    else if (kind !== 'git') throw new Error(`Unknown worktree kind: ${JSON.stringify(kind)}`)
    // The teardown removes the directory the session is running in. Stopping it first is the
    // caller's to do, and saying which is more useful than a git error about a busy path.
    if (record.life === 'live' || record.life === 'starting')
      return {
        ok: false,
        code: 'live-refused',
        detail: 'This session is still running; stop it first',
      }
    // And the same again for the resolver, which is a SECOND session standing in that directory.
    // The primary record's own life says nothing about it: a conflicted merge is ended by then, and
    // the agent resolving it is very much not.
    const resolver = record.worktreeMerge?.resolveSessionId
    const resolving = resolver === undefined ? undefined : this.records.get(resolver)
    if (resolving?.life === 'live' || resolving?.life === 'starting')
      return {
        ok: false,
        code: 'live-refused',
        detail: `Session ${resolver} is resolving the conflicts in this worktree; stop it first`,
      }
    return null
  }

  /** Write-ahead: the record says what is being attempted before the git command is run. */
  private async phase(record: SessionRecord, phase: SessionMergePhase): Promise<boolean> {
    const written = await this.records.update(record.sessionId, (current) => ({ ...current,
      worktreeMerge: { ...this.finishStateOf(current), phase,
        failure: undefined } }))
    this.changed()
    return written
  }

  private finishStateOf(record: SessionRecord): NonNullable<SessionRecord['worktreeMerge']> {
    if (record.worktreeMerge?.discard === true) return { phase: 'base-merging', startedAt: this.now() }
    return record.worktreeMerge ?? { phase: 'base-merging', startedAt: record.finishChecks?.startedAt ?? this.now() }
  }

  /**
   * A worktree cut from the checkpoint store lands in that store, which nothing reads any more, so
   * it is never merged: Keep or Discard are its endings.
   */
  private async legacyRefusal(worktree: WorktreeFacts): Promise<SessionsOpResult | null> {
    if (await this.storeCut.recognize(worktree.worktreePath) === null) return null
    return {
      ok: false,
      code: 'invalid-spec',
      detail: `${worktree.worktreePath} was cut from the checkpoint store, which AppJamatV3 no longer `
        + 'merges back; keep it or discard it',
    }
  }

  private async failed(
    record: SessionRecord,
    detail: string,
    code: GitErrorCode,
  ): Promise<SessionsOpResult> {
    await this.noteFailure(record, detail)
    return { ok: false, code: GitCodes.sessionCodeOf(code), detail }
  }

  /**
   * A refusal in front of the work is ordinarily just the answer to whoever asked. It is not when
   * the asker is the reconciler resuming a merge: nobody reads that answer, and the trigger it was
   * refused on is still on disk. So a record still mid-resolve spends its attempt here too.
   *
   * `live-refused` is the only refusal that reaches this on the resume path - the primary session
   * was reopened while its merge was being resolved. The others cannot: a latched store, a missing
   * record and a record with no worktree all stop the reconciler from reaching the verdict in the
   * first place, and writing to disk on a latch is exactly what the latch forbids.
   */
  private async refusedBeforeWork(
    sessionId: string,
    refusal: SessionsOpResult,
  ): Promise<SessionsOpResult> {
    if (refusal.ok || refusal.code !== 'live-refused') return refusal
    const record = this.records.get(sessionId)
    const merge = record?.worktreeMerge
    if (record && merge?.phase === 'resolving' && merge.failure === undefined)
      await this.noteFailure(record, refusal.detail)
    return refusal
  }

  /**
   * A merge that stopped without doing anything, and without git having failed: a detached main
   * copy, or a worktree holding uncommitted work.
   *
   * It writes the reason for the same reason `conflicted` does, and that is the whole point of it
   * being a method rather than an object literal at each site. The reconciler's trigger for a
   * resumed merge is a `resolving` phase with no failure beside it, so ANY attempt that returns
   * without writing one leaves that shape on disk and is resumed again two seconds later, for ever,
   * on a record that never moves. The conflict path was the only one that closed it until this was
   * found; every ending of `run` closes it now.
   */
  private async stopped(
    record: SessionRecord,
    code: SessionsOpErrorCode,
    detail: string,
  ): Promise<SessionsOpResult> {
    await this.noteFailure(record, detail)
    return { ok: false, code, detail }
  }

  /**
   * The reason, beside whatever phase is on the record. It is also the only thing that stops the
   * reconciler judging the same resolver twice, so it is written on the conflict path too and not
   * only on a git failure.
   */
  private async noteFailure(record: SessionRecord, failure: string): Promise<void> {
    const current = this.records.get(record.sessionId)
    if (current?.worktreeMerge)
      await this.records.put({
        ...current,
        worktreeMerge: { ...current.worktreeMerge, failure },
      })
  }

  /**
   * Where both endings land: the branch is home, or it is gone. Either way the after-steps a stop
   * left waiting are done, so this is also where the session becomes finished - the person said so
   * when they stopped it, and this is the moment it becomes true.
   *
   * Every caller is a successful ending (a teardown after the branch landed, or a Discard), so this is
   * also the one place that says so through `ended`.
   */
  private async clearWorktree(record: SessionRecord): Promise<SessionsOpResult> {
    const current = this.records.get(record.sessionId) ?? record
    const next: SessionRecord = { ...current, completed: true }
    delete next.worktree
    if (next.worktreeMerge !== undefined)
      next.worktreeMerge = { ...next.worktreeMerge, changes: undefined, approval: undefined, endedAt: this.now() }
    if (!await this.records.put(next)) return WorktreeMergeFlow.latched()
    this.ended(record.sessionId)
    return { ok: true, value: undefined }
  }

  private static gitRefusal(
    result: { ok: false; code: GitErrorCode; detail: string },
  ): SessionsOpResult<never> {
    return { ok: false, code: GitCodes.sessionCodeOf(result.code), detail: result.detail }
  }

  /**
   * Worded like `SessionLifecycle.latched()` and for its reason: it is returned after a `put` came
   * back false as well as from the read latch, and a failed WRITE is how the store answers EPERM,
   * ENOSPC or a locked file. Saying the records could not be READ sent people looking for a damaged
   * document that is not damaged.
   */
  private static latched(): SessionsOpResult<never> {
    return {
      ok: false,
      code: 'records-latched',
      detail: 'The session records could not be written; the file was left as this write found it',
    }
  }
}
