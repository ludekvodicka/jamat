/**
 * The git subsystem's own vocabulary: what a worktree is worth knowing about, what can go wrong, and
 * the one call the manager makes of a git process. Everything here is data - no `node:` import, no
 * runtime code - so the session records and the wire types can name these shapes freely.
 */

export interface WorktreeFacts {
  worktreePath: string
  branch: string
  baseCommit: string
  repositoryRoot: string
}

export interface WorktreeDiff {
  added: number
  removed: number
  changedFiles: number
  capturedAt: number
}

/**
 * Which repository AppJamatV3 puts AI work in. `checkpoints` is the default and the only mode the
 * shared instructions know; `git` exists for somebody running AppJamatV3 without them, who wants to
 * work over the project's own git directly. It is one global setting, not a per-project one.
 */
export type VersioningMode = 'checkpoints' | 'git'

/**
 * How a manager targets a command at the MAIN COPY. In `checkpoints` mode that means the store with
 * the project as its work tree; in `git` mode, and inside any worktree, it means plain `git -C`, so
 * the prefix is empty and `storeDir` is null. Commands that run INSIDE a worktree never need this:
 * a worktree already points at whichever repository cut it.
 */
export interface RepoCommandContext {
  root: string
  /** `['--git-dir', storeDir, '--work-tree', root]` in checkpoints mode; empty otherwise. */
  gitDirArgs: string[]
  storeDir: string | null
}

export type GitErrorCode =
  | 'git-missing'
  | 'not-a-repo'
  | 'dirty'
  | 'locked'
  | 'missing-base'
  | 'worktree-exists'
  | 'git-failed'

export type GitResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: GitErrorCode; detail: string }

/**
 * Why a git command produced no exit status of its own. `cwd-missing` is separate from `git-missing`
 * because the operating system is not: a directory that is gone fails the spawn with the same ENOENT
 * a machine without git does, so nothing downstream could tell a deleted worktree from a missing git.
 */
export type GitCommandFailure =
  | 'git-missing'
  | 'cwd-missing'
  | 'spawn-failed'
  | 'timeout'
  | 'output-limit'

export interface GitCommandOutcome {
  code: number
  stdout: string
  stderr: string
  /** Null when git ran to completion. While it is set, `code` says nothing. */
  failure: GitCommandFailure | null
}

/** All the worktree manager needs of a git process, so a test can hand it a scripted one instead. */
export interface GitCommandRunner {
  run(cwd: string, args: string[]): Promise<GitCommandOutcome>
}
