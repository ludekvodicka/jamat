import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { CheckpointLayout } from './checkpointLayout'
import { GitManager } from './gitManager'
import type {
  GitCommandOutcome,
  GitResult,
  RepoCommandContext,
  VersioningMode,
} from './git.types'

/**
 * What a manager needs to work over checkpoint stores instead of the project's own git: which
 * mode is set, and the store to use when it is `checkpoints`.
 *
 * Named ONCE and shared by every manager that takes one, because the two halves only mean
 * something together: a store nothing decides to use is a capability, and a mode nothing can act
 * on is an opinion. Absent altogether means `git` mode, which is what every caller written before
 * checkpoints existed gets.
 */
export interface CheckpointModeContext {
  modeOf: () => VersioningMode
  store: GitCheckpointStore
}

/**
 * The checkpoint store: finding it, creating it, and writing a checkpoint into it.
 *
 * It owns no timer and no cache. Every answer is read off the disk when asked, because the store is
 * shared with a bash implementation that can create one at any moment (a plain Claude session in a
 * terminal), so a remembered answer would be a guess about a directory somebody else also writes.
 *
 * The layout it implements is the contract in `checkpointLayout.ts`; the reasoning behind each rule
 * lives with that contract rather than being repeated here.
 */
export class GitCheckpointStore extends GitManager {
  /**
   * Which project owns the store for this path, without creating anything.
   *
   * The order is the contract's: an existing store in the nearest ancestor wins, because once a
   * project has one it is the answer for everything beneath it; then the git toplevel, so a package
   * inside a monorepo checkpoints the whole tree a worktree would have to be cut from; then the path
   * itself, which only ever happens when the caller named a project directly.
   */
  async rootOf(path: string): Promise<GitResult<{ root: string; storeDir: string; exists: boolean }>> {
    const start = resolve(path)
    const marker = await GitCheckpointStore.markerAbove(start)
    if (marker !== null) return GitCheckpointStore.answer(marker, true)

    const top = await this.invoker.run(start, ['rev-parse', '--show-toplevel'])
    if (!top.failure && top.code === 0 && top.stdout.trim())
      return GitCheckpointStore.answer(resolve(top.stdout.trim()), false)
    // Not a git work tree is not a failure here: a project with no VCS at all still gets a store.
    if (top.failure) {
      const failure = GitManager.failureOf(top, 'git-failed')
      if (failure) return failure
    }
    return GitCheckpointStore.answer(start, false)
  }

  /**
   * Create the store if it is missing and make sure both sides ignore it. Idempotent: the common
   * case is that everything already exists and this only re-checks the human-side exclude, which is
   * cheap and covers a `.git` that appeared after the store did.
   */
  async ensure(root: string): Promise<GitResult<{ storeDir: string }>> {
    const storeDir = join(root, CheckpointLayout.storeRelativeConst)
    if (!(await GitManager.exists(storeDir))) {
      const init = await this.invoker.run(root, [
        'init', '--bare', '-b', CheckpointLayout.branchConst, storeDir,
      ])
      const failure = GitManager.failureOf(init, 'git-failed')
      if (failure) return failure
      const seeded = await this.seedExcludes(root, storeDir)
      if (!seeded.ok) return seeded
    }
    const excluded = await this.excludeOnHumanSide(root)
    if (!excluded.ok) return excluded
    return { ok: true, value: { storeDir } }
  }

  /**
   * One checkpoint of the main copy. Nothing to commit is success, not a failure: a caller takes a
   * checkpoint before an operation to guarantee the store has a HEAD to work from, and a tree that
   * has not changed since the last one satisfies that just as well.
   */
  async checkpoint(root: string, message: string): Promise<GitResult<void>> {
    const ensured = await this.ensure(root)
    if (!ensured.ok) return ensured
    const target = ['--git-dir', ensured.value.storeDir, '--work-tree', root]

    const added = await this.invoker.run(root, [...target, 'add', '-A'])
    const addFailure = GitManager.failureOf(added, 'git-failed')
    if (addFailure) return addFailure

    const committed = await this.invoker.run(root, [
      ...target,
      '-c', `user.name=${CheckpointLayout.authorNameConst}`,
      '-c', `user.email=${CheckpointLayout.authorEmailConst}`,
      'commit', '--message', message,
    ])
    if (GitCheckpointStore.saysNothingToCommit(committed)) return { ok: true, value: undefined }
    const failure = GitManager.failureOf(committed, 'git-failed')
    if (failure) return failure
    return { ok: true, value: undefined }
  }

