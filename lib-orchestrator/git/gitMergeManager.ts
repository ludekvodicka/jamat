import { join } from 'node:path'

import { PathCompare } from '../shared/pathCompare'
import { GitCheckpointStore } from './gitCheckpointStore'
import { GitManager } from './gitManager'
import type { CheckpointModeContext } from './gitCheckpointStore'
import type {
  GitCommandOutcome,
  GitCommandRunner,
  GitErrorCode,
  GitResult,
  RepoCommandContext,
} from './git.types'

export interface MergeStatus {
  /** A merge is half-finished here: `MERGE_HEAD` exists, so conflicts are waiting to be resolved. */
  inProgress: boolean
  /** Anything uncommitted at all, including the conflict markers of a merge in progress. */
  dirty: boolean
  /**
   * Dirty ignoring untracked files, which is the question to ask about a copy that is about to
   * be MERGED INTO rather than removed. A merge only touches tracked paths, and git refuses one
   * that would overwrite an untracked file with a sentence of its own; meanwhile every project
   * root holds `.worktrees/`, so reading untracked files as dirty there would refuse every merge
   * this feature exists to make.
   */
  dirtyTracked: boolean
  /**
   * Files git itself is holding as unmerged, whatever left them that way. `inProgress` above answers
   * only for a plain `merge`, because `MERGE_HEAD` is the only ref it looks at; a conflicted rebase,
   * cherry-pick, revert or `am` leaves a different ref and the same markers in the same files. This
   * is read from the status git already reported, so it costs no extra call and covers all of them.
   */
  unresolved: boolean
}

/**
 * Merging a worktree branch back, and taking the worktree away afterwards.
 *
 * It sits beside `GitWorktreeManager` rather than inside it because merging is not managing
 * worktrees, and because of one rule that has to stay visible: **`--force` may exist only here.**
 * `GitWorktreeManager.remove` refuses a dirty worktree and never passes `--force`, so it can never
 * throw away work; a forced removal is a decision the merge and the discard actions take knowingly,
 * having first established that the work is either merged or explicitly being abandoned.
 *
 * Nothing here decides anything. Every method is one git command read into a typed answer, and the
 * order they are called in - and what a conflict means - belongs to `WorktreeMergeFlow`.
 *
 * **Which repository the MAIN COPY means is the caller's setting.** In `checkpoints` mode it is the
 * project's store, so every main-copy command carries a `--git-dir` prefix and the landing is
 * `--ff-only` rather than `--no-ff`: the worktree branch already contains the main copy by then, so
 * the fast-forward is structural and a refusal to fast-forward means the main copy moved under the
 * session rather than that anything conflicted. Worktree-side commands never carry a prefix in
 * either mode - a worktree already points at whichever repository cut it.
 */
export class GitMergeManager extends GitManager {
  /** Git says this when a merge stops on conflicts, which is a state to enter and not an error. */
  private static readonly conflictConst = /conflict|fix conflicts|automatic merge failed/i

  /** Git's words for a worktree that is not registered here: a second forced remove exits 128. */
  private static readonly worktreeAbsentConst = /is not a working tree|no such file or directory/i

  /**
   * Git's refusal to fast-forward, which in checkpoints mode is a STATE and not a failure: the main
   * copy moved after the session merged it in, so the answer is `diverged` and the caller merges
   * again rather than being told git broke. It matches none of the base class's signatures, so
   * without this it would come back as a bare `git-failed`.
   */
  private static readonly notFastForwardConst = /not possible to fast-forward/i

  /** And for a branch that is not there: a second `-d` or `-D` exits 1. */
  private static readonly branchAbsentConst = /branch .*not found/i

  /** A commit over a tree with nothing in it: git exits 1 and says so on stdout. */
  private static readonly nothingToCommitConst = /nothing to commit|no changes added to commit/i

  /** Git's own two-letter codes for an unmerged path, in porcelain v1. */
  private static readonly unresolvedCodesConst: readonly string[] =
    ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']
  private readonly teardownOwners = new Map<string, RepoCommandContext>()

  constructor(
    invoker: GitCommandRunner,
    private readonly checkpoints?: CheckpointModeContext,
  ) {
    super(invoker)
  }

