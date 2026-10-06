import { GitManager } from './gitManager'
import type { GitCommandOutcome, GitResult } from './git.types'

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
 * order they are called in - and what a conflict means - belongs to `WorktreeMergeFlow`. The main
 * copy is always the project's own repository.
 */
export class GitMergeManager extends GitManager {
  /** Git says this when a merge stops on conflicts, which is a state to enter and not an error. */
  private static readonly conflictConst = /conflict|fix conflicts|automatic merge failed/i

  /** Git's words for a worktree that is not registered here: a second forced remove exits 128. */
  private static readonly worktreeAbsentConst = /is not a working tree|no such file or directory/i

  /** And for a branch that is not there: a second `-d` or `-D` exits 1. */
  private static readonly branchAbsentConst = /branch .*not found/i

  /** A commit over a tree with nothing in it: git exits 1 and says so on stdout. */
  private static readonly nothingToCommitConst = /nothing to commit|no changes added to commit/i

  /** Git's own two-letter codes for an unmerged path, in porcelain v1. */
  private static readonly unresolvedCodesConst: readonly string[] =
    ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']

  /**
   * Which branch the main copy is standing on. Null on a detached HEAD, which is a refusal the
   * caller words rather than a git failure: there is a HEAD, it is just not a branch to merge into.
   */
  async currentBranch(repositoryRoot: string): Promise<GitResult<{ branch: string | null }>> {
    const outcome = await this.invoker.run(
      repositoryRoot,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
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
    const head = await this.invoker.run(path, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])
    if (head.failure) {
      const failure = GitManager.failureOf(head, 'git-failed')
      if (failure) return failure
    }
    // `--quiet --verify` exits 1 with nothing on stderr when the ref is simply absent.
    const inProgress = head.code === 0
    const status = await this.invoker.run(path, ['status', '--porcelain=v1', '--untracked-files=all'])
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
    const outcome = await this.invoker.run(
      repositoryRoot,
      ['merge-base', '--is-ancestor', '--end-of-options', branch, 'HEAD'],
    )
    // 0 is ancestor, 1 is not; anything else is a real failure.
    if (!outcome.failure && (outcome.code === 0 || outcome.code === 1))
      return { ok: true, value: outcome.code === 0 }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: false }
  }

  /**
   * The feature branch into the main copy, `--no-ff` on purpose: the merge commit is what makes the
   * session visible in the history afterwards, and a fast-forward would leave no trace that the work
   * happened on a branch of its own.
   */
  async mergeToMain(repositoryRoot: string, branch: string): Promise<GitResult<{ conflict: boolean }>> {
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
      return { ok: true, value: { conflict: true } }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: { conflict: false } }
  }

  /**
   * The one forced removal in this library. It is reached only after the worktree has been asked
   * what is in it and the branch is established as merged, or after a person answered a two-step
   * confirmation about abandoning it.
   */
  async removeWorktreeForced(repositoryRoot: string, worktreePath: string): Promise<GitResult<void>> {
    const outcome = await this.invoker.run(
      repositoryRoot,
      ['worktree', 'remove', '--force', '--end-of-options', worktreePath],
    )
    if (GitMergeManager.saysAbsent(outcome, GitMergeManager.worktreeAbsentConst)) {
      if (!(await GitManager.exists(worktreePath))) return { ok: true, value: undefined }
    }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: undefined }
  }

  /** `-d` refuses a branch that is not merged, which is the safety; `-D` is the discard saying so. */
  async deleteBranch(repositoryRoot: string, branch: string, force: boolean): Promise<GitResult<void>> {
    const outcome = await this.invoker.run(
      repositoryRoot,
      ['branch', force ? '-D' : '-d', '--end-of-options', branch],
    )
    if (GitMergeManager.saysAbsent(outcome, GitMergeManager.branchAbsentConst))
      return { ok: true, value: undefined }
    const failure = GitManager.failureOf(outcome, 'git-failed')
    if (failure) return failure
    return { ok: true, value: undefined }
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
}