  /**
   * One checkpoint of a WORKTREE, on the branch that worktree is on.
   *
   * It cannot go through `checkpoint` above, and the difference is not cosmetic: that one points
   * `--git-dir` at the store and `--work-tree` at the MAIN COPY, so handing it a worktree path
   * would quietly checkpoint the main copy instead. A worktree carries a `.git` file that already
   * names the store and its own branch, so a plain commit inside it is both the right command and
   * the only one that lands where the session's work belongs.
   *
   * Nothing to commit is success for the same reason it is above: the caller wants the branch to
   * carry everything on disk, and a tree nobody touched already satisfies that.
   */
  async checkpointWorktree(worktreePath: string, message: string): Promise<GitResult<void>> {
    const added = await this.invoker.run(worktreePath, ['add', '-A'])
    const addFailure = GitManager.failureOf(added, 'git-failed')
    if (addFailure) return addFailure

    const committed = await this.invoker.run(worktreePath, [
      '-c', `user.name=${CheckpointLayout.authorNameConst}`,
      '-c', `user.email=${CheckpointLayout.authorEmailConst}`,
      'commit', '--message', message,
    ])
    if (GitCheckpointStore.saysNothingToCommit(committed)) return { ok: true, value: undefined }
    const failure = GitManager.failureOf(committed, 'git-failed')
    if (failure) return failure
    return { ok: true, value: undefined }
  }

  /** What a main-copy command needs in checkpoints mode; creates the store if it is not there yet. */
  async contextOf(root: string): Promise<GitResult<RepoCommandContext>> {
    const ensured = await this.ensure(root)
    if (!ensured.ok) return ensured
    return {
      ok: true,
      value: {
        root,
        gitDirArgs: ['--git-dir', ensured.value.storeDir, '--work-tree', root],
        storeDir: ensured.value.storeDir,
      },
    }
  }

  /**
   * What a read-only main-copy command needs when a checkpoint store already exists.
   *
   * Unlike `contextOf`, this never calls `ensure`: opening a status view is an observation and must
   * not create `.checkpoints`, seed excludes or touch a neighbouring human repository. A nested cwd
   * still resolves to the nearest existing store through `rootOf`.
   */
  async existingContextOf(path: string): Promise<GitResult<RepoCommandContext | null>> {
    const found = await this.rootOf(path)
    if (!found.ok) return found
    if (!found.value.exists) return { ok: true, value: null }
    return {
      ok: true,
      value: {
        root: found.value.root,
        gitDirArgs: [
          '--git-dir', found.value.storeDir,
          '--work-tree', found.value.root,
        ],
        storeDir: found.value.storeDir,
      },
    }
  }

  /**
   * Whether this worktree was cut from a checkpoint store. A worktree carries a `.git` FILE holding
   * a `gitdir:` line, so the question is answered by reading one small file rather than by running
   * git in a directory that may belong to a repository we are not allowed to touch.
   *
   * The hard cut needs this: an operation reaching a worktree cut from an old project `.git` must
   * refuse rather than quietly succeed against a store that has never heard of it.
   */
  async worktreeBelongsToStore(worktreePath: string): Promise<boolean> {
    return await this.contextOfWorktree(worktreePath) !== null
  }

  /** The checkpoint repository named by a worktree's own pointer, independent of current mode. */
  async contextOfWorktree(worktreePath: string): Promise<RepoCommandContext | null> {
    const pointer = await GitCheckpointStore.readPointer(join(worktreePath, '.git'))
    if (pointer === null) return null
    const absolute = isAbsolute(pointer) ? resolve(pointer) : resolve(worktreePath, pointer)
    const normalized = absolute.replace(/\\/g, '/')
    const marker = `/${CheckpointLayout.storeRelativeConst.replace(/\\/g, '/')}`
    const markerAt = normalized.toLowerCase().lastIndexOf(marker.toLowerCase())
    if (markerAt < 0) return null
    const afterMarker = normalized[markerAt + marker.length]
    if (afterMarker !== undefined && afterMarker !== '/') return null
    const storeDir = resolve(normalized.slice(0, markerAt + marker.length))
    const root = dirname(dirname(storeDir))
    return {
      root,
      gitDirArgs: ['--git-dir', storeDir, '--work-tree', root],
      storeDir,
    }
  }

