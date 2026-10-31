import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeLease } from '../worktrees/worktreeLease'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import type { CommitProgress } from '../shared/commitProgress.types'
import { SvnCommitManager } from './svnCommitManager'

describe('lib-orchestrator/svn/svnCommitManager', () => {
  let testScope: string
  beforeEach(async () => {
    testScope = await mkdtemp(join(tmpdir(), 'jamat-commit-gate-'))
    for (const name of ['changed.txt', 'unchanged.txt', 'a@b.txt', 'a/b/one.txt', 'a/b/two.txt', 'engines/run/00-run.md',
      'engines/run/01-run.md', 'data/run.json', 'new.tsx', 'already.txt', 'blocked.txt', 'file', 'a.txt']) {
      const path = resolve(testScope, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'selected content')
    }
  })
  afterEach(async () => { await rm(testScope, { recursive: true, force: true }) })

  it('waits behind a main-copy update before reading or staging a reviewed commit', async () => {
    const lease = new WorktreeLease('dialog', () => [])
    let release: () => void = () => {}
    let entered = false
    const wait = new Promise<void>((done) => { release = done })
    const update = lease.within(testScope, 'update', async () => { entered = true; await wait })
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 8000 })
    const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'stop after first read', failure: null }))
    const manager = new SvnCommitManager({ run }, (root, _paths, work) => lease.within(root, 'commit', work))
    const commit = manager.commit(testScope, [{ absolutePath: join(testScope, 'a.txt'), status: 'modified', nodeKind: 'file' }], 'message.txt')
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
    release()
    await update
    expect(await commit).toMatchObject({ ok: false })
    expect(run).toHaveBeenCalledTimes(1)
  })

  function cleanManager(svn: CommandRunner): SvnCommitManager {
    return new SvnCommitManager({ run: (cwd, args, options) => args.join(' ') === 'status --xml -- .'
      ? Promise.resolve({ code: 0, failure: null, stderr: '', stdout: '<status><target path="."/></status>' })
      : args.includes('HEAD') ? Promise.resolve({ code: 0, failure: null, stderr: '', stdout: '<info><entry revision="41"/></info>' })
      : svn.run(cwd, args, options) })
  }

  it('reads a localized commit revision from first-target info above the bound', async () => {
    const manager = cleanManager({ run: async (_cwd, args) => ({ code: 0, failure: null, stderr: '', stdout:
      args[0] === 'info' ? '<info><entry revision="42"/></info>' : 'Uložena revize 42.' }) })
    expect(await manager.commit(testScope, [{ absolutePath: resolve(testScope, 'a.txt'), nodeKind: 'file', status: 'modified' }], 'message.txt'))
      .toMatchObject({ ok: true, value: { revision: '42' } })
  })

  it('reports only paths SVN actually sent, including added parents and binary files', async () => {
    const scope = testScope
    const output = 'Sending        changed.txt\r\nAdding         parent\r\nAdding  (bin)  parent/žluť @.png\r\nDeleting       old\r\nReplacing      replaced\r\nSending         leading.txt\r\nCommitted revision 42.\r\n'
    const manager = cleanManager({ run: async () => ({ code: 0, failure: null, stderr: '', stdout: output }) })
    const result = await manager.commit(scope, ['changed.txt', 'unchanged.txt'].map((name) => ({
      absolutePath: resolve(scope, name), nodeKind: 'file', status: 'modified',
    })), 'message.txt')
    expect(result).toMatchObject({ ok: true, value: { committedPaths: [
      'changed.txt', 'parent', 'parent/žluť @.png', 'old', 'replaced', ' leading.txt',
    ].map((name) => resolve(scope, name)) } })
  })

  function fixture(failure?: string) {
    const scope = testScope
    const calls: string[][] = []
    const lists: string[] = []
    const svn: CommandRunner = { run: async (_cwd, args): Promise<CommandOutcome> => {
      calls.push(args)
      if (args[0] === 'info') return { code: 0, failure: null, stderr: '',
        stdout: '<info><entry kind="dir"><wc-info><schedule>normal</schedule></wc-info></entry></info>' }
      if (args[0] === 'commit') lists.push(await readFile(args[args.indexOf('--targets') + 1], 'utf8'))
      return { code: failure === undefined ? 0 : 1, stdout: 'Committed revision 42.\n', stderr: failure ?? '', failure: null }
    } }
    const manager = cleanManager(svn)
    return { manager, scope, calls, lists }
  }

  /** An `svn info` answer per path: an absent path is the unversioned one `--parents` creates. */
  function schedules(scope: string, known: ReadonlyMap<string, string>) {
    const calls: string[][] = []
    const lists: string[] = []
    const manager = cleanManager({ run: async (_cwd, args) => {
      calls.push(args)
      const path = args[args.length - 1].slice(0, -1)
      if (args[0] === 'info') {
        const schedule = known.get(path)
        return schedule === undefined
          ? { code: 1, failure: null, stdout: '<info>\n</info>', stderr: `svn: warning: W155010: The node '${path}' was not found.` }
          : { code: 0, failure: null, stderr: '', stdout: `<info><entry kind="dir" path="${path}"><wc-info><schedule>${schedule}</schedule></wc-info></entry></info>` }
      }
      if (args[0] === 'commit') lists.push(await readFile(args[args.indexOf('--targets') + 1], 'utf8'))
      return { code: 0, failure: null, stderr: '', stdout: 'Committed revision 42.\n' }
    } })
    return { manager, scope, calls, lists }
  }

  it('records staged additions before svn add and refuses an add whose evidence cannot be saved', async () => {
    const { manager, scope, calls } = fixture()
    const target = { absolutePath: resolve(scope, 'a.txt'), nodeKind: 'file' as const, status: 'untracked' as const }
    const result = await manager.prepare(scope, [target], undefined, async (paths) => {
      expect(calls.some((args) => args[0] === 'add')).toBe(false)
      expect(paths).toContain(target.absolutePath)
      throw new Error('journal write failed')
    })
    expect(result).toMatchObject({ ok: false, detail: 'journal write failed' })
    expect(calls.some((args) => args[0] === 'add')).toBe(false)
  })

  it('adds a file, deletes a missing file and commits shallow explicit targets', async () => {
    const { manager, scope, calls, lists } = fixture()
    const a = resolve(scope, 'a@b.txt')
    const b = resolve(scope, 'deleted.txt')
    expect(await manager.commit(scope, [
      { absolutePath: a, nodeKind: 'file', status: 'untracked' },
      { absolutePath: b, nodeKind: 'file', status: 'missing' },
    ], 'message.txt')).toEqual({ ok: true, value: { revision: '42', output: 'Committed revision 42.\n', committedPaths: [] } })
    expect(calls[0]).toEqual(['info', '--xml', '--non-interactive', '--', `${scope}@`])
    expect(calls[1]).toEqual(['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${a}@`])
    expect(calls[2]).toEqual(['delete', '--non-interactive', '--', `${b}@`])
    expect(calls[3]).toEqual(['commit', '--non-interactive', '--encoding', 'UTF-8', '--file', 'message.txt', '--targets', expect.any(String), '--depth', 'empty'])
    expect(lists).toEqual([`${a}@\n${b}@\n`])
    await expect(readFile(calls[3][7], 'utf8')).rejects.toThrow()
  })

  it('adds a selected directory at depth empty without discovering or staging its children', async () => {
    const { manager, scope, calls, lists } = fixture()
    const directory = resolve(scope, 'new')
    expect(await manager.commit(scope, [{ absolutePath: directory, nodeKind: 'directory', status: 'untracked' }], 'message.txt')).toMatchObject({ ok: true })
    expect(calls[1]).toEqual(['add', '--parents', '--depth', 'empty', '--non-interactive', '--', `${directory}@`])
    expect(lists[0]).toBe(`${directory}@\n`)
    expect(calls).toHaveLength(3)
  })

  it('commits the parent directories the add versions, asking about each one once', async () => {
    const scope = testScope
    const { manager, calls, lists } = schedules(scope, new Map([[scope, 'normal']]))
    const one = resolve(scope, 'a', 'b', 'one.txt')
    const two = resolve(scope, 'a', 'b', 'two.txt')
    expect(await manager.commit(scope, [
      { absolutePath: one, nodeKind: 'file', status: 'untracked' },
      { absolutePath: two, nodeKind: 'file', status: 'untracked' },
    ], 'message.txt')).toMatchObject({ ok: true })
    // Without the parents the commit stops at E200009: SVN refuses a child whose parent add it
    // does not have. The second target asks nothing, the first answer already covers its chain.
    expect(lists).toEqual([`${resolve(scope, 'a')}@\n${resolve(scope, 'a', 'b')}@\n${one}@\n${two}@\n`])
    expect(calls.filter(([command]) => command === 'info').map(([, , , , path]) => path)).toEqual([
      `${resolve(scope, 'a', 'b')}@`, `${resolve(scope, 'a')}@`, `${scope}@`,
    ])
  })

  it('commits new nested directories with their selected files and leaves an unselected sibling out (Jamat#35)', async () => {
    const scope = testScope
    const { manager, calls, lists } = schedules(scope, new Map([[scope, 'normal']]))
    const engines = resolve(scope, 'engines')
    const run = resolve(engines, 'run')
    const files = ['00-run.md', '01-run.md'].map((name) => resolve(run, name))
    expect(await manager.commit(scope, [
      ...files.map((absolutePath) => ({ absolutePath, nodeKind: 'file' as const, status: 'untracked' as const })),
      { absolutePath: run, nodeKind: 'directory', status: 'untracked' },
      { absolutePath: engines, nodeKind: 'directory', status: 'untracked' },
    ], 'message.txt')).toMatchObject({ ok: true })
    expect(calls.filter(([command]) => command === 'add')).toHaveLength(1)
    expect(calls.filter(([command]) => command === 'add').flatMap((args) => args.slice(args.indexOf('--') + 1)))
      .toEqual([engines, run, ...files].map((path) => `${path}@`))
    expect(lists).toEqual([[engines, run, ...files].map((path) => `${path}@\n`).join('')])
    expect(lists[0]).not.toContain('report.md')
  })

  it('refuses to add inside a directory scheduled for deletion, before any write', async () => {
    const scope = testScope
    const deleted = resolve(scope, 'data')
    const { manager, calls } = schedules(scope, new Map([[scope, 'normal'], [deleted, 'delete']]))
    const kept = resolve(deleted, 'run.json')
    expect(await manager.commit(scope, [{ absolutePath: kept, nodeKind: 'file', status: 'untracked' }], 'message.txt'))
      .toEqual({ ok: false, code: 'svn-failed', detail: expect.stringContaining(`${deleted} is scheduled for deletion`) })
    expect(calls.map(([command]) => command)).toEqual(['info'])
  })

  it.each(['added', 'replaced', 'copied'] as const)('includes scheduled parents of a %s selected file without publishing its siblings', async (status) => {
    const scope = testScope
    const parent = resolve(scope, 'a')
    const nested = resolve(parent, 'b')
    const selected = resolve(nested, 'one.txt')
    const { manager, calls, lists } = schedules(scope, new Map([[scope, 'normal'], [parent, 'add'], [nested, 'replace']]))
    expect(await manager.commit(scope, [{ absolutePath: selected, nodeKind: 'file', status }], 'message.txt')).toMatchObject({ ok: true })
    expect(lists).toEqual([[parent, nested, selected].map((path) => `${path}@\n`).join('')])
    expect(lists[0]).not.toContain('two.txt')
    expect(calls.filter(([command]) => command === 'add')).toEqual([])
    expect(calls.find(([command]) => command === 'commit')).toEqual(expect.arrayContaining(['--depth', 'empty']))
  })

  /** A file moved out of `old/` before `old/` itself was deleted, the way a refactor leaves it. */
  function deletedDirectory(files: readonly string[]) {
    const scope = testScope
    const directory = resolve(scope, 'old')
    const calls: string[][] = []
    const lists: string[] = []
    const manager = cleanManager({ run: async (_cwd, args) => {
      calls.push(args)
      const path = args[args.length - 1].slice(0, -1)
      if (args[0] === 'info' && args.includes('infinity'))
        return { code: 0, failure: null, stderr: '', stdout: `<info><entry kind="dir" path="old"><wc-info><schedule>delete</schedule></wc-info></entry>${
          files.map((file) => `<entry kind="file" path="old/${file}"><wc-info><schedule>delete</schedule></wc-info></entry>`).join('')}</info>` }
      if (args[0] === 'info') return { code: 0, failure: null, stderr: '',
        stdout: `<info><entry kind="dir"><wc-info><schedule>${path === directory ? 'delete' : 'normal'}</schedule></wc-info></entry></info>` }
      if (args[0] === 'commit') lists.push(await readFile(args[args.indexOf('--targets') + 1], 'utf8'))
      return { code: 0, failure: null, stderr: '', stdout: 'Adding         new.tsx\nDeleting       old\nCommitted revision 42.\n' }
    } })
    const targets = [
      { absolutePath: resolve(scope, 'new.tsx'), nodeKind: 'file' as const, status: 'added' as const },
      { absolutePath: resolve(directory, 'moved.tsx'), nodeKind: 'file' as const, status: 'deleted' as const },
    ]
    return { manager, scope, directory, calls, lists, targets }
  }

  it('commits the deleted directory a selected deletion lives in, so a move out of it is not refused', async () => {
    const { manager, scope, directory, lists, targets } = deletedDirectory(['moved.tsx'])
    // Without `old` SVN stops with E200009: the move source is the deleted directory, not the file.
    expect(await manager.commit(scope, targets, 'message.txt')).toMatchObject({ ok: true, value: {
      committedPaths: [resolve(scope, 'new.tsx'), directory, resolve(directory, 'moved.tsx')],
    } })
    expect(lists).toEqual([`${resolve(scope, 'new.tsx')}@\n${resolve(directory, 'moved.tsx')}@\n${directory}@\n`])
  })

  it('refuses a directory deletion that would publish files the selection left out, before any write', async () => {
    const { manager, scope, directory, calls, targets } = deletedDirectory(['moved.tsx', 'kept.tsx'])
    expect(await manager.commit(scope, targets, 'message.txt')).toEqual({ ok: false, code: 'svn-failed',
      detail: expect.stringContaining(`deleted together with ${directory}, and SVN publishes that deletion only as the whole directory, which also deletes:\n${resolve(directory, 'kept.tsx')}\n`) })
    expect(calls.map(([command]) => command)).toEqual(['info', 'info', 'info'])
  })

  it('stages a path an earlier attempt already versioned, so the retry of that selection commits', async () => {
    const scope = testScope
    const path = resolve(scope, 'already.txt')
    const calls: string[][] = []
    const lists: string[] = []
    const manager = cleanManager({ run: async (_cwd, args) => {
      calls.push(args)
      if (args[0] === 'add') return { code: 1, failure: null, stdout: '',
        stderr: `svn: warning: W150002: '${path}' is already under version control\nsvn: E200009: Could not add all targets because some targets are already versioned` }
      if (args[0] === 'info') return { code: 0, failure: null, stderr: '',
        stdout: `<info><entry kind="file" path="${path}"><wc-info><schedule>${args[5] === `${path}@` ? 'add' : 'normal'}</schedule></wc-info></entry></info>` }
      lists.push(await readFile(args[args.indexOf('--targets') + 1], 'utf8'))
      return { code: 0, failure: null, stderr: '', stdout: 'Committed revision 42.\n' }
    } })
    expect(await manager.commit(scope, [{ absolutePath: path, nodeKind: 'file', status: 'untracked' }], 'message.txt'))
      .toMatchObject({ ok: true, value: { revision: '42' } })
    expect(calls[2]).toEqual(['info', '--xml', '--non-interactive', '--', `${path}@`])
    expect(lists).toEqual([`${path}@\n`])
  })

  it('retains every scheduled addition in undo evidence after a partly completed batch is retried', async () => {
    const paths = ['already.txt', 'new.tsx'].map((name) => resolve(testScope, name))
    let adding = false
    const manager = cleanManager({ run: async (_cwd, args) => {
      if (args[0] === 'add') {
        adding = true
        expect(args.slice(args.indexOf('--') + 1)).toEqual(paths.map((path) => `${path}@`).sort((a, b) => a.length - b.length))
        return { code: 1, failure: null, stdout: 'A new.tsx', stderr: 'svn: E200009: Some targets are already versioned' }
      }
      return { code: 0, failure: null, stderr: '', stdout: `<info><entry><wc-info><schedule>${adding ? 'add' : 'normal'}</schedule></wc-info></entry></info>` }
    } })
    const journal: string[][] = []
    const result = await manager.prepare(testScope, paths.map((absolutePath) => ({ absolutePath, nodeKind: 'file', status: 'untracked' })),
      undefined, async (added) => { expect(adding).toBe(false); journal.push(added) })
    expect(result).toMatchObject({ ok: true, value: { added: expect.arrayContaining(paths) } })
    expect(journal).toEqual([expect.arrayContaining(paths)])
  })

  it('asks about the target itself and reports an add failure the path does not explain', async () => {
    const scope = testScope
    const path = resolve(scope, 'blocked.txt')
    const calls: string[][] = []
    const manager = cleanManager({ run: async (_cwd, args) => {
      calls.push(args)
      if (args[0] === 'info' && args[5] === `${scope}@`) return { code: 0, failure: null, stderr: '',
        stdout: '<info><entry kind="dir"><wc-info><schedule>normal</schedule></wc-info></entry></info>' }
      return args[0] === 'info'
        ? { code: 1, failure: null, stdout: '<info>\n</info>', stderr: `svn: warning: W155010: The node '${path}' was not found.` }
        : { code: 1, failure: null, stdout: '', stderr: 'svn: E155004: Working copy locked' }
    } })
    expect(await manager.commit(scope, [{ absolutePath: path, nodeKind: 'file', status: 'untracked' }], 'message.txt'))
      .toMatchObject({ ok: false, code: 'locked' })
    expect(calls.map(([command]) => command)).toEqual(['info', 'add', 'info'])
  })

  it('reports staging and streamed SVN progress while the command is still running', async () => {
    const scope = testScope
    const events: CommitProgress[] = []
    const manager = cleanManager({ run: async (_cwd, args, options) => {
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

  it('refuses a name svn cannot take from Jamat before any write, and says what to do', async () => {
    const { manager, scope, calls } = fixture()
    const answer = await manager.commit(scope, [{ absolutePath: resolve(scope, 'docs/žluť.md'), nodeKind: 'file', status: 'added' }], 'message.txt')
    expect(answer).toMatchObject({ ok: false, code: 'refused' })
    expect(answer.ok === false && answer.detail).toContain('docs/žluť.md')
    expect(answer.ok === false && answer.detail).toContain('TortoiseSVN')
    expect(calls).toEqual([])
  })

  it.each(['E155011', 'E160028', 'E170004'])('recognizes the SVN %s out-of-date code', async (code) => {
    const { manager, scope } = fixture(`${code}: commit refused`)
    expect(await manager.commit(scope, [{ absolutePath: resolve(scope, 'a.txt'), nodeKind: 'file', status: 'modified' }], 'message.txt')).toMatchObject({ ok: false, code: 'out-of-date' })
  })

  it.each([
    ['text', '<target path="scope"><entry path="text.txt"><wc-status item="conflicted" props="none" /></entry></target>', 'text.txt'],
    ['properties', '<target path="scope"><entry path="folder"><wc-status item="normal" props="conflicted" /></entry></target>', 'folder'],
    ['tree', '<target path="scope"><entry path="deleted"><wc-status item="deleted" props="none" tree-conflicted="true" /></entry></target>', 'deleted'],
    ['changelist', '<target path="scope"/><changelist name="review"><entry path="grouped.txt"><wc-status item="conflicted" props="none" /></entry></changelist>', 'grouped.txt'],
    ['clean', '<target path="scope"/>', null],
  ])('checks %s conflicts after updating the node SVN named, at depth empty and without externals', async (_kind, xml, conflict) => {
    const scope = resolve('scope@with spaces')
    const named = resolve(scope, 'app', 'blocks')
    const calls: string[][] = []
    const manager = cleanManager({ run: async (cwd, args) => {
      expect(cwd).toBe(scope)
      calls.push(args)
      return { code: 0, failure: null, stderr: '', stdout: args[0] === 'update' ? 'Updated to revision 43.\n'
        : args.includes('--show-updates') ? '<status><target path="scope"/></status>' : `<status>${xml}</status>` }
    } })
    const result = await manager.updateOutOfDate(scope, `svn: E155011: Commit failed (details follow):\nsvn: E155011: Directory '${named}' is out of date\nsvn: E160028: Directory '/app/blocks' is out of date`, [named])
    expect(calls).toEqual([
      ['status', '--xml', '--show-updates', '--non-interactive', '--ignore-externals', '--', `${named}@`],
      ['update', '--non-interactive', '--accept', 'postpone', '--ignore-externals', '--depth', 'empty', '--', `${named}@`],
      ['status', '--xml', '--non-interactive', '--ignore-externals', '--depth', 'empty', '--', `${named}@`],
    ])
    if (conflict === null) expect(result).toEqual({ ok: true, value: { output: 'Updated to revision 43.\n' } })
    else expect(result).toMatchObject({ ok: false, detail: expect.stringContaining(conflict) })
  })

  it('reports update stdout and stderr and stops after a failed update', async () => {
    const calls: string[][] = []
    const manager = cleanManager({ run: async (_cwd, args) => {
      calls.push(args)
      return args[0] === 'status' ? { code: 0, failure: null, stderr: '', stdout: '<status><target path="."/></status>' }
        : { code: 1, failure: null, stdout: 'C    conflict.txt\n', stderr: 'E170013: Connection refused' }
    } })
    expect(await manager.updateOutOfDate(testScope, `svn: E155011: File '${resolve(testScope, 'a.txt')}' is out of date`, []))
      .toEqual({ ok: false, code: 'svn-failed', detail: 'C    conflict.txt\nE170013: Connection refused' })
    expect(calls.map(([command]) => command)).toEqual(['status', 'update'])
  })

  it.each(['status-error', 'invalid-status'])('never reports a clean update after %s', async (kind) => {
    const manager = cleanManager({ run: async (_cwd, args) => args[0] === 'update'
      ? { code: 0, failure: null, stdout: 'Updated to revision 43.', stderr: '' }
      : args.includes('--show-updates') ? { code: 0, failure: null, stdout: '<status><target path="."/></status>', stderr: '' }
      : { code: kind === 'status-error' ? 1 : 0, failure: null, stdout: 'invalid status', stderr: '' } })
    expect(await manager.updateOutOfDate(testScope, `svn: E155011: File '${resolve(testScope, 'a.txt')}' is out of date`, []))
      .toMatchObject({ ok: false, detail: expect.stringContaining('Updated to revision 43.') })
  })

  /** The B1 review: files moved out of `blocks/` one by one, then `blocks` deleted, its BASE older than its files' commits. */
  function outOfDate(status: string, selected: readonly string[] = []) {
    const calls: string[][] = []
    const manager = cleanManager({ run: async (_cwd, args) => {
      calls.push(args)
      if (args[0] === 'info') return { code: 0, failure: null, stderr: '', stdout: '<info><entry><relative-url>^/trunk/My%20App</relative-url></entry></info>' }
      if (args.includes('--show-updates')) return { code: 0, failure: null, stderr: '', stdout: `<status><target path="blocks">${status}</target></status>` }
      if (args[0] === 'status') return { code: 0, failure: null, stderr: '', stdout: '<status><target path="."/></status>' }
      return { code: 0, failure: null, stderr: '', stdout: 'Updating \'blocks\':\nAt revision 286.\n' }
    } })
    const update = (failure: string) => manager.updateOutOfDate(testScope, failure, selected)
    return { calls, update }
  }

  const deletedBlocks = (incoming: string) => '<entry path="blocks"><wc-status item="deleted" props="none"/></entry>'
    + `<entry path="blocks/a.ts"><wc-status item="deleted" props="none" moved-to="../nodeTypes/a.ts"/>${incoming}</entry>`

  it('updates only the deleted directory SVN named when nothing came in below it, never a moved file (audit B1)', async () => {
    const { calls, update } = outOfDate(deletedBlocks(''))
    expect(await update(`svn: E155011: Directory '${resolve(testScope, 'blocks')}' is out of date`)).toMatchObject({ ok: true })
    expect(calls.filter(([command]) => command === 'update')).toEqual([
      ['update', '--non-interactive', '--accept', 'postpone', '--ignore-externals', '--depth', 'empty', '--', `${resolve(testScope, 'blocks')}@`]])
  })

  it('places a repository path SVN named through the scope URL when no working-copy path is given', async () => {
    const { calls, update } = outOfDate(deletedBlocks(''))
    expect(await update('svn: E170004: Item \'/trunk/My App/blocks\' is out of date')).toMatchObject({ ok: true })
    expect(calls[0]).toEqual(['info', '--xml', '--non-interactive', '--', `${testScope}@`])
    expect(calls.find(([command]) => command === 'update')?.at(-1)).toBe(`${resolve(testScope, 'blocks')}@`)
    expect(await update('svn: E160028: Directory \'/trunk/Other/blocks\' is out of date'))
      .toMatchObject({ ok: false, code: 'refused', detail: expect.stringContaining('/trunk/Other/blocks') })
  })

  it.each([
    ['an incoming change below a deleted directory', deletedBlocks('<repos-status item="modified" props="none"/>'), 'blocks/a.ts'],
    ['a moved node', '<entry path="blocks"><wc-status item="deleted" props="none" moved-to="../nodeTypes"/><repos-status item="modified" props="none"/></entry>', 'together with nodeTypes'],
    ['a change coming into work the commit does not hold', '<entry path="blocks"><wc-status item="normal" props="modified"/><repos-status item="none" props="modified"/></entry>', 'does not hold'],
  ])('refuses %s before any write and names what to update', async (_kind, status, named) => {
    const { calls, update } = outOfDate(status)
    const result = await update(`svn: E155011: Directory '${resolve(testScope, 'blocks')}' is out of date`)
    expect(result).toMatchObject({ ok: false, code: 'refused', detail: expect.stringContaining(named) })
    expect(result).toMatchObject({ detail: expect.stringContaining('Update blocks') })
    expect(calls.map(([command]) => command)).toEqual(['status'])
  })

  it('refuses a failure that names no path instead of guessing an update', async () => {
    const { calls, update } = outOfDate('')
    expect(await update('svn: E160024: resource out of date; try updating')).toMatchObject({ ok: false, code: 'refused' })
    expect(calls).toEqual([])
  })

  it.each([
    ['destination', ['nodeTypes/a.ts'], 'select blocks/a.ts as well'],
    ['source', ['blocks/a.ts'], 'select nodeTypes/a.ts as well'],
  ])('names the other side of a move whose %s alone is selected, before staging', async (_side, chosen, problem) => {
    await mkdir(resolve(testScope, 'nodeTypes'))
    await writeFile(resolve(testScope, 'nodeTypes', 'a.ts'), 'moved')
    const calls: string[][] = []
    const manager = new SvnCommitManager({ run: async (_cwd, args) => {
      calls.push(args)
      return { code: 0, failure: null, stderr: '', stdout: '<status><target path=".">'
        + '<entry path="blocks/a.ts"><wc-status item="deleted" props="none" moved-to="nodeTypes/a.ts"/></entry>'
        + '<entry path="nodeTypes/a.ts"><wc-status item="added" props="none" moved-from="blocks/a.ts"/></entry></target></status>' }
    } })
    const targets = chosen.map((path) => ({ absolutePath: resolve(testScope, path), nodeKind: 'file' as const,
      status: path.startsWith('blocks') ? 'deleted' as const : 'added' as const }))
    expect(await manager.prepare(testScope, targets)).toEqual({ ok: false, code: 'refused', detail: expect.stringContaining(problem) })
    expect(calls).toEqual([['status', '--xml', '--', '.']])
  })

  it('accepts a move whose source travels with its selected deleted directory', async () => {
    await mkdir(resolve(testScope, 'nodeTypes'))
    await writeFile(resolve(testScope, 'nodeTypes', 'a.ts'), 'moved')
    const manager = new SvnCommitManager({ run: async (_cwd, args) => ({ code: 0, failure: null, stderr: '', stdout: args[0] === 'status'
      ? '<status><target path=".">'
        + '<entry path="blocks"><wc-status item="deleted" props="none"/></entry>'
        + '<entry path="blocks/a.ts"><wc-status item="deleted" props="none" moved-to="nodeTypes/a.ts"/></entry>'
        + '<entry path="nodeTypes/a.ts"><wc-status item="added" props="none" moved-from="blocks/a.ts"/></entry></target></status>'
      : '<info><entry kind="dir"><wc-info><schedule>normal</schedule></wc-info></entry></info>' }) })
    expect(await manager.prepare(testScope, [
      { absolutePath: resolve(testScope, 'blocks'), nodeKind: 'directory', status: 'deleted' },
      { absolutePath: resolve(testScope, 'nodeTypes', 'a.ts'), nodeKind: 'file', status: 'added' },
    ])).toMatchObject({ ok: true })
  })

  it('splits a selection too long for one Windows command line into bounded svn add and delete calls (Jamat#77)', async () => {
    const additions = Array.from({ length: 400 }, (_, index) => resolve(testScope, `new-${String(index).padStart(3, '0')}-${'x'.repeat(40)}.txt`))
    const removals = additions.map((path) => path.replace('new-', 'old-'))
    for (const path of additions) await writeFile(path, 'new')
    const calls: string[][] = []
    const manager = cleanManager({ run: async (_cwd, args) => {
      calls.push(args)
      return { code: 0, failure: null, stderr: '', stdout: args[0] === 'info' ? '<info><entry kind="dir"><wc-info><schedule>normal</schedule></wc-info></entry></info>' : '' }
    } })
    expect(await manager.prepare(testScope, [
      ...additions.map((absolutePath) => ({ absolutePath, nodeKind: 'file' as const, status: 'untracked' as const })),
      ...removals.map((absolutePath) => ({ absolutePath, nodeKind: 'file' as const, status: 'missing' as const })),
    ])).toMatchObject({ ok: true })
    for (const [command, paths] of [['add', additions], ['delete', removals]] as const) {
      const writes = calls.filter(([name]) => name === command)
      expect(writes.length).toBeGreaterThan(1)
      expect(writes.every((args) => args.join(' ').length < 32_000 && !args.includes('--targets'))).toBe(true)
      expect(writes.flatMap((args) => args.slice(args.indexOf('--') + 1))).toEqual(paths.map((path) => `${path}@`))
    }
  })

  it.each([
    ['b.ts', 'item="conflicted" props="none"'],
    ['folder', 'item="normal" props="none" tree-conflicted="true"'],
    ['properties', 'item="normal" props="conflicted"'],
  ])('refuses an unselected scope conflict on %s before staging', async (path, attributes) => {
    const calls: string[][] = []
    const manager = new SvnCommitManager({ run: async (_cwd, args) => {
      calls.push(args)
      return { code: 0, failure: null, stderr: '', stdout: `<status><target path="."><entry path="${path}"><wc-status ${attributes}/></entry></target></status>` }
    } })
    expect(await manager.prepare(testScope, [{ absolutePath: resolve(testScope, 'a.txt'), status: 'untracked', nodeKind: 'file' }]))
      .toEqual({ ok: false, code: 'refused', detail: `Refused: ${path} is conflicted` })
    expect(calls).toEqual([['status', '--xml', '--', '.']])
  })

  it.each(['x.tsx.r485', 'c.ts', 'notes.r2d2', 'binary.dat'])('checks selected content and sidecar names for %s before staging', async (name) => {
    const marker = '<<<<<<< .mine\nours\n=======\ntheirs\n>>>>>>> .r5'
    await writeFile(resolve(testScope, name), name === 'binary.dat' ? `\0${marker}` : name === 'c.ts' ? marker : 'Heading\n=======')
    const calls: string[][] = []
    const manager = new SvnCommitManager({ run: async (_cwd, args) => {
      calls.push(args)
      return { code: 0, failure: null, stderr: '', stdout: args[0] === 'status' ? '<status><target path="."/></status>'
        : '<info><entry kind="dir"><wc-info><schedule>normal</schedule></wc-info></entry></info>' }
    } })
    const result = await manager.prepare(testScope, [{ absolutePath: resolve(testScope, name), status: 'untracked', nodeKind: 'file' }])
    if (name === 'x.tsx.r485' || name === 'c.ts') {
      expect(result).toMatchObject({ ok: false, code: 'refused', detail: expect.stringContaining(name) })
      expect(calls).toEqual([['status', '--xml', '--', '.']])
    }
    else if (name === 'notes.r2d2' || name === 'binary.dat') expect(result).toMatchObject({ ok: true })
    else throw new Error(`Unexpected fixture: ${name}`)
  })

  it('names a conflicted path, a leftover conflict file and a file with markers in one refusal (UA1-J05-4)', async () => {
    await writeFile(resolve(testScope, 'c.ts'), '<<<<<<< .mine\nours\n=======\ntheirs\n>>>>>>> .r5')
    await writeFile(resolve(testScope, 'take.txt.r3'), 'theirs')
    const manager = new SvnCommitManager({ run: async () => ({ code: 0, failure: null, stderr: '',
      stdout: '<status><target path="."><entry path="b.ts"><wc-status item="conflicted" props="none"/></entry></target></status>' }) })
    expect(await manager.prepare(testScope, [{ absolutePath: resolve(testScope, 'c.ts'), status: 'modified', nodeKind: 'file' },
      { absolutePath: resolve(testScope, 'take.txt.r3'), status: 'untracked', nodeKind: 'file' }]))
      .toEqual({ ok: false, code: 'refused', detail: ['Refused: b.ts is conflicted', 'Refused: take.txt.r3 is an svn conflict file',
        'Refused: c.ts contains svn conflict markers'].join('\n') })
  })

  it('fails closed when scope status or a selected text file cannot be read', async () => {
    const targets = [{ absolutePath: resolve(testScope, 'absent.ts'), status: 'modified' as const, nodeKind: 'file' as const }]
    const invalidStatus = new SvnCommitManager({ run: async () => ({ code: 0, failure: null, stderr: '', stdout: 'invalid' }) })
    expect(await invalidStatus.prepare(testScope, targets)).toMatchObject({ ok: false, code: 'svn-failed' })
    expect(await cleanManager({ run: async () => { throw new Error('must not stage') } }).prepare(testScope, targets))
      .toMatchObject({ ok: false, code: 'svn-failed' })
  })

})
