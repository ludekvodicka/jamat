import { randomUUID } from 'node:crypto'

import type { GitErrorCode, GitResult, WorktreeFacts } from '../../git/git.types'
import type { MergeStatus } from '../../git/gitMergeManager'
import type { GitWorktreeManager } from '../../git/gitWorktreeManager'
import type { StoreCutWorktrees } from '../../git/storeCutWorktrees'
import { PathCompare } from '../../shared/pathCompare'
import type { SessionMergePhase, SessionRecord, SessionRecordWorktree } from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import { AgentPresets } from '../launch/agentPresets'
import type {
  SessionCreateSpec,
  SessionFinishChoice,
  SessionsOpErrorCode,
  SessionsOpResult,
} from '../sessionManagerApi.types'
import { GitCodes } from './gitCodes'
import type { WorktreeEnded, WorktreeFinishFacts, WorktreeFinisher } from './worktreeFinish.types'

/** The git calls this flow makes, named so a test can hand it a scripted set instead. */
export interface SessionMergePort {
  currentBranch(repositoryRoot: string): Promise<GitResult<{ branch: string | null }>>
  mergeStatus(path: string): Promise<GitResult<MergeStatus>>
  commitAll(worktreePath: string, message: string): Promise<GitResult<void>>
  mergeIntoWorktree(worktreePath: string, baseBranch: string): Promise<GitResult<{ conflict: boolean }>>
  isMerged(repositoryRoot: string, branch: string): Promise<GitResult<boolean>>
  mergeToMain(repositoryRoot: string, branch: string): Promise<GitResult<{ conflict: boolean }>>
  removeWorktreeForced(repositoryRoot: string, worktreePath: string): Promise<GitResult<void>>
  deleteBranch(repositoryRoot: string, branch: string, force: boolean): Promise<GitResult<void>>
}

/** What launching a resolve session takes, kept narrow so the flow never sees the whole lifecycle. */
export type ResolveLauncher = (
  spec: SessionCreateSpec,
  marks: { sessionId: string; oneShot: true; resolveFor: string },
) => Promise<SessionsOpResult<{ sessionId: string }>>

export interface WorktreeMergeFlowDeps {
  records: SessionRecordsStore
  merge: SessionMergePort
  /** What the Finish row promises is measured with these. */
  measure: Pick<GitWorktreeManager, 'refreshDiff' | 'baseMoved'>
  /** The legacy worktrees cut from the checkpoint store: never landed, only discarded. */
  storeCut: Pick<StoreCutWorktrees, 'recognize' | 'discard'>
  /** Absent in the tests that only cover the manual path; then every conflict takes it. */
  launchResolve?: ResolveLauncher
  /** Where a fact the user has to know but cannot act on through the result goes. */
  report: (message: string) => void
  /** After a landed teardown or a Discard, once the record no longer names the worktree. */
  ended: WorktreeEnded
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
  /**
   * One merge at a time per repository. Two worktrees of one repository merging into the same branch
   * at once is the case git does NOT protect against - 009e measured that worktree add and remove
   * are safe concurrently, and a merge into one HEAD is a different question.
   */
  private readonly repositories = new Set<string>()
  private readonly records: SessionRecordsStore
  private readonly merge: SessionMergePort
  private readonly measure: Pick<GitWorktreeManager, 'refreshDiff' | 'baseMoved'>
  /** By worktree path, from the last `facts`: whether it is a legacy store-cut worktree. */
  private readonly legacyPaths = new Map<string, boolean>()
  private readonly storeCut: Pick<StoreCutWorktrees, 'recognize' | 'discard'>
  private readonly launchResolve: ResolveLauncher | null
  private readonly report: (message: string) => void
  private readonly ended: WorktreeEnded
  private readonly newId: () => string
  private readonly now: () => number

