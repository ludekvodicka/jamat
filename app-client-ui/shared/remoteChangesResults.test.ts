import { describe, expect, it } from 'vitest'
import type { FileChangeEntry, FileChangeProperties, FileDiffResult } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { RemoteChangesRequest } from '../../lib-orchestrator/remoteControl/remoteContentApi.types'
import { RemoteChangesResults } from './remoteChangesResults'

const properties: FileChangeProperties = { changes: [
  { name: 'svn:externals', before: null, after: 'file:///fixture/library library' },
  { name: 'jamat:removed', before: 'old value', after: null },
], detail: 'Values longer than 4000 characters are cut.' }
const entry: FileChangeEntry = { fileId: 'carrier', path: 'C:/fixture/carrier', displayPath: 'carrier', nodeKind: 'directory',
  location: 'workspace', status: 'modified', previousPath: null, previousDisplayPath: null, modifiedAt: 1, sources: ['vcs'], gitState: null, properties }
const baseline = { baselineId: 'base', kind: 'svn-base' as const, label: 'SVN BASE', revision: '1', createdAt: null }
const common = { snapshotId: 'snapshot', sessionId: 'session', createdAt: 1, defaultBaseline: baseline, entries: [entry], warnings: [] }
const history = { groups: [{ groupId: 'group', baseline, label: 'History', message: 'Property change', author: 'fixture', createdAt: 1, entries: [entry] }], nextCursor: null }
const working = { ...common, source: { requested: 'svn', selected: 'svn', available: ['svn'], fallbackReason: null }, externalRoots: [] }
const snapshot = { ...common, vcs: { requested: 'svn', selected: 'svn', available: ['svn'], root: 'C:/fixture', fallbackReason: null }, history }
const version = { label: 'BASE', path: entry.path, exists: true, eol: 'none' as const, finalNewline: null }
const diff: FileDiffResult = { ok: true, kind: 'text', data: { status: 'modified', completeness: 'full', current: version, baseline: version, detail: null, hunks: [], properties } }
const requests: { name: string; request: RemoteChangesRequest; value: unknown }[] = [
  { name: 'list', request: { kind: 'list', preferredVcs: 'svn' }, value: { ok: true, value: snapshot } },
  { name: 'working tree', request: { kind: 'working-tree', source: 'svn' }, value: { ok: true, value: working } },
  { name: 'scoped review', request: { kind: 'scoped', source: { kind: 'external', sessionId: 'session', path: entry.path, anchorPath: entry.path } }, value: { ok: true, value: working } },
  { name: 'history', request: { kind: 'history', snapshotId: 'snapshot', cursor: 'older' }, value: { ok: true, value: history } },
  { name: 'text diff', request: { kind: 'diff', request: { snapshotId: 'snapshot', fileId: 'carrier', baselineId: 'base' } }, value: diff },
  { name: 'binary diff', request: { kind: 'diff', request: { snapshotId: 'snapshot', fileId: 'carrier', baselineId: 'base' } },
    value: { ok: true, kind: 'binary', detail: 'Binary content', properties } satisfies FileDiffResult },
]

describe('RemoteChangesResults property changes', () => {
  it.each(requests)('accepts source properties in $name', ({ request, value }) => {
    expect(RemoteChangesResults.valid(request, value)).toBe(true)
  })

  it('preserves values and incomplete-read details in a scoped review', () => {
    expect(RemoteChangesResults.working.parse(working).entries[0]).toEqual(entry)
    const unread = { ...working, entries: [{ ...entry, properties: { changes: [], detail: 'SVN read refused' } }] }
    expect(RemoteChangesResults.working.parse(unread)).toEqual(unread)
  })

  it('retains strict validation and accepts entries from peers without property data', () => {
    const { properties: omitted, ...legacy } = entry
    expect(RemoteChangesResults.working.safeParse({ ...working, entries: [legacy] }).success).toBe(true)
    for (const invalid of [
      { ...properties, unknown: true },
      { ...properties, detail: 42 },
      { ...properties, changes: [{ name: 'svn:externals', before: null, after: false }] },
      { ...properties, changes: [{ name: 'svn:externals', before: null, after: 'value', command: 'unexpected' }] },
    ]) expect(RemoteChangesResults.working.safeParse({ ...working, entries: [{ ...entry, properties: invalid }] }).success).toBe(false)
  })
})
