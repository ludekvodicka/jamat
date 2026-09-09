import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { WorktreeNaming } from './worktreeNaming'
import { GitCheckpointStore } from './gitCheckpointStore'
import type { CheckpointModeContext } from './gitCheckpointStore'
import { GitManager } from './gitManager'
import type {
  GitCommandRunner,
  GitResult,
  RepoCommandContext,
  WorktreeDiff,
  WorktreeFacts,
} from './git.types'

/**
 * Where a repository's worktrees are cut from. `commonDir` is where the ignore is appended, which in
 * checkpoints mode is the store's own exclude list and never the human's `.git`; `gitDirArgs` is
 * empty in git mode, so the commands stay the plain `git -C <root>` they have always been.
 */
/** One entry of `worktree list --porcelain`. `bare` marks a repository, not a working tree. */
interface ParsedWorktree {
  worktreePath: string
  branch: string
  baseCommit: string
  bare: boolean
}

interface WorktreeIdentity {
  repositoryRoot: string
  commonDir: string
  gitDirArgs: string[]
  store: GitCheckpointStore | null
}

/**
 * Worktrees for agent sessions: create, list, measure, remove. Every failure is a returned code, so
 * a project without git and a project that is not a git repository at all both leave the session
 * perfectly usable - just without a worktree.
 *
 * Two placements carry the weight, and neither is negotiable:
 *
 * 1. **The worktree lives INSIDE the repository**, at `<repositoryRoot>/.worktrees/<slug>`. A sibling
 *    directory beside the repository root was the obvious alternative and is wrong here: these
 *    projects are SVN working copies, and a directory next to the root turns up as an unversioned
 *    entry the next SVN commit offers to add.
 * 2. **The ignore is appended to `<gitCommonDir>/info/exclude`**, never to `.gitignore`. The
 *    `.gitignore` is a versioned file in someone else's repository, so editing it silently would show
 *    up in both a git and an SVN commit - the exact thing placement 1 exists to avoid. The common
 *    directory is asked for rather than assumed, because a repository that is itself a worktree has
 *    a `.git` file and its exclude lives with the repository it was linked from.
 *
 * **Which repository a worktree is cut FROM is the caller's setting, not this class's.** In
 * `checkpoints` mode both placements above still hold, and the repository is the project's checkpoint
 * store: the cut needs a HEAD, so `create` takes a checkpoint of the main copy first, which is also
 * what makes a project with no version control at all isolatable by one call. In `git` mode nothing
 * here behaves differently from the day before checkpoints existed - a manager built without a
 * checkpoint context runs the identical commands.
 *
 * There is no journal, no lease and no fencing around any of this, and that is measured rather than
 * hoped: on 2026-08-04 four parallel `worktree add -b` runs all finished exit 0 with a consistent
 * listing, and `add` + `remove` + `prune` + `add` at the same time produced no error either - git
 * locks refs and metadata per item. What does leave a dangling `prunable` entry is a worktree
 * directory deleted by hand, which is why `remove` goes through git and this class never unlinks
 * one. Measurements: `.aidocs/plans/2026-08-04-009e-feat-worktree-provisioning-and-merge-plan.md`.
 */
export class GitWorktreeManager extends GitManager {
  private static readonly excludeLineConst =
    `/${WorktreeNaming.folderNameConst}/`
  private static readonly diffThrottleMillisecondsConst = 30_000
  /** What a stored base may look like before it is handed back to git as a revision. */
  private static readonly commitShaConst = /^[0-9a-f]{4,40}$/i
  private readonly diffs = new Map<string, WorktreeDiff>()

  constructor(
    invoker: GitCommandRunner,
    private readonly checkpoints?: CheckpointModeContext,
  ) {
    super(invoker)
  }

  /** The naming rule itself is `WorktreeNaming`'s; the launcher draws a preview from the same one. */
  static slugOf(value: string): string {
    return WorktreeNaming.slugOf(value)
  }

  /** `-b` is not optional: a worktree left on a detached HEAD cannot be merged back afterwards. */
  /**
   * Where THIS project's worktrees are cut, which is not always under the project itself: a
   * catalog project may point at a package inside a monorepo, and `create` puts the worktree under
   * the repository ROOT. Anything counting what has been cut has to look in the same place.
   *
   * Null for a path that is not in a repository, which is not a failure - a project with no git has
   * no worktrees to find.
   */
  async worktreesDirectoryOf(projectPath: string): Promise<string | null> {
    const identity = await this.identityOf(projectPath)
    if (!identity.ok) return null
    return join(identity.value.repositoryRoot, WorktreeNaming.folderNameConst)
  }

