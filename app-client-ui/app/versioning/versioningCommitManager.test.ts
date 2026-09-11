import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningCommitLimits } from '../../shared/versioningCommit'
import { VersioningCommitManager, type VersioningCommitManagerDeps } from './versioningCommitManager'

describe('app-client-ui/app/versioning/versioningCommitManager', () => {
  it.each(['svn', 'git'] as const)('retains the %s result after close and gives the next review a different identity', async (vcs) => {
    const f = await fixture(vcs)
    if (vcs === 'git') f.deps.git.commit = async () => ({ ok: true, value: { hash: 'abc123', output: 'Committed' } })
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'editing', closed: false, revision: null })
    const reopened = await f.manager.prepare('session', vcs, null, 'Another proposal')
    expect(reopened).toMatchObject({ ok: true, value: { draftId: f.draftId } })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: true })
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', closed: false, revision: vcs === 'svn' ? '42' : 'abc123' })
    expect(f.manager.openSessions().sessionIds).toEqual([])
    f.manager.release(f.draftId, 'window')
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', closed: true })
    const next = await f.manager.prepare('session', vcs, null, 'Next review')
    expect(next.ok && next.value.draftId).not.toBe(f.draftId)
  })

  it('records cancellation only when the last owner closes, and expires the retained result', async () => {
    const f = await fixture()
    let now = 100
    f.deps.now = () => now
    f.manager.attach(f.draftId, 'second')
    f.manager.release(f.draftId, 'window')
    expect(f.manager.status(f.draftId)?.state).toBe('editing')
    f.manager.revokeOwner('second')
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'cancelled', closed: true, revision: null })
    now += 86_400_000
    expect(f.manager.status(f.draftId)).toBeNull()
    expect(f.manager.status('unknown')).toBeNull()
  })

  it('keeps the actual running commit result when its window closes during the write', async () => {
    const f = await fixture()
    f.deps.svn.commit = async () => {
      f.manager.revokeOwner('window')
      expect(f.manager.status(f.draftId)).toMatchObject({ state: 'running', closed: true })
      return { ok: true, value: { revision: '43', output: 'Committed' } }
    }
    await f.manager.run('window', f.request)
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', closed: true, revision: '43' })
  })

  it('retains a failed commit after closing and allows a retry while still open', async () => {
    const f = await fixture()
    f.deps.svn.commit = async () => ({ ok: false, code: 'out-of-date', detail: 'out of date' })
    await f.manager.run('window', f.request)
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'failed', closed: false, detail: 'out of date' })
    f.manager.release(f.draftId, 'window')
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'failed', closed: true, revision: null })
  })
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function fixture(vcs: 'svn' | 'git' = 'svn') {
    const root = await mkdtemp(join(tmpdir(), 'jamat-commit-registry-test-'))
    roots.push(root)
    const path = join(root, 'file.txt')
    await writeFile(path, 'content')
    const stamp = Math.round((await lstat(path)).mtimeMs)
    const snapshot: FileChangesWorkingTreeSnapshot = {
      snapshotId: 'snapshot', sessionId: 'session', createdAt: 1,
      source: { requested: vcs, selected: vcs, available: [vcs], fallbackReason: null },
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
      tortoise: { open: async () => { throw new Error('Unexpected Tortoise dialog') } },
      snapshotOf: (owner, id) => owner === 'window' && id === snapshot.snapshotId ? snapshot : null,
      fileAccess: (owner, id, fileId) => owner === 'window' && id === snapshot.snapshotId && fileId === 'file'
        ? { ok: true, value: { sessionId: 'session', cwd: root, path, nodeKind: 'file', status: 'modified', workingState: { modifiedAt: stamp, vcsEntry: true } } }
        : { ok: false, code: 'unknown-file', detail: 'unknown' },
      git: { revertFile: async () => { throw new Error('Unexpected Git revert') }, commit: async () => { throw new Error('Unexpected Git commit') } },
      svn: { revertFile: async () => { writes.push('reverted'); return { ok: true, value: undefined } }, commit: async (_scope, _targets, message) => {
        phases.push(manager.read('window', draftId)?.phase.kind ?? 'absent')
        writes.push(await readFile(message, 'utf8'))
        return { ok: true, value: { revision: '42', output: 'Committed revision 42.' } }
      } },
      onChanged: () => {}, newId: () => `draft-${++serial}`,
    }
    const manager = new VersioningCommitManager(deps)
    const prepared = await manager.prepare('session', vcs, null, 'proposal')
    if (!prepared.ok) throw new Error(prepared.detail)
    const draftId = prepared.value.draftId
    manager.attach(draftId, 'window')
    return { manager, deps, root, path, snapshot, draftId, writes, phases, settled,
      request: { draftId, snapshotId: snapshot.snapshotId, fileIds: ['file'], message: 'Reviewed\n\nPříliš' },
    }
  }

  async function addSecondFile(f: Awaited<ReturnType<typeof fixture>>) {
    const path = join(f.root, 'second.txt')
    await writeFile(path, 'second content')
    const modifiedAt = Math.round((await lstat(path)).mtimeMs)
    const entry = { ...f.snapshot.entries[0], path, fileId: 'second', displayPath: 'second.txt', modifiedAt }
    f.snapshot.entries = [...f.snapshot.entries, entry]
    const access = f.deps.fileAccess
    f.deps.fileAccess = (owner, id, fileId) => {
      const result = access(owner, id, fileId === 'second' ? 'file' : fileId)
      return result.ok && fileId === 'second' ? { ok: true, value: { ...result.value, path, workingState: { modifiedAt, vcsEntry: true } } } : result
    }
    return entry
  }

  it('shares a draft and preserves a message edited by a person', async () => {
    const f = await fixture()
    expect(f.manager.setMessage('window', f.draftId, 'human')).toBe(true)
    const again = await f.manager.prepare('session', 'svn', null, 'replacement')
    expect(again).toMatchObject({ ok: true, value: { draftId: f.draftId }, messageApplied: false })
    expect(f.manager.read('window', f.draftId)?.message).toBe('human')
    expect(f.manager.read('other', f.draftId)).toBeNull()
  })

  it('includes required new parents, excludes unchecked siblings and checks the selected child timestamp', async () => {
    const f = await fixture()
    const directory = join(f.root, 'new')
    await mkdir(directory)
    await writeFile(join(directory, 'chosen.txt'), 'chosen')
    await writeFile(join(directory, 'unchecked.txt'), 'unchecked')
    const entries = await Promise.all(['new', 'new/chosen.txt', 'new/unchecked.txt'].map(async (name) => {
      const path = join(f.root, name)
      return { ...f.snapshot.entries[0], fileId: name, path, displayPath: name, nodeKind: name === 'new' ? 'directory' as const : 'file' as const, status: 'untracked' as const, modifiedAt: Math.round((await lstat(path)).mtimeMs) }
    }))
    f.snapshot.entries = entries
    f.deps.fileAccess = (_owner, _snapshot, id) => {
      const entry = entries.find((candidate) => candidate.fileId === id)
      return entry === undefined ? { ok: false, code: 'unknown-file', detail: 'unknown' }
        : { ok: true, value: { sessionId: 'session', cwd: f.root, path: entry.path, nodeKind: entry.nodeKind, status: entry.status, workingState: { vcsEntry: true, modifiedAt: entry.modifiedAt } } }
    }
    const commit = vi.fn(async () => ({ ok: true as const, value: { revision: '42', output: 'committed' } }))
    f.deps.svn.commit = commit
    const request = { ...f.request, fileIds: ['new/chosen.txt'] }
    await utimes(entries[1].path, new Date(), new Date(Date.now() + 20_000))
    expect(await f.manager.run('window', request)).toMatchObject({ ok: false, code: 'stale' })
    expect(commit).not.toHaveBeenCalled()
    entries[1].modifiedAt = Math.round((await lstat(entries[1].path)).mtimeMs)
    expect(await f.manager.run('window', request)).toMatchObject({ ok: true })
    expect(commit).toHaveBeenCalledWith(f.root, [
      { absolutePath: entries[1].path, nodeKind: 'file', status: 'untracked' },
      { absolutePath: directory, nodeKind: 'directory', status: 'untracked' },
    ], expect.any(String))
  })

  it.each(['svn', 'git'] as const)('opens the owned %s scope in Tortoise and keeps the message file and lock until it closes', async (vcs) => {
    const f = await fixture(vcs)
    let close!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const closed = new Promise<void>((resolve) => { close = resolve })
    let messageFile = ''
    f.deps.tortoise.open = async (request) => {
      expect(request).toMatchObject({ vcs, scope: f.root })
      messageFile = request.messageFile!
      entered()
      return { ok: true, closed }
    }
    expect(await f.manager.openTortoise('other', f.draftId, 'message')).toMatchObject({ ok: false, code: 'unknown-draft' })
    const pending = f.manager.openTortoise('window', f.draftId, 'Příliš\n\nCurrent message')
    await started
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'running', closed: false })
    expect(await readFile(messageFile, 'utf8')).toBe('Příliš\n\nCurrent message')
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'busy' })
    close()
    expect(await pending).toEqual({ ok: true })
    expect(await lstat(messageFile).catch(() => null)).toBeNull()
    expect(f.settled).toEqual([f.root])
    expect(f.writes).toEqual([])
    expect(f.manager.read('window', f.draftId)?.phase.kind).toBe('editing')
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'external-closed', closed: false, revision: null })
  })

  it('cleans the Tortoise message file and releases the lock after a launch failure', async () => {
    const f = await fixture()
    let messageFile = ''
    f.deps.tortoise.open = async (request) => { messageFile = request.messageFile!; return { ok: false, detail: 'Not installed' } }
    expect(await f.manager.openTortoise('window', f.draftId, 'message')).toMatchObject({ ok: false, code: 'vcs-failed', detail: 'Not installed' })
    expect(await lstat(messageFile).catch(() => null)).toBeNull()
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileIds: ['file'] }, async () => false))
      .toEqual({ ok: true, reverted: false })
  })

  it('reverts only after confirmation, preserves the message and leaves the draft editable', async () => {
    const f = await fixture()
    const request = { draftId: f.draftId, snapshotId: 'snapshot', fileId: 'file' }
    const cancel = vi.fn(async () => false)
    expect(await f.manager.revert('window', request, cancel)).toEqual({ ok: true, reverted: false })
    expect(cancel).toHaveBeenCalledWith([f.path], 'svn')
    expect(f.writes).toEqual([])
    expect(await f.manager.revert('window', request, async () => true)).toEqual({ ok: true, reverted: true })
    expect(f.writes).toEqual(['reverted'])
    expect(f.settled).toEqual([f.root])
    expect(f.manager.read('window', f.draftId)).toMatchObject({ message: 'proposal', phase: { kind: 'editing' } })
  })

  it.each(['svn', 'git'] as const)('confirms the whole %s batch once and reverts only its unique selected files', async (vcs) => {
    const f = await fixture(vcs)
    const second = await addSecondFile(f)
    const writer = vi.fn(async () => ({ ok: true as const, value: undefined }))
    f.deps[vcs].revertFile = writer
    const request = { draftId: f.draftId, snapshotId: 'snapshot', fileIds: ['file', 'second', 'file'] }
    const confirm = vi.fn(async () => false)
    expect(await f.manager.revert('window', request, confirm)).toEqual({ ok: true, reverted: false })
    expect(confirm).toHaveBeenCalledExactlyOnceWith([f.path, second.path], vcs)
    expect(writer).not.toHaveBeenCalled()
    confirm.mockClear().mockResolvedValue(true)
    expect(await f.manager.revert('window', request, confirm)).toEqual({ ok: true, reverted: true })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(writer.mock.calls).toEqual([[f.root, f.path], [f.root, second.path]])
    expect(f.settled).toEqual([f.root])
    expect(f.manager.read('window', f.draftId)).toMatchObject({ message: 'proposal', phase: { kind: 'editing' } })
  })

  it('rechecks every file after the batch confirmation before writing the first file', async () => {
    const f = await fixture()
    const second = await addSecondFile(f)
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileIds: ['file', 'second'] }, async () => {
      await utimes(second.path, new Date(), new Date(Date.now() + 20_000))
      return true
    })).toMatchObject({ ok: false, code: 'stale' })
    expect(f.writes).toEqual([])
  })

  it('rejects unsupported, empty and oversized batches before confirmation or any write', async () => {
    const f = await fixture()
    const second = await addSecondFile(f)
    const confirm = vi.fn(async () => true)
    const request = { draftId: f.draftId, snapshotId: 'snapshot', fileIds: ['file', 'second'] }
    second.status = 'added'
    expect(await f.manager.revert('window', request, confirm)).toMatchObject({ ok: false, code: 'invalid-target' })
    expect(await f.manager.revert('window', { ...request, fileIds: [] }, confirm)).toMatchObject({ ok: false, code: 'no-targets' })
    expect(await f.manager.revert('window', { ...request, fileIds: Array(VersioningCommitLimits.targetsMaxConst + 1).fill('file') }, confirm)).toMatchObject({ ok: false, code: 'invalid-target' })
    expect(confirm).not.toHaveBeenCalled()
    expect(f.writes).toEqual([])
  })

  it('reports partial progress, refreshes VCS facts and releases the lock when the second writer fails', async () => {
    const f = await fixture()
    const second = await addSecondFile(f)
    f.deps.svn.revertFile = async (_scope, path) => path === second.path
      ? { ok: false, code: 'svn-failed', detail: 'File is locked' }
      : { ok: true, value: undefined }
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileIds: ['file', 'second'] }, async () => true))
      .toMatchObject({ ok: false, code: 'vcs-failed', detail: 'Reverted 1 of 2 files. second.txt: File is locked' })
    expect(f.settled).toEqual([f.root])
    expect(f.manager.read('window', f.draftId)).toMatchObject({ message: 'proposal', phase: { kind: 'editing' } })
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileIds: ['file'] }, async () => false))
      .toEqual({ ok: true, reverted: false })
  })

  it('stops a batch if the next file changes while the first is being reverted', async () => {
    const f = await fixture()
    const second = await addSecondFile(f)
    const writer = vi.fn(async () => {
      await utimes(second.path, new Date(), new Date(Date.now() + 20_000))
      return { ok: true as const, value: undefined }
    })
    f.deps.svn.revertFile = writer
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileIds: ['file', 'second'] }, async () => true))
      .toMatchObject({ ok: false, code: 'stale', detail: expect.stringContaining('Reverted 1 of 2 files.') })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('rechecks the file after confirmation and locks commits until the question is answered', async () => {
    const f = await fixture()
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileId: 'file' }, async () => {
      expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'busy' })
      await utimes(f.path, new Date(), new Date(Date.now() + 20_000))
      return true
    })).toMatchObject({ ok: false, code: 'stale' })
    expect(f.writes).toEqual([])
  })

  it('refuses foreign owners, externals and unsupported files before asking to discard anything', async () => {
    const f = await fixture()
    const request = { draftId: f.draftId, snapshotId: 'snapshot', fileId: 'file' }
    const confirm = vi.fn(async () => true)
    expect(await f.manager.revert('other', request, confirm)).toMatchObject({ ok: false, code: 'unknown-draft' })
    for (const status of ['untracked', 'added', 'renamed', 'conflicted'] as const) {
      f.snapshot.entries[0].status = status
      expect(await f.manager.revert('window', request, confirm)).toMatchObject({ ok: false, code: 'invalid-target' })
    }
    f.snapshot.entries[0].status = 'modified'
    f.snapshot.externalRoots = [{ path: f.path, displayPath: 'external', fileIds: ['file'] }]
    expect(await f.manager.revert('window', request, confirm)).toMatchObject({ ok: false, code: 'external-target' })
    expect(confirm).not.toHaveBeenCalled()
    expect(f.writes).toEqual([])
  })

  it('does not revert after the owning dialog closes during confirmation', async () => {
    const f = await fixture()
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileId: 'file' }, async () => {
      f.manager.release(f.draftId, 'window')
      return true
    })).toMatchObject({ ok: false, code: 'unknown-draft' })
    expect(f.writes).toEqual([])
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
