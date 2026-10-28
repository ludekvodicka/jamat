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

  async function fixture() {
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
      return { code: 0, failure: null, stderr: '', stdout: args.includes('--show-toplevel') ? root : args.includes('HEAD') ? 'hash\n' : 'committed\n' }
    } }
    return { root, calls, pathspecs, runner, manager: new GitCommitManager(runner) }
  }

  it('stages and commits only literal selected paths through a message file', async () => {
    const { root, calls, pathspecs, manager } = await fixture()
    expect(await manager.commit(root, [join(root, 'a [b].txt')], 'message.txt')).toEqual({ ok: true, value: { hash: 'hash', output: 'committed\n' } })
    expect(calls).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['add', '-A', `--pathspec-from-file=${pathspecs[0]!.file}`, '--pathspec-file-nul'],
      ['commit', '--only', '-F', 'message.txt', `--pathspec-from-file=${pathspecs[0]!.file}`, '--pathspec-file-nul'],
      ['rev-parse', '--verify', 'HEAD'],
    ])
    expect(pathspecs).toEqual([
      { file: pathspecs[0]!.file, content: ':(literal)a [b].txt\0' },
      { file: pathspecs[0]!.file, content: ':(literal)a [b].txt\0' },
    ])
    await expect(stat(pathspecs[0]!.file)).rejects.toMatchObject({ code: 'ENOENT' })
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
    const { root, pathspecs, runner } = await fixture()
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === command && !args.includes('--show-toplevel') ? { ...result, code: 1, stderr: 'failed' } : result
    } })
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toMatchObject({ ok: false })
    await expect(stat(pathspecs[0]!.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans the selection file when the runner rejects', async () => {
    const { root, pathspecs, runner } = await fixture()
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      if (args[0] === 'add') throw new Error('interrupted')
      return result
    } })
    await expect(manager.commit(root, [join(root, 'a')], 'message.txt')).rejects.toThrow('interrupted')
    await expect(stat(pathspecs[0]!.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
