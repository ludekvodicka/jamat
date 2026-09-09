import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CheckpointLayout } from './checkpointLayout'
import { GitCheckpointStore } from './gitCheckpointStore'
import { GitInvoker } from './gitInvoker'
import { GitWorktreeManager } from './gitWorktreeManager'
import type { GitCommandOutcome, GitCommandRunner, GitResult } from './git.types'
import { GitMergeManager } from './gitMergeManager'

describe('lib-orchestrator/git/gitMergeManager', () => {
  const rootConst = 'C:\\Projects\\NodeJs\\AppJamatV3'
  const worktreeConst = `${rootConst}\\.worktrees\\015-wizard`

  class ScriptedRunner implements GitCommandRunner {
    readonly calls: string[][] = []
    private readonly answers: GitCommandOutcome[]

    constructor(...answers: readonly Partial<GitCommandOutcome>[]) {
      this.answers = answers.map((answer) => ({
        code: 0,
        stdout: '',
        stderr: '',
        failure: null,
        ...answer,
      }))
    }

    run(_cwd: string, args: string[]): Promise<GitCommandOutcome> {
      this.calls.push(args)
      const answer = this.answers.shift()
      if (!answer) throw new Error(`No scripted answer for: ${args.join(' ')}`)
      return Promise.resolve(answer)
    }
  }

  function managerOf(...answers: readonly Partial<GitCommandOutcome>[]) {
    const runner = new ScriptedRunner(...answers)
    return { runner, manager: new GitMergeManager(runner) }
  }

  /**
   * A detached HEAD is a state to report, not a command that went wrong: there IS a HEAD, it is just
   * not a branch anything can be merged into.
   */
  it('reads the current branch, and answers null on a detached HEAD', async () => {
    const named = managerOf({ stdout: 'main\n' })
    expect(await named.manager.currentBranch(rootConst)).toEqual({ ok: true, value: { branch: 'main' } })

    const detached = managerOf({ code: 1, stdout: '', stderr: '' })
    expect(await detached.manager.currentBranch(rootConst))
      .toEqual({ ok: true, value: { branch: null } })
  })

  it('stages everything and commits it under the message it was given', async () => {
    const it_ = managerOf({}, {})

    expect(await it_.manager.commitAll(worktreeConst, 'Finalize session 015 - wizard'))
      .toEqual({ ok: true, value: undefined })
    expect(it_.runner.calls).toEqual([
      ['add', '--all'],
      ['commit', '--message', 'Finalize session 015 - wizard'],
    ])
  })

  /** The caller asked for the work to be committed, and over an empty tree it already is. */
  it('reads a tree with nothing in it as committed rather than as a failure', async () => {
    const it_ = managerOf({}, { code: 1, stdout: 'nothing to commit, working tree clean' })

    expect(await it_.manager.commitAll(worktreeConst, 'Finalize session 1'))
      .toEqual({ ok: true, value: undefined })
  })

  /** A hook is the project's own answer, and skipping it on the session's behalf is not this to do. */
  it('reports a commit the project itself refused', async () => {
    const it_ = managerOf({}, { code: 1, stderr: 'pre-commit hook failed' })
    const answer = await it_.manager.commitAll(worktreeConst, 'Finalize session 1')

    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.detail).toMatch(/pre-commit hook failed/)
  })

  it('does not reach the commit when the staging failed', async () => {
    const it_ = managerOf({ code: 128, stderr: 'fatal: not a git repository' })

    expect((await it_.manager.commitAll(worktreeConst, 'Finalize session 1')).ok).toBe(false)
    expect(it_.runner.calls).toEqual([['add', '--all']])
  })

  it('reports a real failure of that command rather than calling it detached', async () => {
    const broken = managerOf({ code: 128, stderr: 'fatal: not a git repository' })
    const answer = await broken.manager.currentBranch(rootConst)

    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.code).toBe('not-a-repo')
  })

  it('reads a merge in progress from MERGE_HEAD and dirt from the status', async () => {
    const during = managerOf({ code: 0, stdout: 'abc123\n' }, { stdout: 'UU file.ts\n' })
    expect(await during.manager.mergeStatus(worktreeConst))
      .toEqual({ ok: true, value: { inProgress: true, dirty: true, dirtyTracked: true, unresolved: true } })

    const clean = managerOf({ code: 1 }, { stdout: '' })
    expect(await clean.manager.mergeStatus(worktreeConst))
      .toEqual({ ok: true, value: { inProgress: false, dirty: false, dirtyTracked: false, unresolved: false } })

    const dirty = managerOf({ code: 1 }, { stdout: ' M file.ts\n' })
    expect(await dirty.manager.mergeStatus(worktreeConst))
      .toEqual({ ok: true, value: { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false } })
  })

  /*
   * The difference the main-copy guard rests on. A merge only touches tracked paths, and every
   * project root holds `.worktrees/`, so a copy whose only "dirt" is untracked files is one a merge
   * may run into. One `git status` answers both questions.
   */
  it('separates untracked files from changes to files it already tracks', () => {
    const untracked = managerOf({ code: 1 }, { stdout: '?? .worktrees/015/\n?? notes.txt\n' })
    return untracked.manager.mergeStatus(worktreeConst).then(async (only) => {
      expect(only).toEqual({
        ok: true,
        value: { inProgress: false, dirty: true, dirtyTracked: false, unresolved: false },
      })

      const tracked = managerOf({ code: 1 }, { stdout: '?? notes.txt\n M src/app.ts\n' })
      expect(await tracked.manager.mergeStatus(worktreeConst)).toEqual({
        ok: true,
        value: { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false },
      })

      const clean = managerOf({ code: 1 }, { stdout: '' })
      expect(await clean.manager.mergeStatus(worktreeConst)).toEqual({
        ok: true,
        value: { inProgress: false, dirty: false, dirtyTracked: false, unresolved: false },
      })
    })
  })

  /**
   * `MERGE_HEAD` is a plain merge's ref and nothing else's. A rebase, cherry-pick, revert or `am`
   * stopped on conflicts leaves the same markers in the same files behind a ref this never looks at,
   * so the unmerged entries in the status are the only thing that sees all of them.
   */
  it('sees unmerged files even where no merge is in progress', async () => {
    const rebasing = managerOf({ code: 1 }, { stdout: 'UU file.ts\n M other.ts\n' })
    expect(await rebasing.manager.mergeStatus(worktreeConst))
      .toEqual({ ok: true, value: { inProgress: false, dirty: true, dirtyTracked: true, unresolved: true } })

    for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      const it_ = managerOf({ code: 1 }, { stdout: `${code} file.ts\n` })
      expect(await it_.manager.mergeStatus(worktreeConst))
        .toEqual({ ok: true, value: { inProgress: false, dirty: true, dirtyTracked: true, unresolved: true } })
    }

    // `UU` as the PATH rather than the code, which a looser match would read as a conflict.
    const named = managerOf({ code: 1 }, { stdout: ' M UU.ts\n' })
    expect(await named.manager.mergeStatus(worktreeConst))
      .toEqual({ ok: true, value: { inProgress: false, dirty: true, dirtyTracked: true, unresolved: false } })
  })

  /**
   * A conflict is a value and not an error, and the merge is left exactly as git left it: the
   * half-merged tree with its markers is what whoever resolves it has to look at.
   */
  it('answers a conflict as a value and does not abort the merge', async () => {
    const { manager, runner } = managerOf({
      code: 1,
      stdout: 'Auto-merging file.ts\nCONFLICT (content): Merge conflict in file.ts\n',
      stderr: 'Automatic merge failed; fix conflicts and then commit the result.\n',
    })

    expect(await manager.mergeIntoWorktree(worktreeConst, 'main'))
      .toEqual({ ok: true, value: { conflict: true } })
    expect(runner.calls).toEqual([['merge', '--no-edit', '--end-of-options', 'main']])
  })

  it('answers a clean merge as no conflict', async () => {
    const { manager } = managerOf({ stdout: 'Fast-forward\n' })
    expect(await manager.mergeIntoWorktree(worktreeConst, 'main'))
      .toEqual({ ok: true, value: { conflict: false } })
  })

  it('reports a merge that failed for another reason rather than calling it a conflict', async () => {
    const { manager } = managerOf({
      code: 128,
      stderr: 'error: Your local changes would be overwritten by merge.',
    })
    const answer = await manager.mergeIntoWorktree(worktreeConst, 'main')

    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.code).toBe('dirty')
  })

  it('reads containment from the exit code, both ways', async () => {
    expect(await managerOf({ code: 0 }).manager.isMerged(rootConst, 'jamat/015'))
      .toEqual({ ok: true, value: true })
    expect(await managerOf({ code: 1 }).manager.isMerged(rootConst, 'jamat/015'))
      .toEqual({ ok: true, value: false })

    const broken = await managerOf({ code: 128, stderr: 'fatal: bad object' })
      .manager.isMerged(rootConst, 'jamat/015')
    expect(broken.ok).toBe(false)
  })

  /** `--no-ff` is what leaves a trace that the work happened on a branch of its own. */
  it('merges to main without fast-forwarding', async () => {
    const { manager, runner } = managerOf({})
    expect(await manager.mergeToMain(rootConst, 'jamat/015-wizard'))
      .toEqual({ ok: true, value: { conflict: false, diverged: false } })

    expect(runner.calls)
      .toEqual([['merge', '--no-ff', '--no-edit', '--end-of-options', 'jamat/015-wizard']])
  })

  /**
   * The same reading as `mergeIntoWorktree`, and the reason it was worth adding: git's conflict text
   * matches none of the failure signatures, so this used to come back as a plain `git-failed` while
   * the user's own copy kept MERGE_HEAD and the markers.
   */
  it('answers a conflict in the main copy as a value rather than a git failure', async () => {
    const { manager } = managerOf({
      code: 1,
      stdout: 'Auto-merging file.ts\nCONFLICT (content): Merge conflict in file.ts\n',
      stderr: 'Automatic merge failed; fix conflicts and then commit the result.\n',
    })

    expect(await manager.mergeToMain(rootConst, 'jamat/015-wizard'))
      .toEqual({ ok: true, value: { conflict: true, diverged: false } })
  })

  /** The one forced removal in the library, and the reason this class exists beside the other one. */
  it('removes a worktree with force, which its sibling manager never does', async () => {
    const { manager, runner } = managerOf({})
    await manager.removeWorktreeForced(rootConst, worktreeConst)

    expect(runner.calls)
      .toEqual([['worktree', 'remove', '--force', '--end-of-options', worktreeConst]])
  })

  it('deletes a branch safely by default and forcibly when told', async () => {
    const safe = managerOf({})
    await safe.manager.deleteBranch(rootConst, 'jamat/015', false, worktreeConst)
    expect(safe.runner.calls).toEqual([['branch', '-d', '--end-of-options', 'jamat/015']])

    const forced = managerOf({})
    await forced.manager.deleteBranch(rootConst, 'jamat/015', true, worktreeConst)
    expect(forced.runner.calls).toEqual([['branch', '-D', '--end-of-options', 'jamat/015']])
  })

  /**
   * Both of these end a teardown, and a teardown that cannot be repeated is one nobody can finish:
   * a crash or a refusal between the two leaves the first step done and every later attempt dying
   * on it. Git's exact words, measured: exit 128 for the worktree, exit 1 for the branch.
   */
  it('treats a worktree and a branch that are already gone as the outcome it wanted', async () => {
    const worktree = managerOf({
      code: 128,
      stderr: `fatal: '${worktreeConst}' is not a working tree`,
    })
    expect(await worktree.manager.removeWorktreeForced(rootConst, worktreeConst))
      .toEqual({ ok: true, value: undefined })

    const branch = managerOf({ code: 1, stderr: "error: branch 'jamat/015' not found." })
    expect(await branch.manager.deleteBranch(rootConst, 'jamat/015', true, worktreeConst))
      .toEqual({ ok: true, value: undefined })
  })

  /** And a refusal that is about anything else is still a refusal, so a lock is not read as done. */
  it('keeps reporting the failures that are not about the thing being absent', async () => {
    const locked = managerOf({ code: 128, stderr: 'fatal: cannot lock ref' })
    const removal = await locked.manager.removeWorktreeForced(rootConst, worktreeConst)
    expect(removal.ok === false && removal.code).toBe('locked')

    const unmerged = managerOf({ code: 1, stderr: "error: the branch 'jamat/015' is not fully merged" })
    const deletion = await unmerged.manager.deleteBranch(rootConst, 'jamat/015', false, worktreeConst)
    expect(deletion.ok).toBe(false)

    // A git that could not run at all said nothing about the target, so it is never read as absent.
    const broken = managerOf({ code: 0, failure: 'spawn-failed', stderr: 'is not a working tree' })
    expect((await broken.manager.removeWorktreeForced(rootConst, worktreeConst)).ok).toBe(false)
  })

  it('reports a machine without git as such rather than as a failed merge', async () => {
    const { manager } = managerOf({ code: 0, failure: 'git-missing' })
    const answer = await manager.mergeToMain(rootConst, 'jamat/015')

    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.code).toBe('git-missing')
  })
  describe('in checkpoints mode', () => {
    const created: string[] = []

    afterEach(() => {
      for (const directory of created.splice(0))
        rmSync(directory, { recursive: true, force: true })
    })

    function temporaryDirectory(prefix: string): string {
      const directory = mkdtempSync(join(tmpdir(), prefix))
      created.push(directory)
      return directory
    }

    function checkpointManagerOf(
      runner: GitCommandRunner,
    ): { manager: GitMergeManager; store: GitCheckpointStore } {
      const store = new GitCheckpointStore(runner)
      return { manager: new GitMergeManager(runner, { modeOf: () => 'checkpoints', store }), store }
    }

    /** A worktree that exists on disk and says, in its own `.git` file, where it was cut from. */
    function worktreeAt(root: string, name: string, gitdir: string): string {
      const path = join(root, '.worktrees', name)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, '.git'), `gitdir: ${gitdir}\n`, 'utf8')
      return path
    }

    /**
     * The disk guard of the hard cut. A worktree carrying a pointer into a project `.git` predates
     * the cut, and a forced removal aimed at the store would be answered "is not a working tree",
     * read as already gone, and the record deleted over a directory still full of work.
     */
    it('targets a project git worktree even while global mode says checkpoints', async () => {
      const root = temporaryDirectory('jamat-v3-merge-foreign-')
      mkdirSync(join(root, CheckpointLayout.storeRelativeConst), { recursive: true })
      const worktree = worktreeAt(root, 'old', join(root, '.git', 'worktrees', 'old'))
      const runner = new ScriptedRunner({})
      const { manager } = checkpointManagerOf(runner)

      expect(await manager.removeWorktreeForced(root, worktree))
        .toEqual({ ok: true, value: undefined })
      expect(runner.calls).toEqual([
        ['worktree', 'remove', '--force', '--end-of-options', worktree],
      ])
    })

    it('refuses a foreign worktree from the worktree-side commands too', async () => {
      const root = temporaryDirectory('jamat-v3-merge-foreign2-')
      mkdirSync(join(root, CheckpointLayout.storeRelativeConst), { recursive: true })
      const worktree = worktreeAt(root, 'old', join(root, '.git', 'worktrees', 'old'))
      const runner = new ScriptedRunner()
      const { manager } = checkpointManagerOf(runner)

      expect((await manager.commitAll(worktree, 'work')).ok).toBe(false)
      expect((await manager.mergeIntoWorktree(worktree, 'main')).ok).toBe(false)
      expect(runner.calls).toEqual([])
    })

    it('lets a worktree cut from the store through', async () => {
      const root = temporaryDirectory('jamat-v3-merge-own-')
      mkdirSync(join(root, CheckpointLayout.storeRelativeConst), { recursive: true })
      const worktree = worktreeAt(
        root,
        'feature',
        join(root, CheckpointLayout.storeRelativeConst, 'worktrees', 'feature'),
      )
      const runner = new ScriptedRunner({}, {})
      const { manager } = checkpointManagerOf(runner)

      expect(await manager.commitAll(worktree, 'work')).toEqual({ ok: true, value: undefined })
      expect(runner.calls[0]).toEqual(['add', '--all'])
    })

    /**
     * A teardown interrupted after the removal has to stay repeatable, so a worktree that is not on
     * disk at all is GONE rather than foreign. Reading it as foreign would strand every record whose
     * directory was already taken away.
     */
    it('treats a worktree that is not on disk as gone rather than as foreign', async () => {
      const root = temporaryDirectory('jamat-v3-merge-gone-')
      mkdirSync(join(root, CheckpointLayout.storeRelativeConst), { recursive: true })
      const runner = new ScriptedRunner()
      const { manager } = checkpointManagerOf(runner)

      expect(await manager.removeWorktreeForced(root, join(root, '.worktrees', 'never-was')))
        .toEqual({ ok: true, value: undefined })
      expect(runner.calls).toEqual([])
    })

    it('refuses to checkpoint a main copy when it is in git mode', async () => {
      const { manager } = managerOf()
      const refused = await manager.checkpointMain('Q:\\somewhere', 'message')
      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.detail).toContain('git mode')
    })
  })

  describe('against a real git', () => {
    const created: string[] = []

    afterEach(() => {
      for (const directory of created.splice(0))
        rmSync(directory, { recursive: true, force: true })
    })

    function valueOf<T>(result: GitResult<T>): T {
      if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
      return result.value
    }

    /** A project with a store, one checkpoint and a worktree carrying committed work. */
    async function landable(invoker: GitInvoker) {
      const root = mkdtempSync(join(tmpdir(), 'jamat-v3-merge-real-'))
      created.push(root)
      writeFileSync(join(root, 'a.txt'), 'head\nmiddle\ntail\n', 'utf8')
      const store = new GitCheckpointStore(invoker)
      const context = { modeOf: () => 'checkpoints' as const, store }
      const facts = valueOf(
        await new GitWorktreeManager(invoker, context).create(root, 'Feature'),
      )
      writeFileSync(join(facts.worktreePath, 'a.txt'), 'head\nCHANGED\ntail\n', 'utf8')
      writeFileSync(join(facts.worktreePath, 'b.txt'), 'new\n', 'utf8')
      expect((await invoker.run(facts.worktreePath, ['add', '--all'])).code).toBe(0)
      const committed = await invoker.run(facts.worktreePath, [
        '-c', 'user.email=tester@example.com',
        '-c', 'user.name=Tester',
        '-c', 'commit.gpgsign=false',
        'commit', '--message', 'work',
      ])
      expect(committed.code, committed.stderr).toBe(0)
      return { root, facts, merge: new GitMergeManager(invoker, context), store }
    }

    async function skipWithoutGit(context: { skip: () => void }): Promise<GitInvoker> {
      const invoker = new GitInvoker()
      const version = await invoker.run(tmpdir(), ['--version'])
      if (version.failure !== null || version.code !== 0)
        context.skip()
      return invoker
    }

    it('discards from the checkpoint store after switching to git mode', {
      timeout: 120_000,
    }, async (context) => {
      const invoker = await skipWithoutGit(context)
      const root = mkdtempSync(join(tmpdir(), 'jamat-v3-merge-affinity-'))
      created.push(root)
      expect((await invoker.run(root, ['init'])).code).toBe(0)
      writeFileSync(join(root, 'base.txt'), 'base\n', 'utf8')
      expect((await invoker.run(root, ['add', '-A'])).code).toBe(0)
      expect((await invoker.run(root, [
        '-c', 'user.email=tester@example.com',
        '-c', 'user.name=Tester',
        '-c', 'commit.gpgsign=false',
        'commit', '--allow-empty', '-m', 'human base',
      ])).code).toBe(0)
      let mode: 'checkpoints' | 'git' = 'checkpoints'
      const store = new GitCheckpointStore(invoker)
      const modeContext = { modeOf: () => mode, store }
      const facts = valueOf(await new GitWorktreeManager(invoker, modeContext)
        .create(root, 'Feature'))
      expect((await invoker.run(root, ['branch', facts.branch])).code).toBe(0)
      mode = 'git'
      const merge = new GitMergeManager(invoker, modeContext)

      expect(await merge.removeWorktreeForced(facts.repositoryRoot, facts.worktreePath))
        .toEqual({ ok: true, value: undefined })
      expect(await merge.deleteBranch(
        facts.repositoryRoot,
        facts.branch,
        true,
        facts.worktreePath,
      )).toEqual({ ok: true, value: undefined })

      expect((await invoker.run(root, [
        'show-ref', '--verify', '--quiet', `refs/heads/${facts.branch}`,
      ])).code).toBe(0)
      const checkpoint = valueOf(await store.existingContextOf(root))
      if (checkpoint === null) throw new Error('The checkpoint store disappeared')
      expect((await invoker.run(root, [
        ...checkpoint.gitDirArgs,
        'show-ref', '--verify', '--quiet', `refs/heads/${facts.branch}`,
      ])).code).toBe(1)
      expect(existsSync(facts.worktreePath)).toBe(false)

      const restarted = new GitMergeManager(invoker, modeContext)
      const repeated = await restarted.deleteBranch(
        facts.repositoryRoot,
        facts.branch,
        true,
        facts.worktreePath,
      )
      expect(repeated.ok).toBe(false)
      if (repeated.ok) throw new Error('The ambiguous repeat was accepted')
      expect(repeated.detail).toContain('repository affinity unknown')
      expect((await invoker.run(root, [
        'show-ref', '--verify', '--quiet', `refs/heads/${facts.branch}`,
      ])).code).toBe(0)
    })

    /** The landing writes the session's work into the human's own files, through the store. */
    it('fast-forwards the main copy onto the session branch', { timeout: 120_000 }, async (context) => {
      const invoker = await skipWithoutGit(context)
      const { root, facts, merge } = await landable(invoker)

      expect(await merge.mergeToMain(facts.repositoryRoot, facts.branch))
        .toEqual({ ok: true, value: { conflict: false, diverged: false } })

      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toContain('CHANGED')
      expect(readFileSync(join(root, 'b.txt'), 'utf8').trim()).toBe('new')
      expect(valueOf(await merge.isMerged(facts.repositoryRoot, facts.branch))).toBe(true)
      expect(valueOf(await merge.currentBranch(facts.repositoryRoot)).branch)
        .toBe(CheckpointLayout.branchConst)
    })

    /** The main copy moved on: not a conflict, not a failure, just merge again. */
    it('answers a main copy that moved as diverged', { timeout: 120_000 }, async (context) => {
      const invoker = await skipWithoutGit(context)
      const { root, facts, merge, store } = await landable(invoker)
      writeFileSync(join(root, 'elsewhere.txt'), 'main moved\n', 'utf8')
      expect((await store.checkpoint(root, 'main moved')).ok).toBe(true)

      expect(await merge.mergeToMain(facts.repositoryRoot, facts.branch))
        .toEqual({ ok: true, value: { conflict: false, diverged: true } })

      // Nothing of the session reached the main copy.
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).not.toContain('CHANGED')
    })

    /**
     * A tracked file the user is editing right now. Git refuses in its own words, the base class
     * reads them as `dirty`, and the edit is still there afterwards.
     */
    it('leaves a locally edited file alone and reports dirty', { timeout: 120_000 }, async (context) => {
      const invoker = await skipWithoutGit(context)
      const { root, facts, merge } = await landable(invoker)
      writeFileSync(join(root, 'a.txt'), 'head\nLOCAL EDIT\ntail\n', 'utf8')

      const refused = await merge.mergeToMain(facts.repositoryRoot, facts.branch)

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe('dirty')
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toContain('LOCAL EDIT')
    })

    /** The delegate the merge flow calls before landing; the store owns what a checkpoint is. */
    it('checkpoints the main copy through the store', { timeout: 120_000 }, async (context) => {
      const invoker = await skipWithoutGit(context)
      const { root, merge, store } = await landable(invoker)
      writeFileSync(join(root, 'wip.txt'), 'human work in progress\n', 'utf8')

      expect(await merge.checkpointMain(root, 'Checkpoint before merge')).toEqual({
        ok: true,
        value: undefined,
      })

      const target = valueOf(await store.contextOf(root))
      const log = await invoker.run(root, [...target.gitDirArgs, 'log', '--format=%s'])
      expect(log.stdout.split('\n')[0].trim()).toBe('Checkpoint before merge')
      const status = await invoker.run(root, [...target.gitDirArgs, 'status', '--porcelain'])
      expect(status.stdout.trim()).toBe('')
    })
  })
})
