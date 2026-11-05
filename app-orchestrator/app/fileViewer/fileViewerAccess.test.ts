import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import { FileViewerAccess } from './fileViewerAccess'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jamat-access-')))
  roots.push(root)
  const viewer = new FileViewer()
  const access = new FileViewerAccess({ viewer,
    sessions: { workingContext: vi.fn(async () => ({ ok: true, value: { sessionId: 'session', cwd: root, agent: null, worktree: null } })),
      scriptLogOf: vi.fn(async () => ({ ok: true, value: { path: join(root, 'saved.log') } })) } as unknown as ConstructorParameters<typeof FileViewerAccess>[0]['sessions'],
    restoreExternal: vi.fn(), restoreDetected: vi.fn(), allowsDetected: () => false, restoreWorkingTree: vi.fn(),
  })
  return { root, viewer, access }
}

it('shares workspace, traversal and script-log proofs without trusting the saved log path', async () => {
  const { root, viewer, access } = await fixture()
  await writeFile(join(root, 'a.txt'), 'hello')
  await writeFile(join(root, 'saved.log'), 'log')
  const source = { kind: 'workspace' as const, sessionId: 'session', path: join(root, 'a.txt') }
  const local = await access.restore('local', source, false)
  const peer = await access.restore('peer', source, false)
  expect(local.ok && peer.ok && local.value.source).toEqual(peer.ok && peer.value.source)
  expect(await access.openWorkspace('peer', 'session', '../foreign.txt', false)).toMatchObject({ ok: false })
  const log = await access.restore('peer', { kind: 'scriptLog', sessionId: 'session', runId: 'run', path: '/untrusted' }, false)
  expect(log.ok && await viewer.text('peer', log.value.documentId)).toMatchObject({ text: 'log' })
  if (!peer.ok) throw new Error('Expected grant')
  expect(await viewer.text('local', peer.value.documentId)).toMatchObject({ code: 'wrong-owner' })
})

it('revalidates a replaced directory junction and keeps other owners when one releases', async () => {
  const { root, viewer, access } = await fixture()
  await mkdir(join(root, 'folder'))
  await mkdir(join(root, 'elsewhere'))
  await writeFile(join(root, 'folder', 'a.txt'), 'original')
  await writeFile(join(root, 'elsewhere', 'a.txt'), 'replaced')
  const opened = await access.openWorkspace('one', 'session', 'folder/a.txt', false)
  const other = await access.openWorkspace('two', 'session', 'folder/a.txt', false)
  if (!opened.ok || !other.ok) throw new Error('Expected grants')
  viewer.revokeOwner('one')
  expect(await viewer.text('two', other.value.documentId)).toMatchObject({ text: 'original' })
  await rename(join(root, 'folder'), join(root, 'previous'))
  await symlink(join(root, 'elsewhere'), join(root, 'folder'), 'junction')
  expect(await viewer.text('two', other.value.documentId)).toMatchObject({ code: 'outside-root' })
  expect(await viewer.readBytes('two', other.value.documentId, other.value.contentVersion, 0, 10)).toMatchObject({ code: 'outside-root' })
})
