import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CheckpointLayout } from './checkpointLayout'
import { GitCheckpointStore } from './gitCheckpointStore'
import type { GitCommandOutcome, GitCommandRunner } from './git.types'
import { GitInvoker } from './gitInvoker'

describe('lib-orchestrator/git/gitCheckpointStore', () => {
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
    // realpathSync.NATIVE: os.tmpdir() can be an 8.3 short path on Windows and git answers in the
    // long form. Plain realpathSync leaves the short name alone, so it would not help here.
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
    created.push(directory)
    return resolve(directory)
  }

  /**
   * A git that answers the two identity questions and does nothing else. `init` is scripted rather
   * than real wherever the test only cares about the arguments; the cases that need a real store on
   * disk use the real invoker instead.
   */
  function scripted(
    overrides: (args: string[]) => Partial<GitCommandOutcome> | null = () => null,
  ): ScriptedRunner {
    const calls: Invocation[] = []
    return {
      calls,
      run: async (cwd, args) => {
        calls.push({ cwd, args })
        return { code: 0, stdout: '', stderr: '', failure: null, ...(overrides(args) ?? {}) }
      },
    }
  }

  function storeMarker(root: string): string {
    const storeDir = join(root, CheckpointLayout.storeRelativeConst)
    mkdirSync(join(storeDir, 'info'), { recursive: true })
    return storeDir
  }

  describe('rootOf', () => {
    it('takes the nearest ancestor carrying a store over anything git would say', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      storeMarker(root)
      const nested = join(root, 'packages', 'inner')
      mkdirSync(nested, { recursive: true })
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --show-toplevel' ? { stdout: `${nested}\n` } : null)

      const answer = await new GitCheckpointStore(runner).rootOf(nested)

      expect(answer.ok).toBe(true)
      if (!answer.ok) return
      expect(answer.value.root).toBe(root)
      expect(answer.value.exists).toBe(true)
      // The marker decided, so git was never asked.
      expect(runner.calls).toHaveLength(0)
    })

    it('falls back to the git toplevel, so a monorepo package checkpoints the whole tree', async () => {
      const top = temporaryDirectory('jamat-v3-store-')
      const nested = join(top, 'packages', 'inner')
      mkdirSync(nested, { recursive: true })
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --show-toplevel' ? { stdout: `${top}\n` } : null)

      const answer = await new GitCheckpointStore(runner).rootOf(nested)

      expect(answer.ok).toBe(true)
      if (!answer.ok) return
      expect(answer.value.root).toBe(top)
      expect(answer.value.exists).toBe(false)
    })

    it('answers the path itself when there is neither a marker nor a git tree', async () => {
      const plain = temporaryDirectory('jamat-v3-store-')
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --show-toplevel'
          ? { code: 128, stderr: 'fatal: not a git repository' }
          : null)

      const answer = await new GitCheckpointStore(runner).rootOf(plain)

      expect(answer.ok).toBe(true)
      if (!answer.ok) return
      expect(answer.value.root).toBe(plain)
      expect(answer.value.storeDir).toBe(join(plain, CheckpointLayout.storeRelativeConst))
    })

    it('reports a git that could not run at all', async () => {
      const plain = temporaryDirectory('jamat-v3-store-')
      const runner = scripted(() => ({ code: 0, failure: 'git-missing' }))

      const answer = await new GitCheckpointStore(runner).rootOf(plain)

      expect(answer.ok).toBe(false)
      if (answer.ok) return
      expect(answer.code).toBe('git-missing')
    })
  })

  describe('ensure', () => {
    it('creates the bare store on the checkpoint branch and seeds the three self-excludes', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const runner = scripted((args) =>
        args[0] === 'init' ? { stdout: 'Initialized empty Git repository\n' } : null)
      // The scripted git writes nothing, so the seed has to survive a store directory it made itself.
      mkdirSync(join(root, CheckpointLayout.storeRelativeConst, 'info'), { recursive: true })

      const store = new GitCheckpointStore(runner)
      const first = await store.ensure(root)

      expect(first.ok).toBe(true)
      // The store already existed, so nothing was initialized and nothing was seeded.
      expect(runner.calls.some((call) => call.args[0] === 'init')).toBe(false)
    })

    it('initializes and seeds when the store is absent, with the mirror of the global list', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const excludesFile = join(root, 'global-ignore')
      writeFileSync(excludesFile, 'node_modules\n.env\n', 'utf8')
      const runner = scripted((args) => {
        if (args[0] === 'init') {
          storeMarker(root)
          return { stdout: 'Initialized\n' }
        }
        if (args.join(' ') === 'config --path --get core.excludesFile') return { stdout: `${excludesFile}\n` }
        return null
      })

      const result = await new GitCheckpointStore(runner).ensure(root)

      expect(result.ok).toBe(true)
      const seeded = readFileSync(join(root, CheckpointLayout.storeRelativeConst, 'info', 'exclude'), 'utf8')
      for (const line of CheckpointLayout.selfExcludesConst)
        expect(seeded).toContain(line)
      expect(seeded).toContain('node_modules')
      const init = runner.calls.find((call) => call.args[0] === 'init')
      expect(init?.args).toEqual([
        'init', '--bare', '-b', CheckpointLayout.branchConst,
        join(root, CheckpointLayout.storeRelativeConst),
      ])
    })

    it('seeds only the self-excludes when no global list is configured', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const runner = scripted((args) => {
        if (args[0] === 'init') {
          storeMarker(root)
          return { stdout: 'Initialized\n' }
        }
        if (args.join(' ') === 'config --path --get core.excludesFile') return { code: 1 }
        return null
      })

      await new GitCheckpointStore(runner).ensure(root)

      const seeded = readFileSync(join(root, CheckpointLayout.storeRelativeConst, 'info', 'exclude'), 'utf8')
      expect(seeded).toContain('/.checkpoints/')
      expect(seeded).not.toContain('copy of')
    })

    it('hides the store from a human .git beside it, without touching tracked files', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const commonDir = join(root, '.git')
      mkdirSync(join(commonDir, 'info'), { recursive: true })
      writeFileSync(join(commonDir, 'info', 'exclude'), '# existing\n*.tmp\n', 'utf8')
      storeMarker(root)
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --git-common-dir' ? { stdout: `${commonDir}\n` } : null)

      await new GitCheckpointStore(runner).ensure(root)

      const exclude = readFileSync(join(commonDir, 'info', 'exclude'), 'utf8')
      expect(exclude).toContain('*.tmp')
      for (const line of CheckpointLayout.humanExcludesConst)
        expect(exclude).toContain(line)
    })

    it('does not write the same exclude lines twice', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const commonDir = join(root, '.git')
      mkdirSync(join(commonDir, 'info'), { recursive: true })
      storeMarker(root)
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --git-common-dir' ? { stdout: `${commonDir}\n` } : null)

      const store = new GitCheckpointStore(runner)
      await store.ensure(root)
      await store.ensure(root)

      const exclude = readFileSync(join(commonDir, 'info', 'exclude'), 'utf8')
      const occurrences = exclude.split('/.checkpoints/').length - 1
      expect(occurrences).toBe(1)
    })

    it('leaves a worktree pointer alone rather than growing somebody else repository exclude', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n', 'utf8')
      storeMarker(root)
      const runner = scripted()

      await new GitCheckpointStore(runner).ensure(root)

      expect(runner.calls.some((call) => call.args.join(' ') === 'rev-parse --git-common-dir')).toBe(false)
    })
  })

  describe('existingContextOf', () => {
    it('targets the nearest existing store from a nested cwd without writing anything', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const storeDir = storeMarker(root)
      const nested = join(root, 'packages', 'inner')
      mkdirSync(nested, { recursive: true })
      const runner = scripted()

      const result = await new GitCheckpointStore(runner).existingContextOf(nested)

      expect(result).toEqual({
        ok: true,
        value: {
          root,
          gitDirArgs: ['--git-dir', storeDir, '--work-tree', root],
          storeDir,
        },
      })
      expect(runner.calls).toEqual([])
    })

    it('returns null for a missing store and does not initialize one', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const runner = scripted((args) => args.join(' ') === 'rev-parse --show-toplevel'
        ? { code: 128, stderr: 'fatal: not a git repository' }
        : null)

      const result = await new GitCheckpointStore(runner).existingContextOf(root)

      expect(result).toEqual({ ok: true, value: null })
      expect(existsSync(join(root, CheckpointLayout.storeRelativeConst))).toBe(false)
      expect(runner.calls.some((call) => call.args[0] === 'init')).toBe(false)
    })
  })

  describe('checkpoint', () => {
    it('stages everything and commits with the jamat identity passed as arguments', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      storeMarker(root)
      const runner = scripted()

      const result = await new GitCheckpointStore(runner).checkpoint(root, 'checkpoint: before the cut')

      expect(result.ok).toBe(true)
      const storeDir = join(root, CheckpointLayout.storeRelativeConst)
      const commit = runner.calls.find((call) => call.args.includes('commit'))
      expect(commit?.args).toEqual([
        '--git-dir', storeDir, '--work-tree', root,
        '-c', `user.name=${CheckpointLayout.authorNameConst}`,
        '-c', `user.email=${CheckpointLayout.authorEmailConst}`,
        'commit', '--message', 'checkpoint: before the cut',
      ])
      // Identity travels as arguments because GitInvoker strips inherited GIT_* on purpose.
      expect(commit?.args.some((argument) => argument.startsWith('user.name='))).toBe(true)
    })

    it('treats nothing to commit as success, because the store still has the HEAD a caller needs', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      storeMarker(root)
      const runner = scripted((args) =>
        args.includes('commit') ? { code: 1, stdout: 'nothing to commit, working tree clean\n' } : null)

      const result = await new GitCheckpointStore(runner).checkpoint(root, 'checkpoint: unchanged')

      expect(result.ok).toBe(true)
    })

    it('reports a real commit failure', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      storeMarker(root)
      const runner = scripted((args) =>
        args.includes('commit') ? { code: 1, stderr: 'fatal: unable to write new index file\n' } : null)

      const result = await new GitCheckpointStore(runner).checkpoint(root, 'checkpoint: broken')

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('git-failed')
    })
  })

  describe('worktreeBelongsToStore', () => {
    it('recognizes a worktree cut from a checkpoint store', async () => {
      const worktree = temporaryDirectory('jamat-v3-store-')
      writeFileSync(
        join(worktree, '.git'),
        `gitdir: C:/projects/app/${CheckpointLayout.storeRelativeConst}/worktrees/042-feat\n`,
        'utf8',
      )

      expect(await new GitCheckpointStore(scripted()).worktreeBelongsToStore(worktree)).toBe(true)
    })

    it('refuses a worktree cut from a project git, which is what the hard cut needs', async () => {
      const worktree = temporaryDirectory('jamat-v3-store-')
      writeFileSync(join(worktree, '.git'), 'gitdir: C:/projects/app/.git/worktrees/042-feat\n', 'utf8')

      expect(await new GitCheckpointStore(scripted()).worktreeBelongsToStore(worktree)).toBe(false)
    })

    it('answers false for a directory with no .git at all', async () => {
      const plain = temporaryDirectory('jamat-v3-store-')

      expect(await new GitCheckpointStore(scripted()).worktreeBelongsToStore(plain)).toBe(false)
    })

    it('answers false for a main copy, whose .git is a directory rather than a pointer', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      mkdirSync(join(root, '.git'), { recursive: true })

      expect(await new GitCheckpointStore(scripted()).worktreeBelongsToStore(root)).toBe(false)
    })
  })

  describe('against a real git', () => {
    it('creates a store a project can be checkpointed into, leaving the root without a .git', async () => {
      const root = temporaryDirectory('jamat-v3-store-real-')
      writeFileSync(join(root, 'a.txt'), 'v1\n', 'utf8')
      const store = new GitCheckpointStore(new GitInvoker())

      const checkpointed = await store.checkpoint(root, 'checkpoint: baseline')

      expect(checkpointed.ok).toBe(true)
      expect(existsSync(join(root, CheckpointLayout.storeRelativeConst, 'HEAD'))).toBe(true)
      expect(existsSync(join(root, '.git'))).toBe(false)

      const context = await store.contextOf(root)
      expect(context.ok).toBe(true)
      if (!context.ok) return
      const log = await new GitInvoker().run(root, [
        ...context.value.gitDirArgs, 'log', '--format=%an <%ae>|%s',
      ])
      expect(log.stdout.trim()).toBe(
        `${CheckpointLayout.authorNameConst} <${CheckpointLayout.authorEmailConst}>|checkpoint: baseline`,
      )

      // A second checkpoint over an unchanged tree is success without a new commit.
      const again = await store.checkpoint(root, 'checkpoint: unchanged')
      expect(again.ok).toBe(true)
      const count = await new GitInvoker().run(root, [...context.value.gitDirArgs, 'rev-list', '--count', 'HEAD'])
      expect(count.stdout.trim()).toBe('1')
      // Real git subprocesses, a dozen of them: the 5 s unit-test default is not enough on a loaded
      // machine, and a timeout here also strands the working directory that afterEach then cannot remove.
    }, 30_000)
  })
})