  constructor(deps: WorktreeMergeFlowDeps) {
    this.records = deps.records
    this.merge = deps.merge
    this.measure = deps.measure
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

  /**
   * Finishing with a session that has a worktree: whatever it left uncommitted is committed to its
   * own branch, and then the ordinary merge runs.
   *
   * The commit is here rather than in front of `mergeSession` because the lock is here. A commit
   * made outside it would be racing a merge the reconciler resumed, writing into a worktree that is
   * being torn down.
   *
   * Unresolved conflicts are never committed over, whatever left them there. `add --all` resolves an
   * unmerged path by staging whatever is on disk - markers included - and the merge that follows
   * would carry them into the main copy. A plain merge is caught by `inProgress`, and a rebase,
   * cherry-pick, revert or `am` stopped on conflicts by `unresolved`, which reads git's own unmerged
   * codes rather than the one ref a merge happens to leave. Both fall through to `run`, which refuses
   * the tree as dirty and leaves the manual way out - resolve, commit, Finish again - open.
   */
  async finish(sessionId: string): Promise<SessionsOpResult> {
    return this.underRepositoryLock(sessionId, async (record) => {
      const worktree = record.worktree
      if (!worktree) throw new Error('A refused finalize reached the work itself')
      const legacy = await this.legacyRefusal(worktree)
      if (legacy) return legacy
      const state = await this.merge.mergeStatus(worktree.worktreePath)
      if (!state.ok) return WorktreeMergeFlow.gitRefusal(state)
      if (!state.value.inProgress && !state.value.unresolved && state.value.dirty) {
        // Write-ahead before the commit, for the reason every other step here writes one: a failure
        // with no phase behind it has nowhere to be recorded, and the row would go on looking like a
        // session nobody had tried to finish. `run` writes the same phase again straight after.
        if (!await this.phase(record, 'base-merging')) return WorktreeMergeFlow.latched()
        const committed = await this.merge.commitAll(
          worktree.worktreePath,
          `Finalize session ${record.title}`,
        )
        if (!committed.ok) return this.failed(record, committed.detail, committed.code)
      }
      return this.run(record)
    })
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
      if (!await this.phase(record, 'tearing-down')) return WorktreeMergeFlow.latched()
      if (await this.storeCut.recognize(worktree.worktreePath) !== null) {
        const discarded = await this.storeCut.discard(worktree)
        if (!discarded.ok) return this.failed(record, discarded.detail, discarded.code)
        return this.clearWorktree(record)
      }
      const removed = await this.merge.removeWorktreeForced(
        worktree.repositoryRoot,
        worktree.worktreePath,
      )
      if (!removed.ok) return this.failed(record, removed.detail, removed.code)
      const deleted = await this.merge.deleteBranch(worktree.repositoryRoot, worktree.branch, true)
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

  async facts(worktree: SessionRecordWorktree): Promise<WorktreeFinishFacts> {
    this.legacyPaths.set(PathCompare.comparable(worktree.worktreePath),
      await this.storeCut.recognize(worktree.worktreePath) !== null)
    const diff = await this.measure.refreshDiff(worktree.worktreePath, worktree.baseCommit)
    const base = await this.measure.baseMoved(worktree.repositoryRoot, worktree)
    return { diff: diff.ok ? diff.value : null, baseMoved: base.ok ? base.value : false }
  }

  /** Until `facts` has looked, a legacy worktree is offered Merge back, which refuses it by name. */
  choicesOf(worktree: SessionRecordWorktree): readonly SessionFinishChoice[] {
    return this.legacyPaths.get(PathCompare.comparable(worktree.worktreePath)) === true
      ? ['keep', 'discard']
      : ['merge', 'keep', 'discard']
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
    const intoWorktree = await this.merge.mergeIntoWorktree(worktree.worktreePath, baseBranch)
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
    const intoMain = await this.merge.mergeToMain(worktree.repositoryRoot, worktree.branch)
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
    const removed = await this.merge.removeWorktreeForced(
      worktree.repositoryRoot,
      worktree.worktreePath,
    )
    if (!removed.ok) return this.failed(record, removed.detail, removed.code)
    const deleted = await this.merge.deleteBranch(worktree.repositoryRoot, worktree.branch, false)
    if (!deleted.ok) return this.failed(record, deleted.detail, deleted.code)
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
     * One automatic attempt per merge, and this is where that is enforced. `merge-resolve-succeeded`
     * is the one reconcile change that writes nothing of its own, so its trigger - a `resolving`
     * phase, a pointer, and no failure - survives it. Coming back here without a failure beside the
     * phase would leave exactly that shape on disk, and the reconciler would reach the same verdict
     * and resume the same merge every two seconds, for ever, on a record that never moves.
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
      { sessionId: resolveSessionId, oneShot: true, resolveFor: record.sessionId },
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
    const current = this.records.get(record.sessionId) ?? record
    const existing = current.worktreeMerge
    return this.records.put({
      ...current,
      worktreeMerge: {
        phase,
        resolveSessionId: existing?.resolveSessionId,
        startedAt: existing?.startedAt ?? this.now(),
        // A step that is being attempted again is not still failing.
        failure: undefined,
      },
    })
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
    delete next.worktreeMerge
    if (!await this.records.put(next)) return WorktreeMergeFlow.latched()
    this.ended(record.sessionId)
    return { ok: true, value: undefined }
  }

  private static gitRefusal(
    result: { ok: false; code: GitErrorCode; detail: string },
  ): SessionsOpResult {
    return { ok: false, code: GitCodes.sessionCodeOf(result.code), detail: result.detail }
  }

  /**
   * Worded like `SessionLifecycle.latched()` and for its reason: it is returned after a `put` came
   * back false as well as from the read latch, and a failed WRITE is how the store answers EPERM,
   * ENOSPC or a locked file. Saying the records could not be READ sent people looking for a damaged
   * document that is not damaged.
   */
  private static latched(): SessionsOpResult {
    return {
      ok: false,
      code: 'records-latched',
      detail: 'The session records could not be written; the file was left as this write found it',
    }
  }
}
