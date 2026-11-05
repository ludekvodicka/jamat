import { expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import { FileViewerAccess } from '../fileViewer/fileViewerAccess'
import { RemoteContentPages } from './remoteContentPages'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import { RemoteContentAccess } from './remoteContentAccess'

const view = { peerId: 'peer', viewId: 'view', viewerId: 'viewer', epoch: 'epoch', sessionId: 'session' }

it('binds source access and release to the complete authenticated view identity', async () => {
  const restore = vi.fn<FileViewerAccess['restore']>(async () => ({ ok: false, code: 'not-found', detail: 'fixture' }))
  const revokeOwner = vi.fn()
  const access = new RemoteContentAccess({ restore, containsWorkingTree: async () => false } as unknown as FileViewerAccess,
    { revokeOwner } as unknown as FileViewer)
  expect(await access.restore(view, { kind: 'workspace', sessionId: 'foreign', path: 'x' }, false)).toMatchObject({ code: 'invalid-source' })
  expect(restore).not.toHaveBeenCalled()
  await access.restore(view, { kind: 'workspace', sessionId: 'session', path: 'x' }, false)
  expect(restore.mock.calls[0]?.[0]).toBe(RemoteContentAccess.owner(view))
  for (const field of ['peerId', 'viewId', 'viewerId', 'epoch', 'sessionId'])
    expect(RemoteContentAccess.owner({ ...view, [field]: 'foreign' })).not.toBe(RemoteContentAccess.owner(view))
  access.release(view)
  expect(revokeOwner).toHaveBeenCalledWith(RemoteContentAccess.owner(view))
})

it('requires a source-admitted proof before restoring a foreign commit scope', async () => {
  const restore = vi.fn<FileViewerAccess['restore']>(async () => ({ ok: false, code: 'not-found', detail: 'fixture' }))
  const access = new RemoteContentAccess({ restore, containsWorkingTree: async () => false } as unknown as FileViewerAccess,
    { revokeOwner: vi.fn() } as unknown as FileViewer)
  const source = { kind: 'workspace' as const, sessionId: 'session', path: 'other/a', workingTree: { scopeRoot: 'other', source: 'svn' as const } }
  expect(await access.restore(view, source, true)).toMatchObject({ code: 'invalid-source' })
  access.admitSource(view, source)
  await access.restore(view, source, true)
  expect(restore).toHaveBeenCalledTimes(1)
  expect(await access.restore({ ...view, viewId: 'other' }, source, true)).toMatchObject({ code: 'invalid-source' })
})

it('reads source bytes at the granted version and refuses foreign, stale and invalid ranges', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-content-')))
  try {
    await writeFile(join(root, 'source.txt'), 'source only 🐱')
    const viewer = new FileViewer()
    const owner = new FileViewerAccess({ viewer, sessions: { workingContext: async () => ({ ok: true, value: { cwd: root } }) } as never,
      restoreExternal: vi.fn(), restoreDetected: vi.fn(), allowsDetected: () => false, restoreWorkingTree: vi.fn() })
    const access = new RemoteContentAccess(owner, viewer)
    const opened = await access.restore(view, { kind: 'workspace', sessionId: 'session', path: 'source.txt' }, false)
    if (!opened.ok) throw new Error('No document')
    const request = { kind: 'bytes' as const, documentId: opened.value.documentId, version: opened.value.contentVersion!, offset: 0, length: 64 }
    const read = await access.request(view, request)
    if (!read.ok) throw new Error('No bytes')
    const value = JSON.parse(Buffer.from(read.value.base64, 'base64').toString())
    expect(Buffer.from(value.value.base64, 'base64').toString()).toBe('source only 🐱')
    const foreign = await access.request({ ...view, viewId: 'foreign' }, request)
    expect(foreign.ok && JSON.parse(Buffer.from(foreign.value.base64, 'base64').toString())).toMatchObject({ code: 'wrong-owner' })
    await writeFile(join(root, 'source.txt'), 'changed')
    const changed = await access.request(view, request)
    expect(changed.ok && JSON.parse(Buffer.from(changed.value.base64, 'base64').toString())).toMatchObject({ code: 'document-changed' })
    const wireView = { viewId: view.viewId, viewerId: view.viewerId, epoch: view.epoch, sessionId: view.sessionId }
    expect(RemoteSessionSchemas.viewRequest({ ...wireView, requestId: 'id', operation: 'files.request', body: request })).not.toBeNull()
    for (const invalid of [{ offset: -1 }, { length: 65537 }, { length: 0 }])
      expect(RemoteSessionSchemas.viewRequest({ ...wireView, requestId: 'id', operation: 'files.request', body: { ...request, ...invalid } })).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('pages Unicode metadata within byte limits and refuses foreign, stale or released cursors', () => {
  const pages = new RemoteContentPages()
  const original = { entries: Array.from({ length: 4000 }, () => '🐱'.repeat(30)) }
  const first = pages.put('owner', original)
  if (!first.ok) throw new Error('No page')
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024)
  const cursor = { transferId: first.value.transferId, version: first.value.version, offset: 65536 }
  expect(pages.read('foreign', cursor)).toMatchObject({ ok: false })
  expect(pages.read('owner', { ...cursor, version: 'stale' })).toMatchObject({ ok: false })
  const parts = [Buffer.from(first.value.base64, 'base64')]
  let offset = parts[0]!.length
  while (offset < first.value.totalBytes) {
    const next = pages.read('owner', { ...cursor, offset })
    if (!next.ok) throw new Error('Missing page')
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(256 * 1024)
    const part = Buffer.from(next.value.base64, 'base64')
    parts.push(part); offset += part.length
  }
  expect(JSON.parse(Buffer.concat(parts).toString())).toEqual(original)
  const pending = pages.put('owner', original)
  if (!pending.ok) throw new Error('No pending page')
  pages.release('owner')
  expect(pages.read('owner', { ...pending.value, offset: 65536 })).toMatchObject({ ok: false })
})

it('reopens source conflict files and merger briefs after view replacement without terminal detection grants', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-conflicts-')))
  try {
    const path = join(root, 'conflicted.txt'), brief = join(root, 'brief.md')
    await writeFile(path, 'source conflict'); await writeFile(brief, '# Source merger brief')
    const viewer = new FileViewer()
    const action = { mergeBrief: brief, conflicts: { entries: [{ path: 'conflicted.txt' }] } }
    let contextAvailable = true
    const sessions = { snapshot: () => ({ sessions: [{ sessionId: 'session', svnAction: action }] }),
      workingContext: async () => contextAvailable
        ? { ok: true, value: { cwd: root, worktree: { worktreePath: root } } }
        : { ok: false, detail: 'Source worktree removed' } }
    const restoreDetected = vi.fn(async () => ({ ok: false as const, code: 'not-found' as const, detail: 'No terminal detection' }))
    const access = new RemoteContentAccess(new FileViewerAccess({ viewer, sessions: sessions as never,
      restoreExternal: vi.fn(), restoreDetected, allowsDetected: () => false, restoreWorkingTree: vi.fn() }), viewer, undefined, sessions as never)
    for (const request of [{ kind: 'conflict' as const, path: 'conflicted.txt' }, { kind: 'merge-brief' as const }]) {
      const page = await access.request(view, request)
      if (!page.ok) throw new Error(page.error.detail)
      const opened = JSON.parse(Buffer.from(page.value.base64, 'base64').toString())
      expect(opened.ok).toBe(true)
      access.release(view)
      const reopened = await access.restore({ ...view, viewId: 'replacement' }, opened.value.source, false)
      expect(reopened.ok).toBe(true)
      expect(await access.restore({ ...view, sessionId: 'other' }, opened.value.source, false)).toMatchObject({ code: 'invalid-source' })
    }
    expect(restoreDetected).not.toHaveBeenCalled()
    action.conflicts.entries = []
    contextAvailable = false
    expect(await access.restore(view, { kind: 'detected', sessionId: 'session', path }, false)).toMatchObject({ ok: false })
    const outside = await access.request(view, { kind: 'conflict', path: '../outside.txt' })
    expect(outside.ok && JSON.parse(Buffer.from(outside.value.base64, 'base64').toString())).toMatchObject({ ok: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})