  async create(
    repositoryRoot: string,
    slug: string,
    baseRef?: string,
  ): Promise<GitResult<WorktreeFacts>> {
    const name = GitWorktreeManager.slugOf(slug)
    if (!name)
      return {
        ok: false,
        code: 'git-failed',
        detail: `A worktree slug needs at least one letter or digit: ${JSON.stringify(slug)}`,
      }
    const identity = await this.identityOf(repositoryRoot)
    if (!identity.ok) return identity
    if (identity.value.store !== null) {
      // The checkpoint lives INSIDE create so no caller can skip it, and it is the same call that
      // gives a brand-new store the HEAD `worktree add` then cuts from. Ordered before the base is
      // resolved for exactly that reason: a store with no commit has no HEAD to resolve.
      const checkpointed = await identity.value.store.checkpoint(
        identity.value.repositoryRoot,
        `Checkpoint in the main copy before cutting worktree ${name}`,
      )
      if (!checkpointed.ok) return checkpointed
    }
    const base = await this.resolveCommit(
      identity.value.repositoryRoot,
      identity.value.gitDirArgs,
      baseRef ?? 'HEAD',
    )
    if (!base.ok) return base
    const worktreePath = join(
      identity.value.repositoryRoot,
      WorktreeNaming.folderNameConst,
      name,
    )
    if (await GitManager.exists(worktreePath))
      return { ok: false, code: 'worktree-exists', detail: `${worktreePath} already exists` }
    const excluded = await GitWorktreeManager.ensureExcluded(identity.value.commonDir)
    if (!excluded.ok) return excluded
    const branch = WorktreeNaming.branchOf(name)
    const added = await this.invoker.run(
      identity.value.repositoryRoot,
      [...identity.value.gitDirArgs, 'worktree', 'add', '-b', branch, worktreePath, base.value],
    )
    const failure = GitManager.failureOf(added, 'git-failed')
    if (failure) return failure
    return {
      ok: true,
      value: {
        worktreePath,
        branch,
        baseCommit: base.value,
        repositoryRoot: identity.value.repositoryRoot,
      },
    }
  }

  async list(repositoryRoot: string): Promise<GitResult<WorktreeFacts[]>> {
    const target = await this.targetOf(repositoryRoot)
    if (!target.ok) return target
    const listed = await this.invoker.run(
      target.value.root,
      [...target.value.gitDirArgs, 'worktree', 'list', '--porcelain', '-z'],
    )
    const failure = GitManager.failureOf(listed, 'not-a-repo')
    if (failure) return failure
    // A checkpoint store answers this listing with ITSELF as the first entry, marked `bare`, even
    // with `--work-tree` set - measured 2026-08-27. It is a repository, not a working tree, so it is
    // dropped: left in, it would draw as a worktree with no branch and no commit.
    const trees = GitWorktreeManager.parseWorktrees(listed.stdout).filter((entry) => !entry.bare)
    // The main worktree is what git lists first, and it is the only report of where the repository
    // actually sits when the caller handed in a subdirectory. A store reports no main worktree at
    // all, so there the root is the one the context already resolved.
    const root = target.value.storeDir !== null
      ? target.value.root
      : trees[0]?.worktreePath ?? resolve(repositoryRoot)
    return {
      ok: true,
      value: trees.map((entry) => ({
        worktreePath: entry.worktreePath,
        branch: entry.branch,
        baseCommit: entry.baseCommit,
        repositoryRoot: root,
      })),
    }
  }