  /**
   * Which branch the main copy is standing on. Null on a detached HEAD, which is a refusal the
   * caller words rather than a git failure: there is a HEAD, it is just not a branch to merge into.
   */
  async currentBranch(repositoryRoot: string): Promise<GitResult<{ branch: string | null }>> {
    const target = await this.contextFor(repositoryRoot)
    if (!target.ok) return target
    const outcome = await this.invoker.run(
      target.value.root,
      [...target.value.gitDirArgs, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    )
    // Exit 1 with no message is git's way of saying "not a symbolic ref", so a detached HEAD is
    // read here rather than reported as a command that went wrong.
    if (!outcome.failure && outcome.code === 1 && outcome.stderr.trim().length === 0)
      return { ok: true, value: { branch: null } }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: { branch: outcome.stdout.trim() } }
  }

  /** What state a working tree is in, which is what decides whether a merge may start here at all. */
  async mergeStatus(path: string): Promise<GitResult<MergeStatus>> {
    const target = await this.contextFor(path)
    if (!target.ok) return target
    const head = await this.invoker.run(
      target.value.root,
      [...target.value.gitDirArgs, 'rev-parse', '--quiet', '--verify', 'MERGE_HEAD'],
    )
    if (head.failure) {
      const failure = GitManager.failureOf(head, 'git-failed')
      if (failure) return failure
    }
    // `--quiet --verify` exits 1 with nothing on stderr when the ref is simply absent.
    const inProgress = head.code === 0
    const status = await this.invoker.run(
      target.value.root,
      [...target.value.gitDirArgs, 'status', '--porcelain=v1', '--untracked-files=all'],
    )
    const failure = GitManager.failureOf(status, 'git-failed')
    if (failure) return failure
    return {
      ok: true,
      value: {
        inProgress,
        dirty: status.stdout.trim().length > 0,
        dirtyTracked: GitMergeManager.hasTrackedChange(status.stdout),
        unresolved: GitMergeManager.hasUnresolved(status.stdout),
      },
    }
  }

  /**
   * Whether any line of a porcelain v1 status is a change to a file git already tracks.
   *
   * `??` is git's code for untracked, and it is the whole difference: one `git status` answers
   * both questions, so the caller about to force-remove a directory and the caller about to
   * merge into one can each ask their own without a second process.
   */
  private static hasTrackedChange(stdout: string): boolean {
    for (const line of stdout.split('\n')) {
      if (line.trim().length === 0) continue
      if (!line.startsWith('??')) return true
    }
    return false
  }

  /**
   * Whether any line of a porcelain v1 status is an unmerged entry.
   *
   * Git's own list: `DD AU UD UA DU AA UU`. Every one of them is a file with both sides still in it,
   * and `add --all` would resolve it by staging whatever is on disk - markers included - which is
   * precisely what must never be committed on somebody's behalf.
   */
  private static hasUnresolved(stdout: string): boolean {
    for (const line of stdout.split('\n')) {
      const code = line.slice(0, 2)
      if (GitMergeManager.unresolvedCodesConst.includes(code)) return true
    }
    return false
  }

  /**
   * Everything in the worktree, committed to the branch it is standing on.
   *
   * It exists so that finishing with a session is one action rather than a refusal: an agent leaves
   * its work uncommitted as a matter of course, and a merge cannot start over that. The commit lands
   * on the session's own branch and reaches the main copy only through the merge that follows, which
   * is the step somebody already confirms.
   *
   * A tree with nothing in it is not a failure. `add` is happy with nothing to add and `commit` exits
   * 1 saying so, and the caller asked for the work to be committed, which it now is.
   */
  async commitAll(worktreePath: string, message: string): Promise<GitResult<void>> {
    const foreign = await this.refuseForeignWorktree(worktreePath)
    if (foreign) return foreign
    const added = await this.invoker.run(worktreePath, ['add', '--all'])
    const addFailure = GitManager.failureOf(added, 'git-failed')
    if (addFailure) return addFailure
    // Hooks are the project's own, and a pre-commit hook that refuses is an answer worth hearing:
    // it comes back as the git failure it is rather than being skipped on the session's behalf.
    const committed = await this.invoker.run(worktreePath, ['commit', '--message', message])
    if (GitMergeManager.saysAbsent(committed, GitMergeManager.nothingToCommitConst))
      return { ok: true, value: undefined }
    const failure = GitManager.failureOf(committed, 'git-failed')
    if (failure) return failure
    return { ok: true, value: undefined }
  }

