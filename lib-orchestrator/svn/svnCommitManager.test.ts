import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import { SvnCommitManager } from './svnCommitManager'

describe('lib-orchestrator/svn/svnCommitManager', () => {
  function fixture(failure?: string) {
    const scope = resolve('scope')
    const calls: string[][] = []
    const lists: string[] = []
    const svn: CommandRunner = { run: async (_cwd, args): Promise<CommandOutcome> => {
      calls.push(args)
      if (args[0] === 'commit') lists.push(await readFile(args[args.indexOf('--targets') + 1], 'utf8'))
      return { code: failure === undefined ? 0 : 1, stdout: 'Committed revision 42.\n', stderr: failure ?? '', failure: null }
    } }
    const manager = new SvnCommitManager({ svn,
      git: { run: async () => ({ code: 0, failure: null, stderr: '', stdout: 'nested/file.txt\0' }) },
      checkpointStore: { existingContextOf: async () => ({ ok: true, value: null }) },
    })
    return { manager, scope, calls, lists }
  }

  it('adds a file, deletes a missing file and commits shallow explicit targets', async () => {
    const { manager, scope, calls, lists } = fixture()
    const a = resolve(scope, 'a@b.txt')
    const b = resolve(scope, 'deleted.txt')
    expect(await manager.commit(scope, [
      { absolutePath: a, nodeKind: 'file', status: 'untracked' },
      { absolutePath: b, nodeKind: 'file', status: 'missing' },
    ], 'message.txt')).toEqual({ ok: true, value: { revision: '42', output: 'Committed revision 42.\n' } })
    expect(calls[0]).toEqual(['add', '--parents', '--non-interactive', '--', `${a}@`])
    expect(calls[1]).toEqual(['delete', '--non-interactive', '--', `${b}@`])
    expect(calls[2]).toEqual(['commit', '--non-interactive', '--encoding', 'UTF-8', '--file', 'message.txt', '--targets', expect.any(String), '--depth', 'empty'])
    expect(lists).toEqual([`${a}@\n${b}@\n`])
    await expect(readFile(calls[2][7], 'utf8')).rejects.toThrow()
  })

  it('uses Git listing for an untracked directory and includes all added ancestors', async () => {
    const { manager, scope, calls, lists } = fixture()
    const directory = resolve(scope, 'new')
    expect(await manager.commit(scope, [{ absolutePath: directory, nodeKind: 'directory', status: 'untracked' }], 'message.txt')).toMatchObject({ ok: true })
    expect(calls[0]).toEqual(['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${directory}@`])
    expect(lists[0]).toContain(`${resolve(directory, 'nested')}@\n`)
    expect(lists[0]).toContain(`${resolve(directory, 'nested/file.txt')}@\n`)
  })

  it('refuses conflicts and outside targets before any write', async () => {
    const { manager, scope, calls } = fixture()
    for (const target of [
      { absolutePath: resolve(scope, 'conflict'), nodeKind: 'file' as const, status: 'conflicted' as const },
      { absolutePath: resolve(scope, '../outside'), nodeKind: 'file' as const, status: 'modified' as const },
    ]) expect(await manager.commit(scope, [target], 'message.txt')).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })

  it('returns the SVN out-of-date code', async () => {
    const { manager, scope } = fixture('E155011: out of date')
    expect(await manager.commit(scope, [{ absolutePath: resolve(scope, 'a'), nodeKind: 'file', status: 'modified' }], 'message.txt')).toMatchObject({ ok: false, code: 'out-of-date' })
  })
})
