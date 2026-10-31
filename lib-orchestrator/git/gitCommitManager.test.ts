import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GitCommandRunner } from './git.types'
import type { CommitProgress } from '../shared/commitProgress.types'
import { GitCommitManager } from './gitCommitManager'

describe('lib-orchestrator/git/gitCommitManager', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function fixture(untracked: readonly string[] = []) {
    const root = await mkdtemp(join(tmpdir(), 'jamat-git-commit-test-'))
    roots.push(root)
    await mkdir(join(root, '.git'))
    const calls: string[][] = []
    const pathspecs: { file: string; content: string }[] = []
    const runner: GitCommandRunner = { run: async (_cwd, args) => {
      calls.push(args)
      const pathspec = args.find((arg) => arg.startsWith('--pathspec-from-file='))
      if (pathspec) {
        const file = pathspec.slice('--pathspec-from-file='.length)
        pathspecs.push({ file, content: await readFile(file, 'utf8') })
      }
      const stdout = args.includes('--show-toplevel') ? root : args[0] === 'ls-files' ? untracked.map((path) => `${path}\0`).join('')
        : args.includes('HEAD') ? 'hash\n' : 'committed\n'
      return { code: 0, failure: null, stderr: '', stdout }
    } }
    return { root, calls, pathspecs, runner, manager: new GitCommitManager(runner) }
  }

  const listUntracked = ['ls-files', '-z', '--others', '--exclude-standard', '--full-name']

  it('commits tracked selected paths through a message file without staging them first', async () => {
    const { root, calls, pathspecs, manager } = await fixture()
    expect(await manager.commit(root, [join(root, 'a [b].txt')], 'message.txt')).toEqual({ ok: true, value: { hash: 'hash', output: 'committed\n' } })
    expect(calls).toEqual([
      ['rev-parse', '--show-toplevel'],
      listUntracked,
      ['commit', '--only', '-F', 'message.txt', `--pathspec-from-file=${pathspecs[0]!.file}`, '--pathspec-file-nul'],
      ['rev-parse', '--verify', 'HEAD'],
    ])
    expect(pathspecs).toEqual([{ file: pathspecs[0]!.file, content: ':(literal)a [b].txt\0' }])
    await expect(stat(pathspecs[0]!.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('announces only the selected new files before the commit', async () => {
    const { root, calls, pathspecs, manager } = await fixture(['new.txt', 'foreign.txt'])
    expect(await manager.commit(root, [join(root, 'new.txt'), join(root, 'tracked.txt')], 'message.txt')).toMatchObject({ ok: true })
    const [added, selection] = pathspecs
    expect(calls.slice(1, 4)).toEqual([
      listUntracked,
      ['add', '--intent-to-add', `--pathspec-from-file=${added!.file}`, '--pathspec-file-nul'],
      ['commit', '--only', '-F', 'message.txt', `--pathspec-from-file=${selection!.file}`, '--pathspec-file-nul'],
    ])
    expect(added!.content).toBe(':(literal)new.txt\0')
    expect(selection!.content).toBe(':(literal)new.txt\0:(literal)tracked.txt\0')
  })

  it('withdraws the announcement when Git or a hook refuses the commit', async () => {
    const { root, calls, pathspecs, runner } = await fixture(['new.txt'])
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === 'commit' ? { ...result, code: 1, stderr: 'hook refused' } : result
    } })
    expect(await manager.commit(root, [join(root, 'new.txt')], 'message.txt')).toEqual({ ok: false, code: 'git-failed', detail: 'hook refused' })
    expect(calls.at(-1)).toEqual(['rm', '--cached', '--quiet', '--ignore-unmatch', `--pathspec-from-file=${pathspecs[0]!.file}`, '--pathspec-file-nul'])
  })

  it('withdraws the announcement when add refuses one of the new files', async () => {
    const { root, calls, runner } = await fixture(['new.txt', 'ignored.txt'])
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === 'add' ? { ...result, code: 1, stderr: 'The following paths are ignored' } : result
    } })
    expect(await manager.commit(root, [join(root, 'new.txt'), join(root, 'ignored.txt')], 'message.txt')).toMatchObject({ ok: false })
    expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'ls-files', 'add', 'rm'])
  })

  it('keeps the announcement when the commit process did not run to completion', async () => {
    const { root, calls, runner } = await fixture(['new.txt'])
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === 'commit' ? { ...result, failure: 'timeout' } : result
    } })
    expect(await manager.commit(root, [join(root, 'new.txt')], 'message.txt')).toMatchObject({ ok: false })
    expect(calls.at(-1)?.[0]).toBe('commit')
  })

  it('says when the announcement could not be withdrawn', async () => {
    const { root, runner } = await fixture(['new.txt'])
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      if (args[0] === 'commit') return { ...result, code: 1, stderr: 'hook refused' }
      return args[0] === 'rm' ? { ...result, code: 128, stderr: 'fatal: index.lock exists' } : result
    } })
    const result = await manager.commit(root, [join(root, 'new.txt')], 'message.txt')
    expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(/^hook refused\n\nThe new files stay announced .*index\.lock exists$/s) })
  })

  it('puts the refusal before Git warnings in the detail', async () => {
    const { root, runner } = await fixture()
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === 'commit' ? { ...result, code: 1, stderr: [
        "warning: in the working copy of 'a.mjs', CRLF will be replaced by LF the next time Git touches it",
        'hook refused: not the approved index',
        "warning: in the working copy of 'b.mjs', CRLF will be replaced by LF the next time Git touches it",
        'second line',
      ].join('\r\n') } : result
    } })
    expect(await manager.commit(root, [join(root, 'a.mjs')], 'message.txt')).toMatchObject({ ok: false, detail: [
      'hook refused: not the approved index',
      'second line',
      '',
      "warning: in the working copy of 'a.mjs', CRLF will be replaced by LF the next time Git touches it",
      "warning: in the working copy of 'b.mjs', CRLF will be replaced by LF the next time Git touches it",
    ].join('\n') })
  })

  it('reads the reason from stdout when stderr holds only warnings', async () => {
    const { root, runner } = await fixture()
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === 'commit' ? { ...result, code: 1, stderr: 'warning: CRLF will be replaced by LF', stdout: 'nothing added to commit' } : result
    } })
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt'))
      .toMatchObject({ ok: false, detail: 'nothing added to commit\n\nwarning: CRLF will be replaced by LF' })
  })

  it('refuses a pending merge before staging', async () => {
    const { root, calls, manager } = await fixture()
    await writeFile(join(root, '.git', 'MERGE_HEAD'), 'head')
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toMatchObject({ ok: false, code: 'git-failed', detail: expect.stringContaining('merge is in progress') })
    expect(calls).toEqual([['rev-parse', '--show-toplevel']])
  })

  it('reports Git stages without inventing file counts during hooks', async () => {
    const { root, manager } = await fixture()
    const events: CommitProgress[] = []
    await manager.commit(root, [join(root, 'file')], 'message.txt', (value) => events.push(value))
    expect(events).toEqual([
      { stage: 'preparing', completed: 0, total: null },
      { stage: 'committing', completed: 0, total: null },
      { stage: 'verifying', completed: 0, total: null },
    ])
  })

  it('refuses a store or foreign linked worktree before staging', async () => {
    const { root, calls, manager } = await fixture()
    await rm(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git'), 'gitdir: ../.checkpoints/store.git/worktrees/test')
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toMatchObject({ ok: false, code: 'git-failed' })
    expect(calls).toHaveLength(1)
  })

  it('returns a refusing hook without attempting to read a success hash', async () => {
    const { root, calls, pathspecs, runner } = await fixture()
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === 'commit' ? { ...result, code: 1, stderr: 'hook refused' } : result
    } })
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toMatchObject({ ok: false, code: 'git-failed', detail: 'hook refused' })
    expect(calls.at(-1)?.[0]).toBe('commit')
    await expect(stat(pathspecs[0]!.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['add', 'commit', 'rev-parse'] as const)('cleans the selection file when %s fails', async (command) => {
    const { root, pathspecs, runner } = await fixture(['a'])
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === command && !args.includes('--show-toplevel') ? { ...result, code: 1, stderr: 'failed' } : result
    } })
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toMatchObject({ ok: false })
    await expect(stat(pathspecs[0]!.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans the selection file when the runner rejects', async () => {
    const { root, pathspecs, runner } = await fixture(['a'])
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      if (args[0] === 'add') throw new Error('interrupted')
      return result
    } })
    await expect(manager.commit(root, [join(root, 'a')], 'message.txt')).rejects.toThrow('interrupted')
    await expect(stat(pathspecs[0]!.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stages nothing when Git cannot list the new files', async () => {
    const { root, calls, runner } = await fixture()
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === 'ls-files' ? { ...result, code: 128, stderr: 'fatal: bad index' } : result
    } })
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toEqual({ ok: false, code: 'git-failed', detail: 'fatal: bad index' })
    expect(calls).toHaveLength(2)
  })
})