  /**
   * The base branch into the feature branch, run INSIDE the worktree. That direction is the whole
   * design: conflicts surface where the work was done and where the agent that did it can be asked
   * about them, rather than in the main copy somebody else is using.
   *
   * A conflict is answered as a value, and the merge is deliberately NOT aborted: the half-merged
   * state with its markers is exactly what a resolver needs to see.
   */
  async mergeIntoWorktree(
    worktreePath: string,
    baseBranch: string,
  ): Promise<GitResult<{ conflict: boolean }>> {
    const foreign = await this.refuseForeignWorktree(worktreePath)
    if (foreign) return foreign
    const outcome = await this.invoker.run(
      worktreePath,
      ['merge', '--no-edit', '--end-of-options', baseBranch],
    )
    if (!outcome.failure && outcome.code !== 0
      && GitMergeManager.conflictConst.test(`${outcome.stderr}\n${outcome.stdout}`))
      return { ok: true, value: { conflict: true } }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: { conflict: false } }
  }

  /** Whether the branch is already contained in the main copy's HEAD, which makes a merge a no-op. */
  async isMerged(repositoryRoot: string, branch: string): Promise<GitResult<boolean>> {
    const target = await this.contextFor(repositoryRoot)
    if (!target.ok) return target
    const outcome = await this.invoker.run(
      target.value.root,
      [...target.value.gitDirArgs, 'merge-base', '--is-ancestor', '--end-of-options', branch, 'HEAD'],
    )
    // 0 is ancestor, 1 is not; anything else is a real failure.
    if (!outcome.failure && (outcome.code === 0 || outcome.code === 1))
      return { ok: true, value: outcome.code === 0 }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: false }
  }

  /**
   * A checkpoint of the main copy, which is the step that makes the landing safe: the user's own
   * uncommitted work becomes a SIDE of the merge rather than something the merge would have to
   * refuse or overwrite.
   *
   * A delegate rather than a second implementation - the store owns what a checkpoint is - and it
   * sits here because the merge flow talks to one collaborator for the whole merge. In `git` mode
   * there is no store and the flow never calls it; a call that arrives anyway is refused rather
   * than answered `ok`, because a silent success would report a checkpoint that never happened.
   */
  /** The session's own side, so a merge never asks the user to commit what the mode exists to absorb. */
  async checkpointWorktree(worktreePath: string, message: string): Promise<GitResult<void>> {
    const store = this.checkpointStore()
    if (store === null)
      return {
        ok: false,
        code: 'git-failed',
        detail: 'A worktree is checkpointed only in checkpoints mode, and this one is in git mode',
      }
    return store.checkpointWorktree(worktreePath, message)
  }

  async checkpointMain(repositoryRoot: string, message: string): Promise<GitResult<void>> {
    const store = this.checkpointStore()
    if (store === null)
      return {
        ok: false,
        code: 'git-failed',
        detail: 'A main copy is checkpointed only in checkpoints mode, and this one is in git mode',
      }
    return store.checkpoint(repositoryRoot, message)
  }

  /**
   * The feature branch into the main copy, which is where the two modes genuinely differ.
   *
   * In `git` mode it is `--no-ff` on purpose: the merge commit is what makes the session visible in
   * the history afterwards, and a fast-forward would leave no trace that the work happened on a
   * branch of its own.
   *
   * In `checkpoints` mode it is `--ff-only`, and the reason is safety rather than tidiness. The
   * caller merges the main copy INTO the session branch first, so by the time this runs the branch
   * already contains the main copy and the fast-forward is structural - measured 2026-08-27. That
   * means conflict markers can never be written into the human's own working copy: a real
   * disagreement surfaces earlier, in the throwaway worktree where it can be resolved. What is left
   * are two answers git gives here, both of which leave the copy exactly as it was: a main copy that
   * moved on (`diverged`, merge again) and a tracked file the user is editing right now (`dirty`,
   * git's own refusal, read by the base class).
   */
  async mergeToMain(
    repositoryRoot: string,
    branch: string,
  ): Promise<GitResult<{ conflict: boolean; diverged: boolean }>> {
    const target = await this.contextFor(repositoryRoot)
    if (!target.ok) return target
    if (target.value.storeDir !== null) {
      const landed = await this.invoker.run(
        target.value.root,
        [...target.value.gitDirArgs, 'merge', '--ff-only', '--end-of-options', branch],
      )
      // Checked BEFORE the base class reads the outcome: git's fast-forward refusal matches none
      // of its signatures, so it would otherwise come back as a bare `git-failed`.
      if (GitMergeManager.saysAbsent(landed, GitMergeManager.notFastForwardConst))
        return { ok: true, value: { conflict: false, diverged: true } }
      const landingFailure = GitManager.failureOf(landed, 'git-failed')
      if (landingFailure) return landingFailure
      return { ok: true, value: { conflict: false, diverged: false } }
    }
    const outcome = await this.invoker.run(
      repositoryRoot,
      ['merge', '--no-ff', '--no-edit', '--end-of-options', branch],
    )
    // Read the same way `mergeIntoWorktree` reads it, and for a sharper reason: git's conflict
    // text matches none of the failure signatures, so this used to fall through as `git-failed`
    // and leave the user's OWN copy holding MERGE_HEAD and markers under a message that said
    // only that git had failed.
    if (!outcome.failure && outcome.code !== 0
      && GitMergeManager.conflictConst.test(`${outcome.stderr}\n${outcome.stdout}`))
      return { ok: true, value: { conflict: true, diverged: false } }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: { conflict: false, diverged: false } }
  }

  /**
   * The one forced removal in this library. It is reached only after the worktree has been asked
   * what is in it and the branch is established as merged, or after a person answered a two-step
   * confirmation about abandoning it.
   */
  async removeWorktreeForced(repositoryRoot: string, worktreePath: string): Promise<GitResult<void>> {
    const target = await this.teardownOwner(repositoryRoot, worktreePath)
    if (!target.ok) return target
    if (target.value === null) return { ok: true, value: undefined }
    this.teardownOwners.set(PathCompare.comparable(worktreePath), target.value)
    const outcome = await this.invoker.run(
      target.value.root,
      [...target.value.gitDirArgs, 'worktree', 'remove', '--force', '--end-of-options', worktreePath],
    )
    if (GitMergeManager.saysAbsent(outcome, GitMergeManager.worktreeAbsentConst)) {
      if (!(await GitManager.exists(worktreePath))) return { ok: true, value: undefined }
    }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: undefined }
  }

  /** `-d` refuses a branch that is not merged, which is the safety; `-D` is the discard saying so. */
  async deleteBranch(
    repositoryRoot: string,
    branch: string,
    force: boolean,
    worktreePath: string,
  ): Promise<GitResult<void>> {
    const ownerKey = PathCompare.comparable(worktreePath)
    const target = await this.branchTeardownOwner(repositoryRoot, worktreePath, branch)
    if (!target.ok) return target
    if (target.value === null) {
      this.teardownOwners.delete(ownerKey)
      return { ok: true, value: undefined }
    }
    const outcome = await this.invoker.run(
      target.value.root,
      [...target.value.gitDirArgs, 'branch', force ? '-D' : '-d', '--end-of-options', branch],
    )
    if (GitMergeManager.saysAbsent(outcome, GitMergeManager.branchAbsentConst)) {
      this.teardownOwners.delete(ownerKey)
      return { ok: true, value: undefined }
    }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    this.teardownOwners.delete(ownerKey)
    return { ok: true, value: undefined }
  }

  private async teardownOwner(
    repositoryRoot: string,
    worktreePath: string,
  ): Promise<GitResult<RepoCommandContext | null>> {
    if (this.checkpoints === undefined)
      return { ok: true, value: GitMergeManager.humanContext(repositoryRoot) }
    const checkpoint = await this.checkpoints.store.contextOfWorktree(worktreePath)
    if (checkpoint !== null) return { ok: true, value: checkpoint }
    if (await GitManager.exists(join(worktreePath, '.git')))
      return { ok: true, value: GitMergeManager.humanContext(repositoryRoot) }
    if (!(await GitManager.exists(worktreePath))) return { ok: true, value: null }
    return {
      ok: false,
      code: 'git-failed',
      detail: `${worktreePath} still exists but no longer identifies the repository that owns it`,
    }
  }

  private async branchTeardownOwner(
    repositoryRoot: string,
    worktreePath: string,
    branch: string,
  ): Promise<GitResult<RepoCommandContext | null>> {
    const key = PathCompare.comparable(worktreePath)
    const remembered = this.teardownOwners.get(key)
    if (remembered !== undefined) return { ok: true, value: remembered }
    const worktree = await this.teardownOwner(repositoryRoot, worktreePath)
    if (!worktree.ok || worktree.value !== null) return worktree
    let checkpoint: RepoCommandContext | null = null
    if (this.checkpoints !== undefined) {
      const found = await this.checkpoints.store.existingContextOf(repositoryRoot)
      if (!found.ok) return found
      checkpoint = found.value
    }
    const human = await GitManager.exists(join(repositoryRoot, '.git'))
      ? GitMergeManager.humanContext(repositoryRoot)
      : null
    const checkpointOwns = checkpoint === null
      ? { ok: true as const, value: false }
      : await this.branchExists(checkpoint, branch)
    if (!checkpointOwns.ok) return checkpointOwns
    const humanOwns = human === null
      ? { ok: true as const, value: false }
      : await this.branchExists(human, branch)
    if (!humanOwns.ok) return humanOwns
    if (checkpointOwns.value && !humanOwns.value)
      return { ok: true, value: checkpoint }
    if (!checkpointOwns.value && !humanOwns.value) return { ok: true, value: null }
    return {
      ok: false,
      code: 'git-failed',
      detail: checkpointOwns.value
        ? `Both the checkpoint store and project .git hold ${branch}; the removed worktree's repository cannot be inferred safely`
        : `Project .git holds ${branch}, but an existing checkpoint store and an absent worktree leave its repository affinity unknown`,
    }
  }

  private async branchExists(
    target: RepoCommandContext,
    branch: string,
  ): Promise<GitResult<boolean>> {
    const outcome = await this.invoker.run(target.root, [
      ...target.gitDirArgs,
      'show-ref', '--verify', '--quiet', `refs/heads/${branch}`,
    ])
    if (!outcome.failure && outcome.code === 0) return { ok: true, value: true }
    if (!outcome.failure && outcome.code === 1) return { ok: true, value: false }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    throw new Error(`Unexpected branch probe outcome: ${JSON.stringify(outcome)}`)
  }

  private static humanContext(repositoryRoot: string): RepoCommandContext {
    return { root: repositoryRoot, gitDirArgs: [], storeDir: null }
  }

  /**
   * Whether git refused because the thing was already gone.
   *
   * These three are the only commands here that are asked for a STATE rather than for work, so they
   * are the only ones where "it was already like that" is the outcome asked for. Two of them end a
   * teardown, and a teardown that could not be repeated is one nobody can finish: a crash or a
   * refusal between the removal and the branch leaves the first step done, and every later attempt
   * dies on it while the branch stays. A second `worktree remove --force` exits 128 with `is not a
   * working tree`; a second `branch -D` exits 1 with `branch '<x>' not found`. The third is the
   * commit, where a tree with nothing left to commit is the state the caller asked for.
   *
   * A git that could not run at all is never read this way. It said nothing about the target.
   */
  private static saysAbsent(outcome: GitCommandOutcome, pattern: RegExp): boolean {
    if (outcome.failure || outcome.code === 0) return false
    return pattern.test(`${outcome.stderr}\n${outcome.stdout}`)
  }

  /**
   * The store this operation runs against, or null for git mode. Read ONCE per public operation:
   * a mode that changed halfway through one would land the branch in one repository having read
   * the state of another.
   */
  private checkpointStore(): GitCheckpointStore | null {
    const context = this.checkpoints
    if (context === undefined) return null
    const mode = context.modeOf()
    if (mode === 'checkpoints') return context.store
    else if (mode === 'git') return null
    else throw new Error(`Unknown versioning mode: ${JSON.stringify(mode)}`)
  }

  /**
   * Where a command runs and what goes in front of it, for a path that may be either the main copy
   * or a worktree. A worktree is a plain git context in both modes, which is why it is asked about
   * first; everything else is the main copy, and in checkpoints mode that is the store.
   */
  private async contextFor(path: string): Promise<GitResult<RepoCommandContext>> {
    const store = this.checkpointStore()
    if (store === null) return { ok: true, value: { root: path, gitDirArgs: [], storeDir: null } }
    if (await store.worktreeBelongsToStore(path))
      return { ok: true, value: { root: path, gitDirArgs: [], storeDir: null } }
    return store.contextOf(path)
  }

  /**
   * The disk guard of the hard cut: a worktree carrying a `.git` that points somewhere other than a
   * checkpoint store was cut from a project git, before the cut. Read from DISK rather than from a
   * field on the record, because the record was written by the version that did not know the
   * difference.
   *
   * Without it, a forced removal aimed at the store would be answered `is not a working tree`, read
   * as `already gone`, and the session record deleted over a directory still full of work.
   *
   * A worktree with no `.git` at all is NOT foreign, it is gone: a teardown interrupted after the
   * removal has to stay repeatable, which is the whole reason `saysAbsent` exists downstream.
   */
  private async refuseForeignWorktree(
    worktreePath: string,
  ): Promise<{ ok: false; code: GitErrorCode; detail: string } | null> {
    const store = this.checkpointStore()
    if (store === null) return null
    if (!(await GitManager.exists(join(worktreePath, '.git')))) return null
    if (await store.worktreeBelongsToStore(worktreePath)) return null
    return {
      ok: false,
      code: 'git-failed',
      detail: `${worktreePath} was cut from a project .git rather than from a checkpoint store; `
        + 'finish it in git mode before switching back',
    }
  }
}