  /**
   * Tracked line counts against the base plus the number of untracked files, throttled to one
   * measurement per worktree per 30 s. `force` is the user asking for it now, which the throttle does
   * not stand in the way of.
   */
  async refreshDiff(
    worktreePath: string,
    baseCommit: string,
    options?: { force?: boolean },
  ): Promise<GitResult<WorktreeDiff>> {
    const key = PathCompare.comparable(worktreePath)
    const cached = this.diffs.get(key)
    if (cached && options?.force !== true
      && Date.now() - cached.capturedAt < GitWorktreeManager.diffThrottleMillisecondsConst)
      return { ok: true, value: cached }
    // The shape is checked here rather than in the caller: `--` only separates revisions from
    // pathspecs, so a dash-leading value in front of it is still read as an option. What stops that
    // is `--end-of-options`, and what stops a base that is not a revision at all is this test.
    if (!GitWorktreeManager.commitShaConst.test(baseCommit))
      return {
        ok: false,
        code: 'missing-base',
        detail: `Base is not a commit id: ${JSON.stringify(baseCommit)}`,
      }
    const numstat = await this.invoker.run(
      worktreePath,
      ['diff', '--numstat', '--end-of-options', baseCommit, '--'],
    )
    const numstatFailure = GitManager.failureOf(numstat, 'missing-base')
    if (numstatFailure) return numstatFailure
    const status = await this.invoker.run(
      worktreePath,
      ['status', '--porcelain=v1', '--untracked-files=all'],
    )
    const statusFailure = GitManager.failureOf(status, 'git-failed')
    if (statusFailure) return statusFailure
    const diff = GitWorktreeManager.diffOf(numstat.stdout, status.stdout)
    this.diffs.set(key, diff)
    return { ok: true, value: diff }
  }

  /**
   * The tree is read before anything is attempted, so uncommitted work is refused as `dirty` while
   * the worktree is still whole. `--force` is never passed: throwing away a user's changes is not
   * this library's decision to make.
   *
   * A failing `git worktree remove` ends the operation. The directory is never unlinked as a
   * fallback: removing it behind git's back is exactly what leaves the `prunable` metadata that a
   * later `worktree add` then trips over. The worktree's own `.git` pointer selects a checkpoint
   * store even if the global setting changed after creation.
   */
  async remove(repositoryRoot: string, worktreePath: string): Promise<GitResult<void>> {
    const checkpoint = await this.checkpoints?.store.contextOfWorktree(worktreePath) ?? null
    const target: RepoCommandContext = checkpoint ?? {
      root: repositoryRoot,
      gitDirArgs: [],
      storeDir: null,
    }
    const status = await this.invoker.run(
      worktreePath,
      ['status', '--porcelain=v1', '--untracked-files=all'],
    )
    const statusFailure = GitManager.failureOf(status, 'git-failed')
    if (statusFailure) return statusFailure
    if (status.stdout.trim().length > 0)
      return {
        ok: false,
        code: 'dirty',
        detail: `${worktreePath} holds changes that are not committed`,
      }
    const removed = await this.invoker.run(target.root, [
      ...target.gitDirArgs,
      'worktree', 'remove', '--end-of-options', worktreePath,
    ])
    const failure = GitManager.failureOf(removed, 'git-failed')
    if (failure) return failure
    this.diffs.delete(PathCompare.comparable(worktreePath))
    return { ok: true, value: undefined }
  }

  /**
   * The facts do not remember which ref the base was taken from, so the repository's own HEAD is the
   * evidence there is: a worktree branched from an explicit ref reports moved once HEAD moves.
   */
  async baseMoved(repositoryRoot: string, facts: WorktreeFacts): Promise<GitResult<boolean>> {
    const target = await this.targetOf(repositoryRoot)
    if (!target.ok) return target
    const head = await this.resolveCommit(target.value.root, target.value.gitDirArgs, 'HEAD')
    if (!head.ok) return head
    return { ok: true, value: head.value !== facts.baseCommit }
  }

  /**
   * The store this operation runs against, or null for git mode. Called ONCE per public operation:
   * two readings inside one `create` could take the checkpoint in one repository and cut the
   * worktree from another.
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
   * Where a MAIN-COPY command runs and what goes in front of it. In git mode it is a passthrough
   * costing no process at all, so a manager built without a checkpoint context issues the identical
   * commands it always has. Commands that run INSIDE a worktree never ask: a worktree already points
   * at whichever repository cut it. Removal is the exception because the command runs from the
   * owning main repository, so it derives that owner from the worktree pointer first.
   */
  private async targetOf(path: string): Promise<GitResult<RepoCommandContext>> {
    const store = this.checkpointStore()
    if (store === null) return { ok: true, value: { root: path, gitDirArgs: [], storeDir: null } }
    const found = await store.rootOf(path)
    if (!found.ok) return found
    return {
      ok: true,
      value: {
        root: found.value.root,
        gitDirArgs: GitWorktreeManager.targetArgs(found.value.root, found.value.storeDir),
        storeDir: found.value.storeDir,
      },
    }
  }

  private static targetArgs(root: string, storeDir: string): string[] {
    return ['--git-dir', storeDir, '--work-tree', root]
  }

