import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningCommitLimits } from '../../shared/versioningCommit'
import { VersioningCommitManager, type VersioningCommitManagerDeps } from './versioningCommitManager'

describe('app-client-ui/app/versioning/versioningCommitManager', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'jamat-commit-registry-test-'))
    roots.push(root)
    const path = join(root, 'file.txt')
    await writeFile(path, 'content')
    const stamp = Math.round((await lstat(path)).mtimeMs)
    const snapshot: FileChangesWorkingTreeSnapshot = {
      snapshotId: 'snapshot', sessionId: 'session', createdAt: 1,
      source: { requested: 'svn', selected: 'svn', available: ['svn'], fallbackReason: null },
      defaultBaseline: null, externalRoots: [], warnings: [],
      entries: [{ fileId: 'file', path, displayPath: 'file.txt', nodeKind: 'file', location: 'workspace', status: 'modified', previousPath: null, previousDisplayPath: null, modifiedAt: stamp, sources: ['vcs'], gitState: null }],
    }
    const writes: string[] = []
    const phases: string[] = []
    const settled: string[] = []
    let serial = 0
    const deps: VersioningCommitManagerDeps = {
      sessions: { workingContext: async (sessionId) => ({ ok: true, value: { sessionId, cwd: root, agent: null, worktree: null } }), settleVcs: (cwd) => { settled.push(cwd) } },
      vcsStatus: { detect: async (cwd, id) => ({ id, root, cwd, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null }) },
      checkpointStore: { worktreeBelongsToStore: async () => false },
      snapshotOf: (owner, id) => owner === 'window' && id === snapshot.snapshotId ? snapshot : null,
      fileAccess: (owner, id, fileId) => owner === 'window' && id === snapshot.snapshotId && fileId === 'file'
        ? { ok: true, value: { sessionId: 'session', cwd: root, path, nodeKind: 'file', status: 'modified', workingState: { modifiedAt: stamp, vcsEntry: true } } }
        : { ok: false, code: 'unknown-file', detail: 'unknown' },
      git: { commit: async () => { throw new Error('Unexpected Git commit') } },
      svn: { commit: async (_scope, _targets, message) => {
        phases.push(manager.read('window', draftId)?.phase.kind ?? 'absent')
        writes.push(await readFile(message, 'utf8'))
        return { ok: true, value: { revision: '42', output: 'Committed revision 42.' } }
      } },
      onChanged: () => {}, newId: () => `draft-${++serial}`,
    }
    const manager = new VersioningCommitManager(deps)
    const prepared = await manager.prepare('session', 'svn', null, 'proposal')
    if (!prepared.ok) throw new Error(prepared.detail)
    const draftId = prepared.value.draftId
    manager.attach(draftId, 'window')
    return { manager, deps, root, path, snapshot, draftId, writes, phases, settled,
      request: { draftId, snapshotId: snapshot.snapshotId, fileIds: ['file'], message: 'Reviewed\n\nPříliš' },
    }
  }

  it('shares a draft and preserves a message edited by a person', async () => {
    const f = await fixture()
    expect(f.manager.setMessage('window', f.draftId, 'human')).toBe(true)
    const again = await f.manager.prepare('session', 'svn', null, 'replacement')
    expect(again).toMatchObject({ ok: true, value: { draftId: f.draftId }, messageApplied: false })
    expect(f.manager.read('window', f.draftId)?.message).toBe('human')
    expect(f.manager.read('other', f.draftId)).toBeNull()
  })

  it('writes the running phase before committing and settles the VCS after success', async () => {
    const f = await fixture()
    expect(await f.manager.run('window', f.request)).toEqual({ ok: true, revision: '42' })
    expect(f.phases).toEqual(['running'])
    expect(f.writes).toEqual(['Reviewed\n\nPříliš\n'])
    expect(f.settled).toEqual([f.root])
    expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'done', revision: '42' })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'busy' })
  })

  it('rejects stale, vanished and reappeared files before any write', async () => {
    const f = await fixture()
    await utimes(f.path, new Date(), new Date(Date.now() + 10_000))
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'stale' })
    await rm(f.path)
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'stale' })
    f.snapshot.entries[0].status = 'missing'
    await writeFile(f.path, 'reappeared')
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'stale' })
    expect(f.writes).toEqual([])
  })

  it('refuses a rename whose old path was recreated, before staging that unintended file', async () => {
    const f = await fixture()
    const previous = join(f.root, 'old.txt')
    f.snapshot.entries[0]!.status = 'renamed'
    f.snapshot.entries[0]!.previousPath = previous
    await writeFile(previous, 'new unrelated content')
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'stale' })
    expect(f.writes).toEqual([])
  })

  it('rejects foreign owners, snapshots, external targets, empty selections and oversized messages', async () => {
    const f = await fixture()
    expect(await f.manager.run('other', f.request)).toMatchObject({ ok: false, code: 'unknown-draft' })
    expect(await f.manager.run('window', { ...f.request, snapshotId: 'other' })).toMatchObject({ ok: false, code: 'invalid-target' })
    expect(await f.manager.run('window', { ...f.request, fileIds: [] })).toMatchObject({ ok: false, code: 'no-targets' })
    expect(await f.manager.run('window', { ...f.request, message: 'x'.repeat(VersioningCommitLimits.messageMaxCharactersConst + 1) })).toMatchObject({ ok: false, code: 'message-too-long' })
    f.snapshot.externalRoots = [{ path: f.path, displayPath: 'external', fileIds: ['file'] }]
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'external-target' })
    expect(f.writes).toEqual([])
  })

  it('locks the repository across sibling dialog scopes', async () => {
    const f = await fixture()
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    f.deps.svn.commit = async () => {
      started()
      await new Promise<void>((resolve) => { finish = resolve })
      return { ok: true, value: { revision: '42', output: 'done' } }
    }
    const run = f.manager.run('window', f.request)
    await entered
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'busy' })
    finish()
    await run
  })

  it('keeps failures reviewable and releases a draft only with its last owner', async () => {
    const f = await fixture()
    f.deps.svn.commit = async () => ({ ok: false, code: 'out-of-date', detail: 'out of date' })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'vcs-failed' })
    expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'failed', detail: 'out of date' })
    f.manager.attach(f.draftId, 'second')
    f.manager.revokeOwner('window')
    expect(f.manager.openSessions().sessionIds).toEqual(['session'])
    f.manager.revokeOwner('second')
    expect(f.manager.openSessions().sessionIds).toEqual([])
  })

  it('refuses outside scope, missing VCS and checkpoint worktrees while preparing', async () => {
    const f = await fixture()
    expect(await f.manager.prepare('session', 'svn', '..', null)).toMatchObject({ ok: false, code: 'outside-session' })
    f.deps.vcsStatus.detect = async () => null
    expect(await f.manager.prepare('session', 'svn', null, null)).toMatchObject({ ok: false, code: 'no-working-copy' })
    f.deps.vcsStatus.detect = async (cwd, id) => ({ id, cwd, root: f.root, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null })
    f.deps.checkpointStore.worktreeBelongsToStore = async () => true
    await mkdir(join(f.root, 'nested'))
    expect(await f.manager.prepare('session', 'git', 'nested', null)).toMatchObject({ ok: false, code: 'store-worktree' })
  })
})
