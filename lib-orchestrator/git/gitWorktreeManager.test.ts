import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GitCommandOutcome, GitCommandRunner, GitResult } from './git.types'
import { CheckpointLayout } from './checkpointLayout'
import { GitCheckpointStore } from './gitCheckpointStore'
import { GitInvoker } from './gitInvoker'
import { GitWorktreeManager } from './gitWorktreeManager'

describe('lib-orchestrator/git/gitWorktreeManager', () => {
  const headShaConst = '1111111111111111111111111111111111111111'
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Invocation {
    cwd: string
    args: string[]
  }

  type ScriptedRunner = GitCommandRunner & { calls: Invocation[] }

  function temporaryDirectory(prefix: string): string {
    // realpathSync.NATIVE, and plain realpathSync will not do: on Windows os.tmpdir() can answer
    // with an 8.3 short path (C:\Users\RUNNER~1\...), git reports the long one back, and a test
    // that compared the path it asked for against the path git named would be comparing two
    // spellings of one directory. Only the native call expands the short form.
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
    created.push(directory)
    return directory
  }

  /** A repository that answers every identity question, with the temp directories git would name. */
  function repository(): { root: string; commonDir: string; excludeFile: string } {
    const root = temporaryDirectory('jamat-v3-git-')
    const commonDir = join(root, '.git')
    mkdirSync(commonDir, { recursive: true })
    return { root, commonDir, excludeFile: join(commonDir, 'info', 'exclude') }
  }

  function scripted(
    root: string,
    commonDir: string,
    overrides: (args: string[]) => Partial<GitCommandOutcome> | null = () => null,
  ): ScriptedRunner {
    const calls: Invocation[] = []
    const identity = (args: string[]): Partial<GitCommandOutcome> => {
      const command = args.join(' ')
      if (command === 'rev-parse --show-toplevel') return { stdout: `${root}\n` }
      if (command === 'rev-parse --git-common-dir') return { stdout: `${commonDir}\n` }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { stdout: `${headShaConst}\n` }
      return {}
    }
    return {
      calls,
      run: async (cwd, args) => {
        calls.push({ cwd, args })
        return {
          code: 0,
          stdout: '',
          stderr: '',
          failure: null,
          ...identity(args),
          ...overrides(args) ?? {},
        }
      },
    }
  }

  function valueOf<T>(result: GitResult<T>): T {
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
    return result.value
  }

  function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1
  }

  function addCall(runner: ScriptedRunner): Invocation | undefined {
    return runner.calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add')
  }

  it('puts the worktree inside the repository and names the branch after the slug', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir)
    const facts = valueOf(await new GitWorktreeManager(runner).create(root, 'Feature X!'))

    expect(facts).toEqual({
      worktreePath: join(resolve(root), '.worktrees', 'feature-x'),
      branch: 'jamat/feature-x',
      baseCommit: headShaConst,
      repositoryRoot: resolve(root),
    })
    expect(addCall(runner)?.args).toEqual([
      'worktree', 'add', '-b', 'jamat/feature-x', facts.worktreePath, headShaConst,
    ])
  })

  /*
   * Where the worktrees ARE, asked of the same manager that puts them there. The two answers must be
   * one directory: a catalog project may point at a package inside a repository, and anything
   * counting what has been cut - the session number seed - looks wherever this says.
   */
  it('answers the worktrees directory of the repository, not of the path it was asked about', async () => {
    const { root, commonDir } = repository()
    const inside = join(resolve(root), 'packages', 'app')
    mkdirSync(inside, { recursive: true })
    const runner = scripted(root, commonDir)

    expect(await new GitWorktreeManager(runner).worktreesDirectoryOf(inside))
      .toBe(join(resolve(root), '.worktrees'))
  })

  it('answers nothing for a path git does not own, which is not a failure', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir, (args) =>
      args[1] === '--show-toplevel'
        ? { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
        : null)

    expect(await new GitWorktreeManager(runner).worktreesDirectoryOf(root)).toBeNull()
  })

  // The worktree is only legal inside the repository while git ignores it, and the one place that may
  // say so is the unversioned local exclude: .gitignore is the user's file, tracked by git and
  // carried into an SVN commit as well.
  it('writes the ignore into info/exclude and never touches .gitignore', async () => {
    const { root, commonDir, excludeFile } = repository()
    const runner = scripted(root, commonDir)
    await new GitWorktreeManager(runner).create(root, 'feature')

    expect(readFileSync(excludeFile, 'utf8')).toBe('/.worktrees/\n')
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
  })

  it('appends the ignore below what the file already holds, on its own line', async () => {
    const { root, commonDir, excludeFile } = repository()
    mkdirSync(join(commonDir, 'info'), { recursive: true })
    writeFileSync(excludeFile, '# user exclusions\n*.tmp', 'utf8')
    const runner = scripted(root, commonDir)
    await new GitWorktreeManager(runner).create(root, 'feature')

    expect(readFileSync(excludeFile, 'utf8')).toBe('# user exclusions\n*.tmp\n/.worktrees/\n')
  })

  it('writes the ignore once however many worktrees are created', async () => {
    const { root, commonDir, excludeFile } = repository()
    const manager = new GitWorktreeManager(scripted(root, commonDir))
    await manager.create(root, 'first')
    await manager.create(root, 'second')

    expect(occurrences(readFileSync(excludeFile, 'utf8'), '/.worktrees/')).toBe(1)
  })

  it('answers not-a-repo for a directory git does not own, without throwing', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir, (args) =>
      args[1] === '--show-toplevel'
        ? { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
        : null)
    const result = await new GitWorktreeManager(runner).create(root, 'feature')

    expect(result).toMatchObject({ ok: false, code: 'not-a-repo' })
    expect(addCall(runner)).toBeUndefined()
  })

  it('answers git-missing when git is not on PATH', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir, () => ({ failure: 'git-missing', code: -1 }))
    const result = await new GitWorktreeManager(runner).create(root, 'feature')

    expect(result).toMatchObject({ ok: false, code: 'git-missing' })
  })

  /**
   * Removing a worktree whose directory somebody deleted by hand. The status runs in that directory,
   * so it never starts, and blaming the machine for having no git would send the user looking for a
   * git that is installed and working.
   */
  it('does not call a directory that is gone a git that is not installed', async () => {
    const { root, commonDir } = repository()
    const worktreePath = join(root, '.worktrees', 'feature')
    const runner = scripted(root, commonDir, (args) =>
      args[0] === 'status'
        ? { failure: 'cwd-missing', code: -1, stderr: `${worktreePath} is not a directory` }
        : null)
    const result = await new GitWorktreeManager(runner).remove(root, worktreePath)

    expect(result).toMatchObject({ ok: false, code: 'git-failed' })
    expect(result.ok ? '' : result.detail).toContain(worktreePath)
  })

  it('answers missing-base for a base that does not resolve, and adds nothing', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir, (args) =>
      args[1] === '--verify'
        ? { code: 128, stderr: "fatal: Needed a single revision: unknown revision 'release'" }
        : null)
    const result = await new GitWorktreeManager(runner).create(root, 'feature', 'release')

    expect(result).toMatchObject({ ok: false, code: 'missing-base' })
    expect(addCall(runner)).toBeUndefined()
  })

  it('refuses a slug whose directory is already there before it runs git', async () => {
    const { root, commonDir } = repository()
    mkdirSync(join(root, '.worktrees', 'feature'), { recursive: true })
    const runner = scripted(root, commonDir)
    const result = await new GitWorktreeManager(runner).create(root, 'feature')

    expect(result).toMatchObject({ ok: false, code: 'worktree-exists' })
    expect(addCall(runner)).toBeUndefined()
  })

  it('reads git refusing an existing branch as worktree-exists', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir, (args) =>
      args[1] === 'add'
        ? { code: 128, stderr: "fatal: a branch named 'jamat/feature' already exists" }
        : null)
    const result = await new GitWorktreeManager(runner).create(root, 'feature')

    expect(result).toMatchObject({ ok: false, code: 'worktree-exists' })
  })

  it('refuses a slug that carries no letter or digit at all, running no git', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir)
    const result = await new GitWorktreeManager(runner).create(root, '---')

    expect(result.ok).toBe(false)
    expect(runner.calls).toEqual([])
  })

  it('parses the NUL-terminated porcelain listing', async () => {
    const { root, commonDir } = repository()
    const main = root.replace(/\\/g, '/')
    const linked = `${main}/.worktrees/feature-x`
    const runner = scripted(root, commonDir, (args) =>
      args[1] === 'list'
        ? {
            stdout: `worktree ${main}\0HEAD ${headShaConst}\0branch refs/heads/main\0\0`
              + `worktree ${linked}\0HEAD 2222222222222222222222222222222222222222\0`
              + 'branch refs/heads/jamat/feature-x\0\0',
          }
        : null)
    const listed = valueOf(await new GitWorktreeManager(runner).list(root))

    expect(listed).toEqual([
      {
        worktreePath: resolve(root),
        branch: 'main',
        baseCommit: headShaConst,
        repositoryRoot: resolve(root),
      },
      {
        worktreePath: resolve(root, '.worktrees', 'feature-x'),
        branch: 'jamat/feature-x',
        baseCommit: '2222222222222222222222222222222222222222',
        repositoryRoot: resolve(root),
      },
    ])
  })

  it('answers not-a-repo when the listing is asked of a directory git does not own', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir, () => ({
      code: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    }))

    expect(await new GitWorktreeManager(runner).list(root))
      .toMatchObject({ ok: false, code: 'not-a-repo' })
  })

  it('sums the numstat, counts a binary file and adds the untracked ones', async () => {
    const { root, commonDir } = repository()
    const worktreePath = join(root, '.worktrees', 'feature')
    const runner = scripted(root, commonDir, (args) => {
      if (args[0] === 'diff') return { stdout: '4\t2\tsrc/a.ts\n10\t0\tsrc/b.ts\n-\t-\tlogo.png\n' }
      if (args[0] === 'status') return { stdout: '?? note.txt\n M src/a.ts\n' }
      return null
    })
    const diff = valueOf(
      await new GitWorktreeManager(runner).refreshDiff(worktreePath, headShaConst),
    )

    expect(diff).toMatchObject({ added: 14, removed: 2, changedFiles: 4 })
    expect(runner.calls[0]).toEqual({
      cwd: worktreePath,
      args: ['diff', '--numstat', '--end-of-options', headShaConst, '--'],
    })
  })

  it('measures once per 30 s unless the caller forces it', async () => {
    const { root, commonDir } = repository()
    const worktreePath = join(root, '.worktrees', 'feature')
    const runner = scripted(root, commonDir, (args) =>
      args[0] === 'diff' ? { stdout: '1\t1\tsrc/a.ts\n' } : null)
    const manager = new GitWorktreeManager(runner)

    const first = valueOf(await manager.refreshDiff(worktreePath, headShaConst))
    const throttled = valueOf(await manager.refreshDiff(worktreePath, headShaConst))
    expect(throttled).toBe(first)
    expect(runner.calls).toHaveLength(2)

    valueOf(await manager.refreshDiff(worktreePath, headShaConst, { force: true }))
    expect(runner.calls).toHaveLength(4)
  })

  it('refuses a base that is not a commit id before it reaches git', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir)
    const result = await new GitWorktreeManager(runner)
      .refreshDiff(join(root, '.worktrees', 'feature'), '--output=/tmp/pwned')

    expect(result).toMatchObject({ ok: false, code: 'missing-base' })
    expect(runner.calls).toEqual([])
  })

  it('refuses to remove a dirty worktree and leaves it where it is', async () => {
    const { root, commonDir } = repository()
    const worktreePath = join(root, '.worktrees', 'feature')
    const runner = scripted(root, commonDir, (args) =>
      args[0] === 'status' ? { stdout: ' M src/a.ts\n' } : null)
    const result = await new GitWorktreeManager(runner).remove(root, worktreePath)

    expect(result).toMatchObject({ ok: false, code: 'dirty' })
    expect(runner.calls.some((call) => call.args[1] === 'remove')).toBe(false)
  })

  it('removes a clean worktree', async () => {
    const { root, commonDir } = repository()
    const worktreePath = join(root, '.worktrees', 'feature')
    const runner = scripted(root, commonDir)
    const result = await new GitWorktreeManager(runner).remove(root, worktreePath)

    expect(result).toEqual({ ok: true, value: undefined })
    expect(runner.calls[1]).toEqual({
      cwd: root,
      args: ['worktree', 'remove', '--end-of-options', worktreePath],
    })
  })

  it('reads a locked worktree as locked', async () => {
    const { root, commonDir } = repository()
    const runner = scripted(root, commonDir, (args) =>
      args[1] === 'remove'
        ? { code: 128, stderr: 'fatal: cannot remove a locked working tree, it is locked: in use' }
        : null)
    const result = await new GitWorktreeManager(runner).remove(root, join(root, '.worktrees', 'f'))

    expect(result).toMatchObject({ ok: false, code: 'locked' })
  })

  // Deleting the directory behind git's back is what leaves the prunable metadata a later add trips
  // over, so a failed removal ends the operation rather than falling back to unlinking it.
  it('leaves the directory alone when git refuses to remove the worktree', async () => {
    const { root, commonDir } = repository()
    const worktreePath = join(root, '.worktrees', 'feature')
    mkdirSync(worktreePath, { recursive: true })
    const runner = scripted(root, commonDir, (args) =>
      args[1] === 'remove' ? { code: 128, stderr: 'fatal: validation failed, cannot remove' } : null)
    const result = await new GitWorktreeManager(runner).remove(root, worktreePath)

    expect(result).toMatchObject({ ok: false, code: 'git-failed' })
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('says the base moved once the repository head is another commit', async () => {
    const { root, commonDir } = repository()
    const facts = {
      worktreePath: join(root, '.worktrees', 'feature'),
      branch: 'jamat/feature',
      baseCommit: headShaConst,
      repositoryRoot: root,
    }
    const manager = new GitWorktreeManager(scripted(root, commonDir))
    expect(valueOf(await manager.baseMoved(root, facts))).toBe(false)

    const moved = new GitWorktreeManager(scripted(root, commonDir, (args) =>
      args[1] === '--verify' ? { stdout: '3333333333333333333333333333333333333333\n' } : null))
    expect(valueOf(await moved.baseMoved(root, facts))).toBe(true)
  })

  /**
   * The one test that runs a real git. It is what proves the arrangement itself: a worktree created
   * INSIDE the repository leaves `status --porcelain` in the main tree empty, which is true only
   * because the ignore reached `info/exclude`, and `worktree list --porcelain -z` parses.
   */
  it('keeps the main tree clean around a real worktree', { timeout: 120_000 }, async (context) => {
    const invoker = new GitInvoker()
    const version = await invoker.run(tmpdir(), ['--version'])
    if (version.failure !== null || version.code !== 0)
      context.skip()

    const root = temporaryDirectory('jamat-v3-git-real-')
    const initialized = await invoker.run(root, ['init'])
    expect(initialized.code, initialized.stderr).toBe(0)
    const committed = await invoker.run(root, [
      '-c', 'user.email=tester@example.com',
      '-c', 'user.name=Tester',
      '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-m', 'base',
    ])
    expect(committed.code, committed.stderr).toBe(0)

    const manager = new GitWorktreeManager(invoker)
    const facts = valueOf(await manager.create(root, 'Feature X!'))
    expect(facts.worktreePath).toBe(join(facts.repositoryRoot, '.worktrees', 'feature-x'))
    expect(facts.branch).toBe('jamat/feature-x')
    expect(existsSync(join(facts.worktreePath, '.git'))).toBe(true)

    const status = await invoker.run(facts.repositoryRoot, ['status', '--porcelain'])
    expect(status.stdout.trim()).toBe('')

    const excludeFile = join(facts.repositoryRoot, '.git', 'info', 'exclude')
    expect(occurrences(readFileSync(excludeFile, 'utf8'), '/.worktrees/')).toBe(1)
    expect(existsSync(join(facts.repositoryRoot, '.gitignore'))).toBe(false)
    const second = valueOf(await manager.create(root, 'Second'))
    expect(occurrences(readFileSync(excludeFile, 'utf8'), '/.worktrees/')).toBe(1)

    const listed = valueOf(await manager.list(root))
    expect(listed[0].worktreePath).toBe(facts.repositoryRoot)
    expect(listed.map((entry) => entry.worktreePath)).toContain(facts.worktreePath)
    expect(listed.find((entry) => entry.worktreePath === facts.worktreePath)?.branch)
      .toBe('jamat/feature-x')
    expect(listed.every((entry) => entry.baseCommit.length === 40)).toBe(true)

    writeFileSync(join(facts.worktreePath, 'note.txt'), 'hello', 'utf8')
    expect(valueOf(await manager.refreshDiff(facts.worktreePath, facts.baseCommit)).changedFiles)
      .toBe(1)
    expect(await manager.remove(facts.repositoryRoot, facts.worktreePath))
      .toMatchObject({ ok: false, code: 'dirty' })
    expect(existsSync(facts.worktreePath)).toBe(true)

    rmSync(join(facts.worktreePath, 'note.txt'))
    expect(await manager.remove(facts.repositoryRoot, facts.worktreePath))
      .toEqual({ ok: true, value: undefined })
    expect(existsSync(facts.worktreePath)).toBe(false)
    expect(valueOf(await manager.baseMoved(root, second))).toBe(false)
  })

  describe('in checkpoints mode', () => {
    function checkpointManager(runner: GitCommandRunner): GitWorktreeManager {
      return new GitWorktreeManager(runner, {
        modeOf: () => 'checkpoints',
        store: new GitCheckpointStore(runner),
      })
    }

    /**
     * A project with no store yet still has an answer, because the question is where a worktree
     * WOULD be cut. The fallback chain is the store's: no marker above, no git toplevel, so the
     * path itself.
     */
    it('answers where a worktree would be cut for a project with no store and no git', async () => {
      const root = temporaryDirectory('jamat-v3-cp-')
      const runner = scripted(root, join(root, '.git'), (args) =>
        args.join(' ') === 'rev-parse --show-toplevel'
          ? { code: 128, stderr: 'fatal: not a git repository' }
          : null)

      expect(await checkpointManager(runner).worktreesDirectoryOf(root))
        .toBe(join(resolve(root), '.worktrees'))
    })

    /**
     * The whole point of the mode, end to end: a directory with NO version control at all becomes
     * isolatable by one call. It is also the ordering proof - with no git and no store there is no
     * HEAD, so the only reason `worktree add` finds a commit to cut from is the checkpoint `create`
     * takes before it.
     */
    it('cuts from a store it creates itself, over a project with no version control', {
      timeout: 120_000,
    }, async (context) => {
      const invoker = new GitInvoker()
      const version = await invoker.run(tmpdir(), ['--version'])
      if (version.failure !== null || version.code !== 0)
        context.skip()

      const root = temporaryDirectory('jamat-v3-cp-real-')
      writeFileSync(join(root, 'a.txt'), 'v1\n', 'utf8')
      const manager = checkpointManager(invoker)

      const facts = valueOf(await manager.create(root, 'Feature X!'))

      expect(facts.repositoryRoot).toBe(resolve(root))
      expect(facts.worktreePath).toBe(join(resolve(root), '.worktrees', 'feature-x'))
      expect(facts.branch).toBe('jamat/feature-x')
      // The root never gains a .git of its own; the store carries the history instead.
      expect(existsSync(join(root, '.git'))).toBe(false)
      expect(existsSync(join(root, CheckpointLayout.storeRelativeConst, 'HEAD'))).toBe(true)
      // A worktree's .git is a FILE holding a pointer, and this one points into the store.
      expect(statSync(join(facts.worktreePath, '.git')).isFile()).toBe(true)
      expect(readFileSync(join(facts.worktreePath, '.git'), 'utf8'))
        .toContain(CheckpointLayout.storeNameConst)
      // The work that existed before isolation came along is in the worktree.
      expect(readFileSync(join(facts.worktreePath, 'a.txt'), 'utf8').trim()).toBe('v1')

      // The store answers `worktree list` with ITSELF as a bare first entry; the listing drops it
      // and names the project as the root rather than the store directory.
      const listed = valueOf(await manager.list(root))
      expect(listed.map((entry) => entry.worktreePath)).toEqual([facts.worktreePath])
      expect(listed[0].repositoryRoot).toBe(resolve(root))
      expect(listed[0].branch).toBe('jamat/feature-x')

      expect(valueOf(await manager.baseMoved(root, facts))).toBe(false)
    })

    /** The ČVUT layout: a human repository with the store beside it. Nothing of the human's moves. */
    it('cuts from the store beside a human .git and leaves that repository untouched', {
      timeout: 120_000,
    }, async (context) => {
      const invoker = new GitInvoker()
      const version = await invoker.run(tmpdir(), ['--version'])
      if (version.failure !== null || version.code !== 0)
        context.skip()

      const root = temporaryDirectory('jamat-v3-cp-human-')
      expect((await invoker.run(root, ['init'])).code).toBe(0)
      writeFileSync(join(root, 'tracked.txt'), 'human\n', 'utf8')
      expect((await invoker.run(root, ['add', '-A'])).code).toBe(0)
      const committed = await invoker.run(root, [
        '-c', 'user.email=tester@example.com',
        '-c', 'user.name=Tester',
        '-c', 'commit.gpgsign=false',
        'commit', '-m', 'human base',
      ])
      expect(committed.code, committed.stderr).toBe(0)
      const humanHead = (await invoker.run(root, ['rev-parse', 'HEAD'])).stdout.trim()

      const facts = valueOf(await checkpointManager(invoker).create(root, 'Isolated'))

      expect(readFileSync(join(facts.worktreePath, '.git'), 'utf8'))
        .toContain(CheckpointLayout.storeNameConst)
      expect((await invoker.run(root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(humanHead)
      expect((await invoker.run(root, ['branch', '--list', 'jamat/*'])).stdout.trim()).toBe('')
      // Clean, because the store and the worktrees reached info/exclude rather than a .gitignore
      // the next commit would have offered to add.
      expect((await invoker.run(root, ['status', '--porcelain'])).stdout.trim()).toBe('')
      expect(existsSync(join(root, '.gitignore'))).toBe(false)
      const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
      expect(exclude).toContain('/.checkpoints/')
      expect(exclude).toContain('/.worktrees/')
    })

    it('removes a checkpoint worktree from a root with no project git', {
      timeout: 120_000,
    }, async (context) => {
      const invoker = new GitInvoker()
      const version = await invoker.run(tmpdir(), ['--version'])
      if (version.failure !== null || version.code !== 0)
        context.skip()
      const root = temporaryDirectory('jamat-v3-cp-remove-plain-')
      writeFileSync(join(root, 'a.txt'), 'base\n', 'utf8')
      const manager = checkpointManager(invoker)
      const facts = valueOf(await manager.create(root, 'Remove Me'))

      expect(await manager.remove(facts.repositoryRoot, facts.worktreePath))
        .toEqual({ ok: true, value: undefined })
      expect(existsSync(facts.worktreePath)).toBe(false)
      expect(existsSync(join(root, '.git'))).toBe(false)
    })

    it('removes from the checkpoint store beside human git after mode switches to git', {
      timeout: 120_000,
    }, async (context) => {
      const invoker = new GitInvoker()
      const version = await invoker.run(tmpdir(), ['--version'])
      if (version.failure !== null || version.code !== 0)
        context.skip()
      const root = temporaryDirectory('jamat-v3-cp-remove-human-')
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
      const manager = new GitWorktreeManager(invoker, {
        modeOf: () => mode,
        store: new GitCheckpointStore(invoker),
      })
      const facts = valueOf(await manager.create(root, 'Remove Me'))
      mode = 'git'

      expect(await manager.remove(facts.repositoryRoot, facts.worktreePath))
        .toEqual({ ok: true, value: undefined })
      expect(existsSync(facts.worktreePath)).toBe(false)
      expect((await invoker.run(root, ['status', '--porcelain'])).stdout.trim()).toBe('')
    })
  })
})