  /**
   * The store gets its own exclude list at init because a BARE repository reads no
   * `core.excludesFile`. Copying the effective list in is what keeps a checkpoint from staging
   * `node_modules` in the projects that rely on the out-of-tree list alone, ČVUT's above all.
   */
  private async seedExcludes(root: string, storeDir: string): Promise<GitResult<void>> {
    const lines = [
      '# Checkpoint store excludes, seeded at init.',
      "# Contract: versioning-full.md, 'Checkpoint store - layout kontrakt'.",
      ...CheckpointLayout.selfExcludesConst,
    ]
    const mirrored = await this.globalExcludes(root)
    if (mirrored !== null)
      lines.push('', `# --- copy of ${mirrored.path} (a bare store reads no core.excludesFile) ---`, mirrored.body)

    const target = join(storeDir, 'info', 'exclude')
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `${lines.join('\n')}\n`, 'utf8')
    } catch (error) {
      return { ok: false, code: 'git-failed', detail: `could not seed store excludes: ${String(error)}` }
    }
    return { ok: true, value: undefined }
  }

  /**
   * `--path` so git expands a `~/...` value itself; asked from inside the project so a directory
   * scoped `includeIf` (that is how ČVUT gets its own list) resolves the way it would for a command
   * run there. A project with no configured list at all is normal, not an error.
   */
  private async globalExcludes(root: string): Promise<{ path: string; body: string } | null> {
    const configured = await this.invoker.run(root, ['config', '--path', '--get', 'core.excludesFile'])
    if (configured.failure || configured.code !== 0) return null
    const path = configured.stdout.trim()
    if (!path) return null
    try {
      return { path, body: await readFile(path, 'utf8') }
    } catch { return null }
  }

  /**
   * Where a human `.git` sits beside the store, keep the store and the worktrees out of ITS status.
   * `info/exclude` is untracked, so this leaves no trace in the committed sources, which is what
   * the ČVUT no-trace rule requires. A worktree's own `.git` file is skipped: it points at somebody
   * else's repository and its exclude list is not ours to grow.
   */
  private async excludeOnHumanSide(root: string): Promise<GitResult<void>> {
    const pointer = join(root, '.git')
    if (!(await GitManager.exists(pointer))) return { ok: true, value: undefined }
    if ((await GitCheckpointStore.readPointer(pointer)) !== null) return { ok: true, value: undefined }

    const common = await this.invoker.run(root, ['rev-parse', '--git-common-dir'])
    if (common.failure || common.code !== 0) return { ok: true, value: undefined }
    const commonDir = common.stdout.trim()
    if (!commonDir) return { ok: true, value: undefined }
    const resolved = isAbsolute(commonDir) ? commonDir : join(root, commonDir)

    const target = join(resolved, 'info', 'exclude')
    let existing = ''
    try { existing = await readFile(target, 'utf8') } catch { existing = '' }
    const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
    const missing = CheckpointLayout.humanExcludesConst.filter((line) => !present.has(line))
    if (missing.length === 0) return { ok: true, value: undefined }

    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `${existing}${separator}${missing.join('\n')}\n`, 'utf8')
    } catch (error) {
      return { ok: false, code: 'git-failed', detail: `could not exclude the store: ${String(error)}` }
    }
    return { ok: true, value: undefined }
  }

  /** The nearest ancestor already carrying a store, or null. The path itself counts as an ancestor. */
  private static async markerAbove(start: string): Promise<string | null> {
    let current = start
    for (;;) {
      if (await GitManager.exists(join(current, CheckpointLayout.storeRelativeConst))) return current
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }

  private static async answer(
    root: string,
    known: boolean,
  ): Promise<GitResult<{ root: string; storeDir: string; exists: boolean }>> {
    const storeDir = join(root, CheckpointLayout.storeRelativeConst)
    return {
      ok: true,
      value: { root, storeDir, exists: known || (await GitManager.exists(storeDir)) },
    }
  }

  /** The `gitdir:` target of a `.git` FILE, or null when the path is a directory or absent. */
  private static async readPointer(path: string): Promise<string | null> {
    let body: string
    try { body = await readFile(path, 'utf8') } catch { return null }
    const line = body.split(/\r?\n/).find((entry) => entry.startsWith('gitdir:'))
    if (line === undefined) return null
    const target = line.slice('gitdir:'.length).trim()
    return target === '' ? null : target
  }

  /**
   * Git says this on stdout with a non-zero exit, the same shape `GitMergeManager` reads its "already
   * gone" answers in: a state, not a failure.
   */
  private static saysNothingToCommit(outcome: GitCommandOutcome): boolean {
    if (outcome.failure) return false
    return /nothing to commit|no changes added to commit|nothing added to commit/i
      .test(`${outcome.stdout}\n${outcome.stderr}`)
  }
}
