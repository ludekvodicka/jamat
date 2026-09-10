import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GitCommandRunner } from './git.types'
import { GitCommitManager } from './gitCommitManager'

describe('lib-orchestrator/git/gitCommitManager', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'jamat-git-commit-test-'))
    roots.push(root)
    await mkdir(join(root, '.git'))
    const calls: string[][] = []
    const runner: GitCommandRunner = { run: async (_cwd, args) => {
      calls.push(args)
      return { code: 0, failure: null, stderr: '', stdout: args.includes('--show-toplevel') ? root : args.includes('HEAD') ? 'hash\n' : 'committed\n' }
    } }
    return { root, calls, runner, manager: new GitCommitManager(runner) }
  }

  it('stages and commits only literal selected paths through a message file', async () => {
    const { root, calls, manager } = await fixture()
    expect(await manager.commit(root, [join(root, 'a [b].txt')], 'message.txt')).toEqual({ ok: true, value: { hash: 'hash', output: 'committed\n' } })
    expect(calls).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['add', '-A', '--', ':(literal)a [b].txt'],
      ['commit', '--only', '-F', 'message.txt', '--', ':(literal)a [b].txt'],
      ['rev-parse', '--verify', 'HEAD'],
    ])
  })

  it('refuses a pending merge before staging', async () => {
    const { root, calls, manager } = await fixture()
    await writeFile(join(root, '.git', 'MERGE_HEAD'), 'head')
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toMatchObject({ ok: false, code: 'git-failed', detail: expect.stringContaining('merge is in progress') })
    expect(calls).toEqual([['rev-parse', '--show-toplevel']])
  })

  it('refuses a store or foreign linked worktree before staging', async () => {
    const { root, calls, manager } = await fixture()
    await rm(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git'), 'gitdir: ../.checkpoints/store.git/worktrees/test')
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toMatchObject({ ok: false, code: 'git-failed' })
    expect(calls).toHaveLength(1)
  })

  it('returns a refusing hook without attempting to read a success hash', async () => {
    const { root, calls, runner } = await fixture()
    const manager = new GitCommitManager({ run: async (cwd, args) => {
      const result = await runner.run(cwd, args)
      return args[0] === 'commit' ? { ...result, code: 1, stderr: 'hook refused' } : result
    } })
    expect(await manager.commit(root, [join(root, 'a')], 'message.txt')).toMatchObject({ ok: false, code: 'git-failed', detail: 'hook refused' })
    expect(calls.at(-1)?.[0]).toBe('commit')
  })
})
