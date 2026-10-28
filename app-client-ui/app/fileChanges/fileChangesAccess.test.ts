import { expect, it, vi } from 'vitest'
import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileChangesSnapshotResult, FileChangesWorkingTreeSnapshotResult, FileDiffResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { FileChangesAccess } from './fileChangesAccess'

it('does not coalesce commit reads with different explicit paths', async () => {
  let finish!: () => void
  const pending = new Promise<void>((done) => { finish = done })
  const workingTree = vi.fn<FileChangesManager['workingTree']>(async () => {
    await pending
    return { ok: false as const, code: 'invalid-context' as const, detail: 'test read ended' }
  })
  const access = new FileChangesAccess({ workingTree } as unknown as FileChangesManager, {} as FileViewer,
    { workingContext: async () => ({ ok: true, value: { cwd: 'C:/source', sessionId: 'session' } }) } as unknown as SessionManager,
    {} as ConfigStore)
  const first = access.workingTree('one', 'session', 'svn', 'C:/source', true, undefined, ['C:/source/first'])
  const same = access.workingTree('two', 'session', 'svn', 'C:/source', true, undefined, ['C:/source/first'])
  const other = access.workingTree('two', 'session', 'svn', 'C:/source', true, undefined, ['C:/source/second'])
  await vi.waitFor(() => expect(workingTree).toHaveBeenCalledTimes(2))
  expect(workingTree.mock.calls.map((call) => call[4])).toEqual([['C:/source/first'], ['C:/source/second']])
  finish()
  await Promise.all([first, same, other])
})

it.each(['list', 'workingTree'] as const)('does not restore a revoked owner after a coalesced pending %s', async (method) => {
  let finish!: (result: FileChangesSnapshotResult & FileChangesWorkingTreeSnapshotResult) => void
  const pending = new Promise<FileChangesSnapshotResult & FileChangesWorkingTreeSnapshotResult>((resolve) => { finish = resolve })
  const run = vi.fn(() => pending)
  const manager = { [method]: run, history: () => ({ ok: true, value: { groups: [], nextCursor: null } }) } as unknown as FileChangesManager
  const access = new FileChangesAccess(manager, {} as FileViewer,
    { workingContext: async () => ({ ok: true, value: { cwd: 'C:/source', sessionId: 'session' } }) } as unknown as SessionManager,
    { readSection: () => ({ primaryVcs: 'git' }) } as unknown as ConfigStore)
  const first = access[method]('one', 'session', null)
  const second = access[method]('two', 'session', null)
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  access.revokeOwner('one')
  finish({ ok: true, value: { snapshotId: 'snapshot' } } as FileChangesSnapshotResult & FileChangesWorkingTreeSnapshotResult)
  expect(await first).toMatchObject({ ok: false, code: 'invalid-context' })
  expect(await second).toMatchObject({ ok: true })
  expect(access.history('one', 'snapshot', 'cursor')).toMatchObject({ code: 'snapshot-expired' })
  expect(access.history('two', 'snapshot', 'cursor')).toMatchObject({ ok: true })
})

it('keeps a shared diff alive and publishes only to its remaining owner', async () => {
  let finish!: (result: FileDiffResult) => void
  let signal!: AbortSignal
  const diff = vi.fn((_request, context) => { signal = context.signal; return new Promise<FileDiffResult>((resolve) => { finish = resolve }) })
  const access = new FileChangesAccess({ list: async () => ({ ok: true, value: { snapshotId: 'snapshot' } }), diff } as unknown as FileChangesManager,
    {} as FileViewer, { workingContext: async () => ({ ok: true, value: { cwd: 'C:/source' } }) } as unknown as SessionManager,
    { readSection: () => ({ primaryVcs: 'git' }) } as unknown as ConfigStore)
  await Promise.all([access.list('one', 'session', null), access.list('two', 'session', null)])
  const request = { snapshotId: 'snapshot', fileId: 'file', baselineId: 'base' }
  const first = access.diff('one', request)
  const second = access.diff('two', request)
  access.revokeOwner('one')
  expect(signal.aborted).toBe(false)
  expect(diff).toHaveBeenCalledTimes(1)
  finish({ ok: true, kind: 'binary', detail: 'source bytes' })
  expect(await first).toMatchObject({ code: 'snapshot-expired' })
  expect(await second).toEqual({ ok: true, kind: 'binary', detail: 'source bytes' })
})


it('marks only current matching setup files and rereads origins after a worker edit', async () => {
  let setup = ['Q:/work/lock']
  const setupPaths = vi.fn(async () => ({ ok: true, value: setup }))
  const access = new FileChangesAccess({ workingTree: async () => ({ ok: true, value: { snapshotId: 'setup-snapshot', source: { selected: 'svn' },
    entries: [{ path: 'Q:/work/lock', nodeKind: 'file' }, { path: 'Q:/work/new', nodeKind: 'file' }, { path: 'Q:/work/dir', nodeKind: 'directory' }] } }) } as unknown as FileChangesManager,
    {} as FileViewer, { workingContext: async () => ({ ok: true, value: { cwd: 'Q:/work', worktree: { kind: 'svn' } } }), setupPaths } as unknown as SessionManager,
    {} as ConfigStore)
  const first = await access.workingTree('owner', 'session', 'svn', undefined, true)
  expect(first.ok && first.value.entries.map((entry) => entry.origin)).toEqual(['setup', undefined, undefined])
  expect(setupPaths).toHaveBeenCalledWith('session', ['Q:/work/lock', 'Q:/work/new'])
  setup = []
  const next = await access.workingTree('owner', 'session', 'svn', undefined, true)
  expect(next.ok && next.value.entries.map((entry) => entry.origin)).toEqual([undefined, undefined, undefined])
})
