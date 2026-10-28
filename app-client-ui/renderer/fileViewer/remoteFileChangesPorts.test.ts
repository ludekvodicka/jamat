import { afterEach, expect, it, vi } from 'vitest'
import type { FileChangesSnapshot, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { RemoteChangesRequest, RemoteContentCursor } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { RemoteFileChangesPorts } from './remoteFileChangesPorts'
import { RemoteFileViewerPorts } from './remoteFileViewerPorts'
import { FileChangesOpen } from './fileChangesOpen'

const target = { kind: 'remote', remoteEndpointId: 'source-peer', sessionId: 'source-session' } as const
const view = { viewId: 'view', viewerId: 'viewer', epoch: 'epoch', sessionId: target.sessionId }
const baseline = { baselineId: 'base', kind: 'git-head' as const, label: 'Source baseline', revision: 'HEAD', createdAt: null }
const entry = { fileId: 'file', path: 'C:/same/new.txt', displayPath: 'new.txt', nodeKind: 'file' as const, location: 'external' as const,
  status: 'renamed' as const, previousPath: 'C:/same/old.txt', previousDisplayPath: 'old.txt', modifiedAt: 1, sources: ['vcs' as const], gitState: null }
const common = { snapshotId: 'snapshot', sessionId: target.sessionId, createdAt: 1, defaultBaseline: baseline, entries: [entry], warnings: [] }
const snapshot: FileChangesSnapshot = { ...common, vcs: { requested: 'git', selected: 'git', available: ['git', 'svn'], root: 'C:/same', fallbackReason: null },
  history: { groups: [{ groupId: 'group', baseline, label: 'History', message: '🐱'.repeat(30_000), author: 'Source', createdAt: 1, entries: [entry] }], nextCursor: 'older' } }
const working: FileChangesWorkingTreeSnapshot = { ...common, source: { requested: 'checkpoint', selected: 'checkpoint', available: ['checkpoint', 'svn', 'git'], fallbackReason: null },
  externalRoots: [{ path: 'C:/same/external', displayPath: 'external', fileIds: ['file'] }] }
const document = { documentId: 'document', documentKey: 'key', source: { kind: 'external' as const, sessionId: target.sessionId, path: entry.path, anchorPath: entry.path },
  path: entry.path, name: 'new.txt', size: 1, contentVersion: 'version', kind: { kind: 'text' as const }, modes: ['raw' as const, 'diff' as const] }

function fixture() {
  const local = vi.fn(() => { throw new Error('Local owner must remain untouched') })
  vi.stubGlobal('appClient', { fileChanges: { list: local, diff: local, openFile: local }, fileViewer: { restore: local } })
  const values = new Map<string, Uint8Array>()
  const page = (cursor: RemoteContentCursor) => {
    const bytes = values.get(cursor.transferId)!
    const chunk = bytes.slice(cursor.offset, cursor.offset + 65536)
    return { ok: true as const, value: { ok: true as const, value: { ...cursor, totalBytes: bytes.length, base64: btoa(String.fromCharCode(...chunk)) } } }
  }
  const result = vi.fn((request: RemoteChangesRequest): unknown => {
    if (request.kind === 'list') return { ok: true, value: snapshot }
    else if (request.kind === 'working-tree' || request.kind === 'scoped') return { ok: true, value: working }
    else if (request.kind === 'history') return { ok: true, value: { groups: snapshot.history.groups, nextCursor: null } }
    else if (request.kind === 'diff') return { ok: true, kind: 'binary', detail: 'Source binary' }
    else if (request.kind === 'open') return { ok: true, value: document }
    else throw new Error('Unexpected request')
  })
  const requestChanges = vi.fn(async (_endpoint: string, _view: string, request: RemoteChangesRequest) => {
    const transferId = String(values.size)
    values.set(transferId, new TextEncoder().encode(JSON.stringify(result(request))))
    return page({ transferId, version: 'version', offset: 0 })
  })
  const readChangesPage = vi.fn(async (_endpoint: string, _view: string, cursor: RemoteContentCursor) => page(cursor))
  const open = vi.fn(async () => view)
  const files = new RemoteFileViewerPorts(target, open, {} as AppClientUiBridge['remote'], vi.fn())
  const ports = new RemoteFileChangesPorts(target, open, { requestChanges, readChangesPage }, (value) => files.adoptDocument(value))
  return { ports, local, requestChanges, readChangesPage, result, open }
}

afterEach(() => vi.unstubAllGlobals())

it('preserves source rename, external, SVN/Git/checkpoint and Unicode history semantics', async () => {
  const f = fixture()
  expect(await f.ports.changes.list(target.sessionId, 'git')).toEqual({ ok: true, value: { ok: true, value: snapshot } })
  expect(f.readChangesPage).toHaveBeenCalled()
  for (const source of ['svn', 'git', 'checkpoint'] as const) {
    f.result.mockReturnValueOnce({ ok: true, value: { ...working, source: { ...working.source, requested: source, selected: source } } })
    expect(await f.ports.changes.workingTree(target.sessionId, source)).toMatchObject({ value: { value: { source: { selected: source }, externalRoots: working.externalRoots } } })
  }
  expect(await f.ports.changes.history('snapshot', 'older')).toMatchObject({ value: { value: { nextCursor: null } } })
  expect(await f.ports.changes.diff({ snapshotId: 'snapshot', fileId: 'file', baselineId: 'base' })).toMatchObject({ value: { kind: 'binary', detail: 'Source binary' } })
  expect(await f.ports.changes.openFile('snapshot', 'file')).toMatchObject({ value: { value: { documentKey: expect.stringContaining('source-peer'), source: document.source } } })
  expect(await f.ports.changes.list('foreign', null)).toMatchObject({ ok: false })
  expect(f.requestChanges.mock.calls.every(([endpoint, viewId]) => endpoint === target.remoteEndpointId && viewId === view.viewId)).toBe(true)
  expect(f.local).not.toHaveBeenCalled()
})

it('renews an expired source snapshot before opening the matching file and keeps its baseline hint', async () => {
  const f = fixture()
  f.result.mockReturnValueOnce({ ok: false, code: 'snapshot-expired', detail: 'expired' })
  const fresh = { ...working, snapshotId: 'fresh', entries: [{ ...entry, fileId: 'fresh-file' }] }
  const opened = await FileChangesOpen.read({ snapshot: working, entry, baselineHint: { kind: baseline.kind, revision: baseline.revision, workingTreeSource: 'checkpoint' },
    openFile: f.ports.changes.openFile, refresh: async () => fresh, isCurrent: () => true })
  expect(opened.answer).toMatchObject({ value: { ok: true } })
  expect(opened.baselineHint).toEqual({ kind: 'git-head', revision: 'HEAD', workingTreeSource: 'checkpoint' })
  expect(f.requestChanges.mock.calls.map((call) => call[2])).toEqual([{ kind: 'open', snapshotId: 'snapshot', fileId: 'file' }, { kind: 'open', snapshotId: 'fresh', fileId: 'fresh-file' }])
  expect(f.local).not.toHaveBeenCalled()
})

it('refuses malformed or foreign snapshots and never reopens retired ports', async () => {
  const f = fixture()
  f.result.mockReturnValueOnce({ ok: true, value: { snapshotId: 'bad' } })
  expect(await f.ports.changes.list(target.sessionId, null)).toMatchObject({ ok: false, error: 'Malformed remote changes response' })
  f.result.mockReturnValueOnce({ ok: true, value: { ...snapshot, sessionId: 'foreign' } })
  expect(await f.ports.changes.list(target.sessionId, null)).toMatchObject({ ok: false, error: 'Changes belong to another session' })
  const pending = f.ports.changes.list(target.sessionId, null)
  f.ports.clear()
  expect(await pending).toMatchObject({ ok: false, error: 'Remote changes view closed' })
  const before = f.open.mock.calls.length
  expect(await f.ports.changes.list(target.sessionId, null)).toMatchObject({ ok: false })
  expect(f.open).toHaveBeenCalledTimes(before)
})