  private async identityOf(path: string): Promise<GitResult<WorktreeIdentity>> {
    const store = this.checkpointStore()
    if (store !== null) {
      // `rootOf` creates nothing: the nearest store above, else the git toplevel, else the path
      // itself. That last case is what lets a project with no version control answer at all, and it
      // is where `create` then puts the store.
      const found = await store.rootOf(path)
      if (!found.ok) return found
      return {
        ok: true,
        value: {
          repositoryRoot: found.value.root,
          commonDir: found.value.storeDir,
          gitDirArgs: GitWorktreeManager.targetArgs(found.value.root, found.value.storeDir),
          store,
        },
      }
    }
    const top = await this.invoker.run(path, ['rev-parse', '--show-toplevel'])
    const topFailure = GitManager.failureOf(top, 'not-a-repo')
    if (topFailure) return topFailure
    const repositoryRoot = resolve(top.stdout.trim())
    const common = await this.invoker.run(repositoryRoot, ['rev-parse', '--git-common-dir'])
    const commonFailure = GitManager.failureOf(common, 'not-a-repo')
    if (commonFailure) return commonFailure
    const raw = common.stdout.trim()
    return {
      ok: true,
      value: {
        repositoryRoot,
        commonDir: isAbsolute(raw) ? resolve(raw) : resolve(repositoryRoot, raw),
        gitDirArgs: [],
        store: null,
      },
    }
  }

  private async resolveCommit(
    repositoryRoot: string,
    gitDirArgs: string[],
    ref: string,
  ): Promise<GitResult<string>> {
    const resolved = await this.invoker.run(
      repositoryRoot,
      [...gitDirArgs, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    )
    const failure = GitManager.failureOf(resolved, 'missing-base')
    if (failure) return failure
    return { ok: true, value: resolved.stdout.trim() }
  }

  /** Appended, never rewritten, and only when the line is not already there. */
  private static async ensureExcluded(commonDir: string): Promise<GitResult<void>> {
    const file = join(commonDir, 'info', 'exclude')
    try {
      const current = await GitWorktreeManager.readIfPresent(file)
      if (current !== null
        && current.split(/\r?\n/).some((line) => line.trim() === GitWorktreeManager.excludeLineConst))
        return { ok: true, value: undefined }
      await mkdir(dirname(file), { recursive: true })
      const separator = current === null || current.length === 0 || current.endsWith('\n') ? '' : '\n'
      await appendFile(file, `${separator}${GitWorktreeManager.excludeLineConst}\n`, 'utf8')
      return { ok: true, value: undefined }
    } catch (error) {
      return {
        ok: false,
        code: 'git-failed',
        detail: `Could not write ${file}: ${ErrorText.of(error)}`,
      }
    }
  }

  private static async readIfPresent(file: string): Promise<string | null> {
    try { return await readFile(file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * `-z` terminates every attribute with a NUL and every entry with a second one, but git's own
   * porcelain writers have shipped both forms, so newlines are split as well. `HEAD` is the commit
   * the worktree stands on right now: the listing has no memory of the base it was created from.
   */
  private static parseWorktrees(raw: string): ParsedWorktree[] {
    const facts: ParsedWorktree[] = []
    let current: ParsedWorktree | null = null
    for (const token of raw.split('\0').flatMap((part) => part.split(/\r?\n/))) {
      if (!token) continue
      if (token.startsWith('worktree ')) {
        if (current) facts.push(current)
        current = {
          worktreePath: resolve(token.slice('worktree '.length)),
          branch: '',
          baseCommit: '',
          bare: false,
        }
      }
      else if (!current) continue
      else if (token === 'bare') current.bare = true
      else if (token.startsWith('HEAD ')) current.baseCommit = token.slice('HEAD '.length)
      else if (token.startsWith('branch '))
        current.branch = token.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
    if (current) facts.push(current)
    return facts
  }

  /** A binary file reports "-" in both columns and still counts as a changed file. */
  private static diffOf(numstat: string, status: string): WorktreeDiff {
    let added = 0
    let removed = 0
    let changedFiles = 0
    for (const line of numstat.split('\n')) {
      const columns = line.trim().split('\t')
      if (columns.length < 3) continue
      changedFiles++
      added += Number.parseInt(columns[0], 10) || 0
      removed += Number.parseInt(columns[1], 10) || 0
    }
    // Untracked files are counted, never read: a file count is honest and cheap, a line count for
    // them is neither.
    const untracked = status.split('\n').filter((line) => line.startsWith('?? ')).length
    return { added, removed, changedFiles: changedFiles + untracked, capturedAt: Date.now() }
  }

}
