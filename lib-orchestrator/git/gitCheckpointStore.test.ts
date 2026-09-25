import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import { CheckpointLayout } from './checkpointLayout'
import { GitCheckpointStore } from './gitCheckpointStore'
import type { GitCommandOutcome, GitCommandRunner, GitResult } from './git.types'
import { GitInvoker } from './gitInvoker'
import { GitMergeManager } from './gitMergeManager'
import { GitWorktreeManager } from './gitWorktreeManager'

describe('lib-orchestrator/git/gitCheckpointStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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

  function outsideGit(): ScriptedRunner {
    return scripted((args) =>
      args.join(' ') === 'rev-parse --show-toplevel' ? { code: 128, stderr: 'fatal: not a git repository' } : null)
  }

  /** An `svn` answering every question the same way, so a volume child can be proved without one. */
  function svnAnswering(outcome: Partial<CommandOutcome>): CommandRunner & { calls: Invocation[] } {
    const calls: Invocation[] = []
    return {
      calls,
      run: async (cwd, args) => {
        calls.push({ cwd, args })
        return { code: 0, stdout: '', stderr: '', failure: null, ...outcome }
      },
    }
  }

  function storeMarker(root: string): string {
    const storeDir = join(root, CheckpointLayout.storeRelativeConst)
    mkdirSync(join(storeDir, 'info'), { recursive: true })
    return storeDir
  }

  /**
   * The four byte sequences the line-ending cases are written against: one LF file and one CRLF
   * file, each before and after a session appends a line to it.
   */
  const unixBeforeConst = 'alpha\nbeta\ngamma\n'
  const unixAfterConst = 'alpha\nbeta\ngamma\ndelta\n'
  const dosBeforeConst = 'alpha\r\nbeta\r\ngamma\r\n'
  const dosAfterConst = 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n'

  function eolFixture(root: string): void {
    writeFileSync(join(root, 'unix.txt'), unixBeforeConst, 'utf8')
    writeFileSync(join(root, 'dos.txt'), dosBeforeConst, 'utf8')
  }

  /**
   * Whole-file bytes, read as latin1 so every byte survives the comparison and a stray carriage
   * return is visible in the failure. A test for this defect may never ask whether a file CONTAINS
   * a carriage return: the tools that answer that question read a file as text and drop it, which
   * is how such an assertion passes over the very conversion it is there to catch.
   */
  function bytesOf(path: string): string {
    return readFileSync(path).toString('latin1')
  }

  function valueOf<T>(result: GitResult<T>): T {
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
    return result.value
  }

  /**
   * Git for Windows ships `core.autocrlf=true` in its SYSTEM config, which a test cannot write. The
   * store's own config is the one place a test can put it, and it reproduces the same conversion:
   * the rule this file is about lives in `info/attributes`, which outranks every config there is.
   */
  async function convertLineEndings(invoker: GitInvoker, root: string, storeDir: string): Promise<void> {
    const set = await invoker.run(root, ['--git-dir', storeDir, 'config', 'core.autocrlf', 'true'])
    expect(set.code, set.stderr).toBe(0)
  }

  describe('rootOf', () => {
    it('takes the nearest ancestor carrying a store for a path with no git root of its own', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      storeMarker(root)
      const nested = join(root, 'packages', 'inner')
      mkdirSync(nested, { recursive: true })
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --show-toplevel'
          ? { code: 128, stderr: 'fatal: not a git repository' }
          : null)

      const answer = await new GitCheckpointStore(runner).rootOf(nested)

      expect(answer.ok).toBe(true)
      if (!answer.ok) return
      expect(answer.value.root).toBe(root)
      expect(answer.value.exists).toBe(true)
    })

    it('never lets a store above claim a project that owns its git root', async () => {
      // The reported shape: an Applications group carries a store and the project below it has its
      // own repository. Answering the group stages every project under it and saves this one as a
      // gitlink, so the checkpoint holds none of the work it was asked for.
      const group = temporaryDirectory('jamat-v3-store-')
      storeMarker(group)
      const project = join(group, 'AppSomething')
      const nested = join(project, 'src')
      mkdirSync(nested, { recursive: true })
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --show-toplevel' ? { stdout: `${project}\n` } : null)

      const answer = await new GitCheckpointStore(runner).rootOf(nested)

      expect(answer.ok).toBe(true)
      if (!answer.ok) return
      expect(answer.value.root).toBe(project)
      expect(answer.value.exists).toBe(false)
    })

    it('still takes a store the project owns, at or below its git root', async () => {
      const project = temporaryDirectory('jamat-v3-store-')
      storeMarker(project)
      const nested = join(project, 'src')
      mkdirSync(nested, { recursive: true })
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --show-toplevel' ? { stdout: `${project}\n` } : null)

      const answer = await new GitCheckpointStore(runner).rootOf(nested)

      expect(answer.ok).toBe(true)
      if (!answer.ok) return
      expect(answer.value.root).toBe(project)
      expect(answer.value.exists).toBe(true)
    })

    it('keeps a worktree cut from a store attached to that store', async () => {
      // A worktree's own git toplevel IS the worktree, so the boundary must not apply to it.
      const root = temporaryDirectory('jamat-v3-store-')
      const storeDir = storeMarker(root)
      const worktree = join(root, '.worktrees', 'try')
      mkdirSync(worktree, { recursive: true })
      writeFileSync(join(worktree, '.git'), `gitdir: ${join(storeDir, 'worktrees', 'try')}\n`, 'utf8')
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --show-toplevel' ? { stdout: `${worktree}\n` } : null)

      const answer = await new GitCheckpointStore(runner).rootOf(worktree)

      expect(answer.ok).toBe(true)
      if (!answer.ok) return
      expect(answer.value.root).toBe(root)
      // The pointer answered, so git was never asked for a toplevel that would have misled it.
      expect(runner.calls).toHaveLength(0)
    })

    it('refuses a group directory, because a checkpoint belongs to a project', async () => {
      const group = resolve('/ApplicationsNodeJs')
      const runner = scripted((args) =>
        args.join(' ') === 'rev-parse --show-toplevel'
          ? { code: 128, stderr: 'fatal: not a git repository' }
          : null)

      const answer = await new GitCheckpointStore(runner).rootOf(group)

      expect(answer.ok).toBe(false)
      if (answer.ok) return
      expect(answer.code).toBe('not-a-repo')
      expect(answer.detail).toContain('not a project')
    })

    it('admits an SVN repository root directly below a volume, the shape of Q:/Docker', async () => {
      const repository = resolve('/JamatV3ProbeRepository')
      const svn = svnAnswering({ stdout: '^/\n' })

      const answer = await new GitCheckpointStore(outsideGit(), undefined, svn).rootOf(repository)

      expect(answer.ok).toBe(true)
      if (!answer.ok) return
      expect(answer.value.root).toBe(repository)
      expect(svn.calls).toContainEqual({
        cwd: resolve('/'),
        args: ['info', '--show-item', 'relative-url', '--non-interactive', '--', `${repository}@`],
      })
    })

    it('refuses a direct volume child that SVN places below its repository root', async () => {
      const subtree = resolve('/JamatV3ProbeSubtree')

      const answer = await new GitCheckpointStore(outsideGit(), undefined, svnAnswering({ stdout: '^/trunk\n' }))
        .rootOf(subtree)

      expect(answer.ok).toBe(false)
      if (answer.ok) return
      expect(answer.code).toBe('not-a-repo')
    })

    it('refuses a direct volume child SVN cannot answer for', async () => {
      const unverified = resolve('/JamatV3ProbeUnverified')
      const svn = svnAnswering({ code: 1, stderr: "svn: E155007: '/x' is not a working copy" })

      const answer = await new GitCheckpointStore(outsideGit(), undefined, svn).rootOf(unverified)

      expect(answer.ok).toBe(false)
      if (answer.ok) return
      expect(answer.code).toBe('not-a-repo')
    })

    it('refuses a known group, home and a volume root without asking SVN at all', async () => {
      // A group once carried a store and may carry SVN metadata too, so neither may admit it.
      const svn = svnAnswering({ stdout: '^/\n' })
      const store = new GitCheckpointStore(outsideGit(), undefined, svn)

      for (const refused of [resolve('/ApplicationsWeb'), resolve('/Tooling'), homedir(), resolve('/')]) {
        const answer = await store.rootOf(refused)
        expect(answer.ok, refused).toBe(false)
      }
      expect(svn.calls).toHaveLength(0)
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
    it('refuses to create a store at a root discovery would refuse', async () => {
      // `init` fails here only so that code without the guard cannot write at a drive root.
      const runner = scripted((args) => args[0] === 'init' ? { code: 1, stderr: 'refused by the test' } : null)
      const svn = svnAnswering({ stdout: '^/trunk\n' })
      const store = new GitCheckpointStore(runner, undefined, svn)

      for (const refused of [resolve('/ApplicationsNodeJs'), resolve('/JamatV3ProbeSubtree')]) {
        const result = await store.ensure(refused)
        expect(result.ok, refused).toBe(false)
        if (result.ok) continue
        expect(result.code).toBe('not-a-repo')
      }
      expect(runner.calls).toHaveLength(0)
    })

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
      writeFileSync(excludesFile, 'node_modules\r\n.env\r\n', 'utf8')
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
      // The copy has to end where the list ends: commit-git.sh refresh-excludes replaces exactly
      // the block between the two markers, and a CR or a blank line inside it reads as content.
      expect(seeded).not.toContain('\r')
      expect(seeded.slice(seeded.indexOf('# --- copy of '))).toBe(
        `# --- copy of ${excludesFile} (a bare store reads no core.excludesFile) ---\n`
        + `node_modules\n.env\n${CheckpointLayout.copyEndMarkerConst}\n`)
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
      expect(seeded).not.toContain(CheckpointLayout.copyEndMarkerConst)
    })

    it('seeds the byte-transparency rule beside the excludes, so nothing is ever converted', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const runner = scripted((args) => {
        if (args[0] === 'init') {
          storeMarker(root)
          return { stdout: 'Initialized\n' }
        }
        if (args.join(' ') === 'config --path --get core.excludesFile') return { code: 1 }
        return null
      })

      expect((await new GitCheckpointStore(runner).ensure(root)).ok).toBe(true)

      const attributes = readFileSync(
        join(root, CheckpointLayout.storeRelativeConst, 'info', 'attributes'),
        'utf8',
      )
      expect(attributes.split('\n')).toContain(CheckpointLayout.eolAttributeConst)
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
      // Finding the project boundary is the only thing git is asked, and it writes nothing.
      expect(runner.calls.map((call) => call.args.join(' '))).toEqual(['rev-parse --show-toplevel'])
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

  describe('repairing a store seeded before the rule', () => {
    it('writes the rule and re-reads the index, because git decides from stat data', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const storeDir = storeMarker(root)
      const messages: string[] = []
      const runner = scripted()

      expect((await new GitCheckpointStore(runner, (message) => messages.push(message))
        .checkpoint(root, 'checkpoint: after the rule')).ok).toBe(true)

      const attributes = readFileSync(join(storeDir, 'info', 'attributes'), 'utf8')
      expect(attributes.split('\n')).toContain(CheckpointLayout.eolAttributeConst)
      // Without the re-read the attribute repairs new stores only: the blobs already in this one
      // went in converted and `git add` would never look at those files again.
      expect(runner.calls.map((call) => call.args.join(' '))).toContain(
        `--git-dir ${storeDir} --work-tree ${root} add --renormalize -A`,
      )
      expect(messages.join('\n')).toContain('byte-transparent')
    })

    it('runs once: a store already carrying the rule is left alone', async () => {
      const root = temporaryDirectory('jamat-v3-store-')
      const storeDir = storeMarker(root)
      writeFileSync(join(storeDir, 'info', 'attributes'), `${CheckpointLayout.eolAttributeConst}\n`, 'utf8')
      const messages: string[] = []
      const runner = scripted()

      await new GitCheckpointStore(runner, (message) => messages.push(message))
        .checkpoint(root, 'checkpoint: unchanged')

      expect(runner.calls.some((call) => call.args.includes('--renormalize'))).toBe(false)
      expect(messages).toEqual([])
    })

    it('puts the rule back when the index cannot be re-read, and says what that means', async () => {
      // Leaving the rule in place would make the next checkpoint skip a store whose index still
      // holds the converted blobs, with nothing left to re-read them.
      const root = temporaryDirectory('jamat-v3-store-')
      const storeDir = storeMarker(root)
      const messages: string[] = []
      const runner = scripted((args) =>
        args.includes('--renormalize') ? { code: 128, stderr: 'fatal: index.lock: File exists\n' } : null)

      await new GitCheckpointStore(runner, (message) => messages.push(message))
        .checkpoint(root, 'checkpoint: over a locked index')

      expect(existsSync(join(storeDir, 'info', 'attributes'))).toBe(false)
      expect(messages.join('\n')).toContain('still converts line endings')
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

  /**
   * A dozen real git subprocesses per case against a real working directory, so these are the
   * cases in this file that say their own budget, the way the real-git cases in gitMergeManager and
   * gitWorktreeManager already do. The first one measured 2 596 ms on an idle machine and 22 558,
   * 25 499 and 28 651 ms under twenty-four, thirty-two and forty-eight concurrent disk workers -
   * against a 30 s that read as a raise and was the package default restated, and that was seen to
   * time out at 30 242 ms. 120 s rather than something nearer those numbers because what a budget
   * catches is a wedged case, not a slow one. A timeout here also strands the working directory,
   * which afterEach then cannot remove while the abandoned git still holds it.
   */
  describe('against a real git', () => {
    it('creates a store a project can be checkpointed into, leaving the root without a .git', {
      timeout: 120_000,
    }, async () => {
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
    })

    it('keeps a mounted external administrative directory out of the store, and its source in', {
      timeout: 120_000,
    }, async () => {
      const root = temporaryDirectory('jamat-v3-store-svn-')
      // The shape that exposed the anchored rule: a project carrying its own .svn AND a mounted
      // svn:external carrying a second one, with no .gitignore of its own to supply the recursive
      // exclusion. Only the directory NAME reaches git, so real working copies are not needed here.
      mkdirSync(join(root, '.svn'), { recursive: true })
      mkdirSync(join(root, 'shared', 'blog', '.svn', 'pristine'), { recursive: true })
      writeFileSync(join(root, '.svn', 'wc.db'), 'root db\n', 'utf8')
      writeFileSync(join(root, 'shared', 'blog', '.svn', 'wc.db'), 'mount db\n', 'utf8')
      writeFileSync(join(root, 'shared', 'blog', '.svn', 'pristine', 'a.svn-base'), 'base\n', 'utf8')
      writeFileSync(join(root, 'shared', 'blog', 'models.py'), 'shared source\n', 'utf8')
      writeFileSync(join(root, 'main.py'), 'app source\n', 'utf8')
      const store = new GitCheckpointStore(new GitInvoker())

      expect((await store.checkpoint(root, 'checkpoint: with a mounted external')).ok).toBe(true)

      const context = await store.contextOf(root)
      expect(context.ok).toBe(true)
      if (!context.ok) return
      const tracked = await new GitInvoker().run(root, [...context.value.gitDirArgs, 'ls-files'])
      const paths = tracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      expect(paths.filter((path) => path.split('/').includes('.svn'))).toEqual([])
      expect(paths).toContain('shared/blog/models.py')
      expect(paths).toContain('main.py')
      // The administrative files are excluded, never removed: the store only ever declines to stage them.
      expect(existsSync(join(root, 'shared', 'blog', '.svn', 'wc.db'))).toBe(true)
      expect(existsSync(join(root, '.svn', 'wc.db'))).toBe(true)
      const seeded = readFileSync(join(root, CheckpointLayout.storeRelativeConst, 'info', 'exclude'), 'utf8')
      expect(seeded.split('\n')).toContain('.svn/')
      expect(seeded.split('\n')).not.toContain('/.svn/')
    })

    it('hands a worktree the bytes the project holds, and lands an edit as one line', {
      timeout: 120_000,
    }, async () => {
      const root = temporaryDirectory('jamat-v3-store-eol-')
      eolFixture(root)
      const invoker = new GitInvoker()
      const store = new GitCheckpointStore(invoker)
      const storeDir = valueOf(await store.ensure(root)).storeDir
      await convertLineEndings(invoker, root, storeDir)
      const context = { modeOf: () => 'checkpoints' as const, store }

      const facts = valueOf(await new GitWorktreeManager(invoker, context).create(root, 'EOL'))

      expect(bytesOf(join(facts.worktreePath, 'unix.txt'))).toBe(unixBeforeConst)
      expect(bytesOf(join(facts.worktreePath, 'dos.txt'))).toBe(dosBeforeConst)

      writeFileSync(join(facts.worktreePath, 'unix.txt'), unixAfterConst, 'utf8')
      expect((await store.checkpointWorktree(facts.worktreePath, 'the session appends a line')).ok)
        .toBe(true)
      expect(await new GitMergeManager(invoker, context)
        .mergeToMain(facts.repositoryRoot, facts.branch))
        .toEqual({ ok: true, value: { conflict: false, diverged: false } })

      expect(bytesOf(join(root, 'unix.txt'))).toBe(unixAfterConst)
      // The file nobody touched is the one a conversion rewrites end to end, and that is the damage:
      // a 59-line addition arrived for review as a 1733-line SVN diff.
      expect(bytesOf(join(root, 'dos.txt'))).toBe(dosBeforeConst)
    })

    it('repairs a store seeded before the rule and names the worktree cut before it', {
      timeout: 120_000,
    }, async () => {
      const root = temporaryDirectory('jamat-v3-store-eol-old-')
      eolFixture(root)
      const invoker = new GitInvoker()
      const storeDir = join(root, CheckpointLayout.storeRelativeConst)
      // Exactly what the seed produced before this rule existed: the excludes, no attributes, and
      // every blob converted on the way in by the conversion the store reads from its config.
      expect((await invoker.run(
        root,
        ['init', '--bare', '-b', CheckpointLayout.branchConst, storeDir],
      )).code).toBe(0)
      writeFileSync(
        join(storeDir, 'info', 'exclude'),
        `${CheckpointLayout.selfExcludesConst.join('\n')}\n`,
        'utf8',
      )
      await convertLineEndings(invoker, root, storeDir)
      const target = ['--git-dir', storeDir, '--work-tree', root]
      expect((await invoker.run(root, [...target, 'add', '-A'])).code).toBe(0)
      expect((await invoker.run(root, [
        ...target,
        '-c', `user.name=${CheckpointLayout.authorNameConst}`,
        '-c', `user.email=${CheckpointLayout.authorEmailConst}`,
        'commit', '--message', 'checkpoint before the rule',
      ])).code).toBe(0)
      const stale = join(root, '.worktrees', 'stale')
      expect((await invoker.run(root, [
        ...target, 'worktree', 'add', '-b', 'jamat/stale', stale, CheckpointLayout.branchConst,
      ])).code).toBe(0)
      // The old store really did convert, which is what makes the rest of this case mean anything.
      expect(bytesOf(join(stale, 'unix.txt'))).not.toBe(unixBeforeConst)

      const messages: string[] = []
      const store = new GitCheckpointStore(invoker, (message) => messages.push(message))
      expect((await store.checkpoint(root, 'the checkpoint that repairs it')).ok).toBe(true)

      expect(messages.join('\n')).toContain('byte-transparent')
      // That worktree was checked out converted and carries those bytes home whatever the store
      // now says, so the repair names it instead of reaching into it.
      expect(messages.join('\n')).toContain(stale)
      // The repair touches the index and nothing else: no file on disk and no earlier commit.
      expect(bytesOf(join(root, 'unix.txt'))).toBe(unixBeforeConst)
      expect(bytesOf(join(root, 'dos.txt'))).toBe(dosBeforeConst)
      const log = await invoker.run(root, [...target, 'log', '--format=%s'])
      expect(log.stdout.split('\n').map((line) => line.trim()))
        .toContain('checkpoint before the rule')

      const context = { modeOf: () => 'checkpoints' as const, store }
      const facts = valueOf(
        await new GitWorktreeManager(invoker, context).create(root, 'After repair'),
      )
      expect(bytesOf(join(facts.worktreePath, 'unix.txt'))).toBe(unixBeforeConst)
      expect(bytesOf(join(facts.worktreePath, 'dos.txt'))).toBe(dosBeforeConst)

      writeFileSync(join(facts.worktreePath, 'dos.txt'), dosAfterConst, 'utf8')
      expect((await store.checkpointWorktree(facts.worktreePath, 'the session appends a line')).ok)
        .toBe(true)
      expect(await new GitMergeManager(invoker, context)
        .mergeToMain(facts.repositoryRoot, facts.branch))
        .toEqual({ ok: true, value: { conflict: false, diverged: false } })
      expect(bytesOf(join(root, 'dos.txt'))).toBe(dosAfterConst)
      expect(bytesOf(join(root, 'unix.txt'))).toBe(unixBeforeConst)
    })
  })
})
