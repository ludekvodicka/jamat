import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import type { CommitProgress } from '../shared/commitProgress.types'
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
    const manager = new SvnCommitManager(svn)
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
    expect(calls[0]).toEqual(['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${a}@`])
    expect(calls[1]).toEqual(['delete', '--non-interactive', '--', `${b}@`])
    expect(calls[2]).toEqual(['commit', '--non-interactive', '--encoding', 'UTF-8', '--file', 'message.txt', '--targets', expect.any(String), '--depth', 'empty'])
    expect(lists).toEqual([`${a}@\n${b}@\n`])
    await expect(readFile(calls[2][7], 'utf8')).rejects.toThrow()
  })

  it('adds a selected directory at depth empty without discovering or staging its children', async () => {
    const { manager, scope, calls, lists } = fixture()
    const directory = resolve(scope, 'new')
    expect(await manager.commit(scope, [{ absolutePath: directory, nodeKind: 'directory', status: 'untracked' }], 'message.txt')).toMatchObject({ ok: true })
    expect(calls[0]).toEqual(['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${directory}@`])
    expect(lists[0]).toBe(`${directory}@\n`)
    expect(calls).toHaveLength(2)
  })

  it('stages a path an earlier attempt already versioned, so the retry of that selection commits', async () => {
    const scope = resolve('scope')
    const path = resolve(scope, 'already.txt')
    const calls: string[][] = []
    const lists: string[] = []
    const manager = new SvnCommitManager({ run: async (_cwd, args) => {
      calls.push(args)
      if (args[0] === 'add') return { code: 1, failure: null, stdout: '',
        stderr: `svn: warning: W150002: '${path}' is already under version control\nsvn: E200009: Could not add all targets because some targets are already versioned` }
      if (args[0] === 'info') return { code: 0, failure: null, stderr: '',
        stdout: `<info><entry kind="file" path="${path}"><wc-info><schedule>add</schedule></wc-info></entry></info>` }
      lists.push(await readFile(args[args.indexOf('--targets') + 1], 'utf8'))
      return { code: 0, failure: null, stderr: '', stdout: 'Committed revision 42.\n' }
    } })
    expect(await manager.commit(scope, [{ absolutePath: path, nodeKind: 'file', status: 'untracked' }], 'message.txt'))
      .toMatchObject({ ok: true, value: { revision: '42' } })
    expect(calls[1]).toEqual(['info', '--xml', '--non-interactive', '--', `${path}@`])
    expect(lists).toEqual([`${path}@\n`])
  })

  it('asks about the target itself and reports an add failure the path does not explain', async () => {
    const scope = resolve('scope')
    const path = resolve(scope, 'blocked.txt')
    const calls: string[][] = []
    const manager = new SvnCommitManager({ run: async (_cwd, args) => {
      calls.push(args)
      return args[0] === 'info'
        ? { code: 1, failure: null, stdout: '<info>\n</info>', stderr: `svn: warning: W155010: The node '${path}' was not found.` }
        : { code: 1, failure: null, stdout: '', stderr: 'svn: E155004: Working copy locked' }
    } })
    expect(await manager.commit(scope, [{ absolutePath: path, nodeKind: 'file', status: 'untracked' }], 'message.txt'))
      .toMatchObject({ ok: false, code: 'locked' })
    expect(calls.map(([command]) => command)).toEqual(['add', 'info'])
  })

  it('reports staging and streamed SVN progress while the command is still running', async () => {
    const scope = resolve('scope')
    const events: CommitProgress[] = []
    const manager = new SvnCommitManager({ run: async (_cwd, args, options) => {
      if (args[0] === 'commit') {
        expect(events).toContainEqual({ stage: 'preparing', completed: 2, total: 2 })
        options?.onStdout?.('Adding         file\nDeleting       old\nTransmitting file data .')
        expect(events.at(-1)).toEqual({ stage: 'transmitting', completed: 1, total: null })
        options?.onStdout?.('done\nCommitting transaction...\n')
      }
      return { code: 0, stdout: 'Committed revision 42.\n', stderr: '', failure: null }
    } })
    expect(await manager.commit(scope, [
      { absolutePath: resolve(scope, 'file'), nodeKind: 'file', status: 'untracked' },
      { absolutePath: resolve(scope, 'old'), nodeKind: 'file', status: 'missing' },
    ], 'message.txt', (value) => events.push(value))).toMatchObject({ ok: true })
    expect(events.at(-1)?.stage).toBe('committing')
  })

  it('refuses conflicts and outside targets before any write', async () => {
    const { manager, scope, calls } = fixture()
    for (const target of [
      { absolutePath: resolve(scope, 'conflict'), nodeKind: 'file' as const, status: 'conflicted' as const },
      { absolutePath: resolve(scope, '../outside'), nodeKind: 'file' as const, status: 'modified' as const },
    ]) expect(await manager.commit(scope, [target], 'message.txt')).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })

  it.each(['E155011', 'E160028', 'E170004'])('recognizes the SVN %s out-of-date code', async (code) => {
    const { manager, scope } = fixture(`${code}: commit refused`)
    expect(await manager.commit(scope, [{ absolutePath: resolve(scope, 'a'), nodeKind: 'file', status: 'modified' }], 'message.txt')).toMatchObject({ ok: false, code: 'out-of-date' })
  })

  it.each([
    ['text', '<target path="scope"><entry path="text.txt"><wc-status item="conflicted" props="none" /></entry></target>', 'text.txt'],
    ['properties', '<target path="scope"><entry path="folder"><wc-status item="normal" props="conflicted" /></entry></target>', 'folder'],
    ['tree', '<target path="scope"><entry path="deleted"><wc-status item="deleted" props="none" tree-conflicted="true" /></entry></target>', 'deleted'],
    ['changelist', '<target path="scope"/><changelist name="review"><entry path="grouped.txt"><wc-status item="conflicted" props="none" /></entry></changelist>', 'grouped.txt'],
    ['clean', '<target path="scope"/>', null],
  ])('checks %s conflicts after a zero-exit update without resolving or including externals', async (_kind, xml, conflict) => {
    const scope = resolve('scope@with spaces')
    const calls: string[][] = []
    const manager = new SvnCommitManager({ run: async (cwd, args) => {
      expect(cwd).toBe(scope)
      calls.push(args)
      return { code: 0, failure: null, stderr: '', stdout: args[0] === 'update' ? 'Updated to revision 43.\n' : `<status>${xml}</status>` }
    } })
    const result = await manager.update(scope)
    expect(calls).toEqual([
      ['update', '--non-interactive', '--accept', 'postpone', '--ignore-externals', '--', `${scope}@`],
      ['status', '--xml', '--non-interactive', '--ignore-externals', '--', `${scope}@`],
    ])
    if (conflict === null) expect(result).toEqual({ ok: true, value: { output: 'Updated to revision 43.\n' } })
    else expect(result).toMatchObject({ ok: false, detail: expect.stringContaining(conflict) })
  })

  it('reports update stdout and stderr and stops after a failed update', async () => {
    const calls: string[][] = []
    const manager = new SvnCommitManager({ run: async (_cwd, args) => {
      calls.push(args)
      return { code: 1, failure: null, stdout: 'C    conflict.txt\n', stderr: 'E170013: Connection refused' }
    } })
    expect(await manager.update(resolve('scope'))).toEqual({ ok: false, code: 'svn-failed', detail: 'C    conflict.txt\nE170013: Connection refused' })
    expect(calls).toHaveLength(1)
  })

  it.each(['status-error', 'invalid-status'])('never reports a clean update after %s', async (kind) => {
    const manager = new SvnCommitManager({ run: async (_cwd, args) => args[0] === 'update'
      ? { code: 0, failure: null, stdout: 'Updated to revision 43.', stderr: '' }
      : { code: kind === 'status-error' ? 1 : 0, failure: null, stdout: 'invalid status', stderr: '' } })
    expect(await manager.update(resolve('scope'))).toMatchObject({ ok: false, detail: expect.stringContaining('Updated to revision 43.') })
  })
})
