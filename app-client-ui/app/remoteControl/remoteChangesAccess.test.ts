import { expect, it, vi } from 'vitest'
import type { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { RemoteContentPage } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { FileChangesAccess } from '../fileChanges/fileChangesAccess'
import { FileViewerAccess } from '../fileViewer/fileViewerAccess'
import { RemoteChangesAccess } from './remoteChangesAccess'
import { RemoteContentAccess } from './remoteContentAccess'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'

const view = { peerId: 'peer', epoch: 'epoch', viewId: 'view', viewerId: 'viewer', sessionId: 'session' }
const decode = (answer: RemoteControlStepResult<RemoteContentPage>) => {
  if (!answer.ok) throw new Error(answer.error.detail)
  return JSON.parse(Buffer.from(answer.value.base64, 'base64').toString())
}

it('shares snapshot ownership while refusing foreign views and unproved scoped roots', async () => {
  const workingTree = vi.fn(async () => ({ ok: true, value: { snapshotId: 'working', source: { selected: 'svn' }, entries: [], externalRoots: [] } }))
  const access = new FileChangesAccess({ list: async () => ({ ok: true, value: { snapshotId: 'snapshot' } }), workingTree,
    history: () => ({ ok: true, value: { groups: [], nextCursor: null } }) } as unknown as FileChangesManager, {} as FileViewer,
    { workingContext: async () => ({ ok: true, value: { cwd: 'C:/source' } }) } as unknown as SessionManager,
    { readSection: () => ({ primaryVcs: 'git' }) } as unknown as ConfigStore)
  const content = new RemoteContentAccess({ containsWorkingTree: async () => false } as unknown as FileViewerAccess, {} as FileViewer)
  const remote = new RemoteChangesAccess(access, (held, source) => content.allowsSource(held, source), (held, source) => content.admitSource(held, source))
  await remote.request(view, { kind: 'list', preferredVcs: null })
  expect(decode(await remote.request({ ...view, viewerId: 'other' }, { kind: 'history', snapshotId: 'snapshot', cursor: 'cursor' }))).toMatchObject({ code: 'snapshot-expired' })
  expect(decode(await remote.request(view, { kind: 'history', snapshotId: 'snapshot', cursor: 'cursor' }))).toMatchObject({ ok: true })
  const source = { kind: 'workspace' as const, sessionId: 'session', path: 'C:/foreign/a.txt', workingTree: { scopeRoot: 'C:/foreign', source: 'svn' as const } }
  expect(decode(await remote.request(view, { kind: 'scoped', source }))).toMatchObject({ code: 'invalid-context' })
  expect(workingTree).not.toHaveBeenCalled()
  content.admitSource(view, source)
  expect(decode(await remote.request(view, { kind: 'scoped', source }))).toMatchObject({ ok: true })
  expect(decode(await remote.request(view, { kind: 'scoped', source: { ...source, sessionId: 'foreign' } }))).toMatchObject({ code: 'invalid-context' })
  remote.release(view)
  expect(decode(await remote.request(view, { kind: 'history', snapshotId: 'snapshot', cursor: 'cursor' }))).toMatchObject({ code: 'snapshot-expired' })
})

it('bounds Unicode diff pages and binds their cursor to the source view', async () => {
  const original = { ok: true, kind: 'text', data: { hunks: [{ lines: [{ text: '🐱'.repeat(100_000) }] }] } }
  const remote = new RemoteChangesAccess({ diff: async () => original, revokeOwner: vi.fn() } as unknown as FileChangesAccess, async () => false, vi.fn())
  const first = await remote.request(view, { kind: 'diff', request: { snapshotId: 'snapshot', fileId: 'file', baselineId: 'base' } })
  if (!first.ok) throw new Error(first.error.detail)
  const parts = [Buffer.from(first.value.base64, 'base64')]
  let offset = parts[0]!.length
  expect(remote.page({ ...view, peerId: 'foreign' }, { ...first.value, offset })).toMatchObject({ ok: false })
  while (offset < first.value.totalBytes) {
    const page = remote.page(view, { ...first.value, offset })
    if (!page.ok) throw new Error(page.error.detail)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024)
    const bytes = Buffer.from(page.value.base64, 'base64')
    expect(bytes.length).toBeLessThanOrEqual(65536)
    parts.push(bytes); offset += bytes.length
  }
  expect(JSON.parse(Buffer.concat(parts).toString())).toEqual(original)
  const { peerId: _peer, ...wire } = view
  expect(RemoteSessionSchemas.viewRequest({ ...wire, requestId: 'request', operation: 'changes.request', body: { kind: 'list', preferredVcs: 'svn' } })).not.toBeNull()
  expect(RemoteSessionSchemas.viewRequest({ ...wire, requestId: 'request', operation: 'changes.request', body: { kind: 'list', sessionId: 'foreign', preferredVcs: 'svn' } })).toBeNull()
})
