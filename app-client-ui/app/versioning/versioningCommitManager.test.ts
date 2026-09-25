import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningCommitLimits } from '../../shared/versioningCommit'
import { VersioningCommitManager, type VersioningCommitManagerDeps } from './versioningCommitManager'
import { VersioningCommitMessageStore } from './versioningCommitMessageStore'

describe('app-client-ui/app/versioning/versioningCommitManager', () => {
  it('cancels one review, waits for every pane to close and reopens with a new identity and the saved message', async () => {
    const f = await fixture()
    f.manager.attach(f.draftId, 'second')
    f.manager.setMessage('window', f.draftId, 'Person-edited message')
    const sibling = await f.manager.prepare('session', 'svn', f.path, 'Single-file review')
    if (!sibling.ok) throw new Error(sibling.detail)
    f.manager.attach(sibling.value.draftId, 'window')
    expect(f.manager.reviews('session', 'window').map((review) => review.commitSessionId)).toEqual([f.draftId, sibling.value.draftId])
    expect(f.manager.reviews('session', 'window')[1]?.paths).toEqual([f.path])
    expect(f.manager.reviews('other', 'window')).toEqual([])
    expect(f.manager.reviews('session', 'other')).toEqual([])
    const cancelled = f.manager.cancel(f.draftId)
    expect(f.manager.cancel(f.draftId)).toBe(cancelled)
    expect(f.manager.read('window', f.draftId)?.phase.kind).toBe('cancelled')
    expect(f.manager.setMessage('window', f.draftId, 'Late edit')).toBe(false)
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'unknown-draft' })
    expect(await f.manager.openTortoise('window', f.draftId, 'Late handoff')).toMatchObject({ ok: false, code: 'unknown-draft' })
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileId: 'file' }, async () => true))
      .toMatchObject({ ok: false, code: 'unknown-draft' })
    f.manager.release(f.draftId, 'window')
    expect(f.manager.status(f.draftId)?.closed).toBe(false)
    f.manager.release(f.draftId, 'second')
    expect(await cancelled).toMatchObject({ ok: true, value: { state: 'cancelled', closed: true, revision: null } })
    expect(await f.manager.cancel(f.draftId)).toMatchObject({ ok: true, value: { state: 'cancelled', closed: true } })
    const next = await f.manager.prepare('session', 'svn', null, 'New proposal')
    if (!next.ok) throw new Error(next.detail)
    f.manager.attach(next.value.draftId, 'window')
    expect(next.value.draftId).not.toBe(f.draftId)
    expect(f.manager.read('window', next.value.draftId)?.message).toBe('Person-edited message')
    expect(f.manager.read('window', sibling.value.draftId)?.message).toBe('Single-file review')
    expect(f.writes).toEqual([])
  })

  it.each(['commit', 'revert', 'tortoise'] as const)('refuses cancellation during %s preflight or execution', async (operation) => {
    const f = await fixture()
    f.deps.tortoise.open = async () => ({ ok: true, closed: Promise.resolve() })
    const running = operation === 'commit' ? f.manager.run('window', f.request)
      : operation === 'revert' ? f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileId: 'file' }, async () => true)
        : f.manager.openTortoise('window', f.draftId, 'Message')
    expect(await f.manager.cancel(f.draftId)).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(await running).toMatchObject({ ok: true })
    expect(f.manager.read('window', f.draftId)?.phase.kind).not.toBe('cancelled')
  })

  it('does not turn a committed or unknown review into a cancellation', async () => {
    const f = await fixture()
    await f.manager.run('window', f.request)
    expect(await f.manager.cancel(f.draftId)).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', revision: '42' })
    expect(await f.manager.cancel('missing')).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('bounds waiting for a frozen renderer without making the cancelled review writable again', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    try {
      const cancelled = f.manager.cancel(f.draftId)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await cancelled).toMatchObject({ ok: false, error: { code: 'timeout' } })
      expect(f.manager.setMessage('window', f.draftId, 'Late edit')).toBe(false)
      expect(f.manager.status(f.draftId)?.closed).toBe(false)
      f.manager.release(f.draftId, 'window')
      expect(f.manager.status(f.draftId)).toMatchObject({ state: 'cancelled', closed: true })
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

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
    f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: 'locked' })
    await f.manager.run('window', f.request)
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'failed', closed: false, detail: 'locked' })
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
    const messageFile = join(root, 'state', 'commit-messages.json')
    const report = vi.fn()
    let serial = 0
    const deps: VersioningCommitManagerDeps = {
      messages: new VersioningCommitMessageStore(messageFile, report),
      sessions: { workingContext: async (sessionId) => ({ ok: true, value: { sessionId, cwd: root, agent: null, worktree: null } }), settleVcs: (cwd) => { settled.push(cwd) } },
      vcsStatus: { detect: async (cwd, id) => ({ id, root, cwd, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null }) },
      checkpointStore: { worktreeBelongsToStore: async () => false },
      tortoise: { open: async () => { throw new Error('Unexpected Tortoise dialog') } },
      snapshotOf: (owner, id) => owner === 'window' && id === snapshot.snapshotId ? snapshot : null,
      fileAccess: (owner, id, fileId) => owner === 'window' && id === snapshot.snapshotId && fileId === 'file'
        ? { ok: true, value: { sessionId: 'session', cwd: root, path, nodeKind: 'file', status: 'modified', workingState: { modifiedAt: stamp, vcsEntry: true } } }
        : { ok: false, code: 'unknown-file', detail: 'unknown' },
      git: { revertFile: async () => { throw new Error('Unexpected Git revert') }, commit: async () => { throw new Error('Unexpected Git commit') } },
      svn: { update: async () => { throw new Error('Unexpected SVN update') },
        revertFile: async () => { writes.push('reverted'); return { ok: true, value: undefined } }, commit: async (_scope, _targets, message) => {
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
    return { manager, deps, root, path, snapshot, draftId, writes, phases, settled, messageFile, report,
      request: { draftId, snapshotId: snapshot.snapshotId, fileIds: ['file'], message: 'Reviewed\n\nPříliš' },
    }
  }

  function restart(f: Awaited<ReturnType<typeof fixture>>) {
    return new VersioningCommitManager({ ...f.deps,
      messages: new VersioningCommitMessageStore(f.messageFile, f.report),
    })
  }

  it.each(['svn', 'git'] as const)('restores the %s proposal after an application restart', async (vcs) => {
    const f = await fixture(vcs)
    f.manager.revokeOwner('window')
    const manager = restart(f)
    const opened = await manager.prepare('session', vcs, null, null)
    if (!opened.ok) throw new Error(opened.detail)
    manager.attach(opened.value.draftId, 'new-window')
    expect(opened.value.draftId).not.toBe(f.draftId)
    expect(manager.read('new-window', opened.value.draftId)).toMatchObject({
      message: 'proposal', editedByPerson: false, proposedByAgent: true, phase: { kind: 'editing' },
    })
    expect(await manager.prepare('session', vcs, null, 'Updated proposal')).toMatchObject({ messageApplied: true })
    expect(manager.read('new-window', opened.value.draftId)?.message).toBe('Updated proposal')
    expect(manager.status(f.draftId)).toBeNull()
  })

  it.each(['Reviewed\n\nPříliš žluťoučký kůň', ''])('preserves person-edited text %j and its precedence after restart', async (message) => {
    const f = await fixture()
    expect(f.manager.setMessage('window', f.draftId, message)).toBe(true)
    const manager = restart(f)
    const opened = await manager.prepare('session', 'svn', null, 'Replacement proposal')
    if (!opened.ok) throw new Error(opened.detail)
    manager.attach(opened.value.draftId, 'window')
    expect(opened.messageApplied).toBe(false)
    expect(manager.read('window', opened.value.draftId)).toMatchObject({ message, editedByPerson: true })
  })

  /**
   * SVN refuses a log message that mixes line endings: `E135000: Inconsistent line ending style`,
   * after the review is approved and the targets are staged. The pane used to make that mixture
   * itself - an agent's `--message-file` written on Windows arrives with CRLF, and the trailing
   * newline the commit appends when the text has none is a bare LF.
   */
  it('commits a message that arrived with Windows line endings, and stores it in one style', async () => {
    const f = await fixture()
    const prepared = await f.manager.prepare('session', 'svn', null, 'Proposed\r\n\r\nBody')
    expect(prepared).toMatchObject({ ok: true, messageApplied: true })
    expect(f.manager.read('window', f.draftId)?.message).toBe('Proposed\n\nBody')
    expect(f.manager.setMessage('window', f.draftId, 'Line one\r\nLine two')).toBe(true)
    expect(f.manager.read('window', f.draftId)?.message).toBe('Line one\nLine two')
    expect(await f.manager.run('window', { ...f.request, message: 'Line one\r\nLine two' })).toMatchObject({ ok: true })
    expect(f.writes).toEqual(['Line one\nLine two\n'])
  })

  it('keeps directory, single-file, multi-file, session and VCS messages separate after restart', async () => {
    const f = await fixture()
    const second = await addSecondFile(f)
    await f.manager.prepare('session', 'svn', f.path, 'single file')
    await f.manager.prepare('session', 'svn', null, 'multiple files', [second.path, f.path])
    await f.manager.prepare('other-session', 'svn', null, 'other session')
    await f.manager.prepare('session', 'git', null, 'Git proposal')
    const nested = join(f.root, 'nested')
    await mkdir(nested)
    await f.manager.prepare('session', 'svn', nested, 'other directory')
    const manager = restart(f)
    for (const [sessionId, vcs, scope, paths, message] of [
      ['session', 'svn', null, undefined, 'proposal'],
      ['session', 'svn', f.path, undefined, 'single file'],
      ['session', 'svn', null, [f.path, second.path, f.path], 'multiple files'],
      ['other-session', 'svn', null, undefined, 'other session'],
      ['session', 'git', null, undefined, 'Git proposal'],
      ['session', 'svn', nested, undefined, 'other directory'],
    ] as const) {
      const opened = await manager.prepare(sessionId, vcs, scope, null, paths)
      if (!opened.ok) throw new Error(opened.detail)
      manager.attach(opened.value.draftId, 'window')
      expect(manager.read('window', opened.value.draftId)?.message).toBe(message)
    }
  })

  it.each(['svn', 'git'] as const)('removes a successfully committed %s message without discarding another scope', async (vcs) => {
    const f = await fixture(vcs)
    f.deps.git.commit = async () => ({ ok: true, value: { hash: 'abc123', output: 'Committed' } })
    await f.manager.prepare('session', vcs, f.path, 'Separate review')
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: true })
    const manager = restart(f)
    const opened = await manager.prepare('session', vcs, null, null)
    if (!opened.ok) throw new Error(opened.detail)
    manager.attach(opened.value.draftId, 'window')
    expect(manager.read('window', opened.value.draftId)).toMatchObject({ message: '', editedByPerson: false })
    const separate = await manager.prepare('session', vcs, f.path, null)
    if (!separate.ok) throw new Error(separate.detail)
    manager.attach(separate.value.draftId, 'window')
    expect(manager.read('window', separate.value.draftId)?.message).toBe('Separate review')
  })

  it('restores the submitted message after a failed commit without replaying the operation', async () => {
    const f = await fixture()
    f.deps.svn.commit = vi.fn(async () => ({ ok: false as const, code: 'locked' as const, detail: 'locked' }))
    await f.manager.run('window', f.request)
    const manager = restart(f)
    const opened = await manager.prepare('session', 'svn', null, null)
    if (!opened.ok) throw new Error(opened.detail)
    manager.attach(opened.value.draftId, 'window')
    expect(manager.read('window', opened.value.draftId)).toMatchObject({
      message: f.request.message, editedByPerson: true, phase: { kind: 'editing' },
    })
    expect(f.deps.svn.commit).toHaveBeenCalledTimes(1)
  })

  it('reports failed saves and preserves an unreadable message file', async () => {
    const f = await fixture()
    await writeFile(f.messageFile, '{unreadable')
    const manager = restart(f)
    const opened = await manager.prepare('session', 'svn', null, null)
    if (!opened.ok) throw new Error(opened.detail)
    manager.attach(opened.value.draftId, 'window')
    expect(manager.setMessage('window', opened.value.draftId, 'Keep locally')).toBe(false)
    expect(manager.read('window', opened.value.draftId)?.message).toBe('Keep locally')
    expect(await manager.run('window', { ...f.request, draftId: opened.value.draftId })).toMatchObject({
      ok: false, detail: 'The commit message could not be saved',
    })
    expect(f.writes).toEqual([])
    expect(await readFile(f.messageFile, 'utf8')).toBe('{unreadable')
    expect(f.report).toHaveBeenCalled()
  })

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

  it('keeps a single-file draft distinct and rejects sibling ids from a wider snapshot', async () => {
    const f = await fixture()
    const sibling = await addSecondFile(f)
    const opened = await f.manager.prepare('session', 'svn', f.path, 'one file')
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value).toMatchObject({ scopeRoot: f.root, paths: [f.path] })
    expect(opened.value.draftId).not.toBe(f.draftId)
    f.manager.attach(opened.value.draftId, 'window')
    expect(f.manager.files('window', opened.value.draftId, f.snapshot).entries.map((entry) => entry.fileId)).toEqual(['file'])
    const commit = vi.spyOn(f.deps.svn, 'commit')
    const request = { ...f.request, draftId: opened.value.draftId }
    expect(await f.manager.run('window', { ...request, fileIds: [sibling.fileId] })).toMatchObject({ ok: false, code: 'invalid-target' })
    expect(commit).not.toHaveBeenCalled()
    expect(await f.manager.run('window', request)).toMatchObject({ ok: true })
    expect(commit.mock.calls[0][1].map((target) => target.absolutePath)).toEqual([f.path])
  })

  it('deduplicates explicit file lists and keeps them when the same review is reopened', async () => {
    const f = await fixture()
    const second = await addSecondFile(f)
    const first = await f.manager.prepare('session', 'svn', null, 'two files', [second.path, f.path, f.path])
    if (!first.ok) throw new Error(first.detail)
    const again = await f.manager.prepare('session', 'svn', first.value.scopeRoot, null, first.value.paths)
    expect(again).toMatchObject({ ok: true, value: { draftId: first.value.draftId, paths: [f.path, second.path].sort() } })
    f.manager.attach(first.value.draftId, 'window')
    expect(await f.manager.run('window', { ...f.request, draftId: first.value.draftId, fileIds: ['file', second.fileId] })).toMatchObject({ ok: true })
  })

  /**
   * The heading is one line. A restricted selection used to be that line - every absolute path of
   * it, joined by a newline the heading's `nowrap` folded into a space - so the pane titled itself
   * with the same directory printed once per file.
   */
  it('names the working copy in the heading and lists a restricted selection on hover', async () => {
    const f = await fixture()
    const second = await addSecondFile(f)

    const opened = await f.manager.prepare('session', 'svn', null, null, [second.path, f.path])

    if (!opened.ok) throw new Error(opened.detail)
    f.manager.attach(opened.value.draftId, 'window')
    const draft = f.manager.read('window', opened.value.draftId)
    expect(draft?.scopeRoot).toBe(f.root)
    expect(draft?.scopeTooltip).toBe([f.root, '  file.txt', '  second.txt'].join('\n'))
    // The whole working copy is its own heading: there is nothing a second line would add.
    expect(f.manager.read('window', f.draftId)?.scopeTooltip).toBe(f.root)
  })

  it('reviews and commits an explicit outside directory under the originating session ownership', async () => {
    const f = await fixture()
    const origin = join(f.root, 'session-origin')
    await mkdir(origin)
    f.manager.release(f.draftId, 'window')
    f.deps.sessions.workingContext = async () => ({ ok: true, value: { sessionId: 'session', cwd: origin, agent: null, worktree: null } })
    const opened = await f.manager.prepare('session', 'svn', f.root, 'outside project')
    if (!opened.ok) throw new Error(opened.detail)
    f.manager.attach(opened.value.draftId, 'window')
    expect(f.manager.read('other-window', opened.value.draftId)).toBeNull()
    expect(opened.value.scopeRoot).toBe(f.root)
    expect(await f.manager.run('window', { ...f.request, draftId: opened.value.draftId })).toMatchObject({ ok: true })
    expect(f.settled).toEqual([origin, f.root])
  })

  it('keeps a file grant narrow when that path becomes a directory before reopening', async () => {
    const f = await fixture()
    const opened = await f.manager.prepare('session', 'svn', f.path, null)
    if (!opened.ok) throw new Error(opened.detail)
    await rm(f.path)
    await mkdir(f.path)
    const reopened = await f.manager.prepare('session', 'svn', opened.value.scopeRoot, null, opened.value.paths)
    expect(reopened).toMatchObject({ ok: true, value: { draftId: opened.value.draftId, paths: [f.path] } })
    f.manager.attach(opened.value.draftId, 'window')
    const child = { ...f.snapshot.entries[0], path: join(f.path, 'child.txt') }
    expect(f.manager.files('window', opened.value.draftId, { ...f.snapshot, entries: [child] }).entries).toEqual([])
  })

  it('updates only the reviewed file after an out-of-date single-file commit', async () => {
    const f = await fixture()
    const opened = await f.manager.prepare('session', 'svn', f.path, null)
    if (!opened.ok) throw new Error(opened.detail)
    f.manager.attach(opened.value.draftId, 'window')
    f.deps.svn.commit = async () => ({ ok: false, code: 'out-of-date', detail: 'E155011' })
    f.deps.svn.update = vi.fn(async () => ({ ok: true as const, value: { output: 'Updated' } }))
    expect(await f.manager.run('window', { ...f.request, draftId: opened.value.draftId })).toMatchObject({ ok: false, reloadRequired: true })
    expect(f.deps.svn.update).toHaveBeenCalledWith(f.root, [f.path])
    expect(f.settled).toEqual([f.root])
  })

  it('publishes bounded progress, preserves the batch clock and resets each group measurement', async () => {
    const f = await fixture()
    const external = await addExternal(f, 'external')
    let now = 10_000
    f.deps.now = () => now
    const changed = vi.fn()
    f.deps.onChanged = changed
    let groupIndex = 0
    f.deps.svn.commit = async (_scope, _targets, _message, report) => {
      groupIndex++
      const stageStartedAt = now
      report?.({ stage: 'sending', completed: 0, total: 100 })
      const calls = changed.mock.calls.length
      for (let completed = 1; completed < 20; completed++) {
        now++
        report?.({ stage: 'sending', completed, total: 100 })
      }
      expect(changed).toHaveBeenCalledTimes(calls)
      now += 1_000
      report?.({ stage: 'sending', completed: 50, total: 100 })
      expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'running', startedAt: 10_000,
        progress: { stage: 'sending', completed: 50, total: 100, stageStartedAt, updatedAt: now, groupIndex, groupCount: 2 } })
      expect(changed).toHaveBeenCalledTimes(calls + 1)
      return { ok: true, value: { revision: String(groupIndex), output: 'done' } }
    }
    const result = await f.manager.run('window', { ...f.request, fileIds: ['file', external.entry.fileId], includeExternals: true })
    expect(result).toMatchObject({ ok: true })
    expect(f.manager.read('window', f.draftId)?.phase.kind).toBe('done')
  })

  async function addExternal(f: Awaited<ReturnType<typeof fixture>>, name: string) {
    const root = join(f.root, name)
    await mkdir(root, { recursive: true })
    const path = join(root, 'external.txt')
    await writeFile(path, `content of ${name}`)
    const modifiedAt = Math.round((await lstat(path)).mtimeMs)
    const entry = { ...f.snapshot.entries[0], fileId: name, path, displayPath: `${name}/external.txt`, modifiedAt }
    f.snapshot.entries = [...f.snapshot.entries, entry]
    f.snapshot.externalRoots = [...f.snapshot.externalRoots, { path: root, displayPath: name, fileIds: [entry.fileId] }]
    const access = f.deps.fileAccess
    f.deps.fileAccess = (owner, id, fileId) => {
      const result = access(owner, id, fileId === name ? 'file' : fileId)
      return result.ok && fileId === name ? { ok: true, value: { ...result.value, path,
        workingState: { modifiedAt, vcsEntry: true } } } : result
    }
    const detect = f.deps.vcsStatus.detect
    f.deps.vcsStatus.detect = async (cwd, vcs) => {
      const result = await detect(cwd, vcs)
      return result !== null && cwd === root ? { ...result, root } : result
    }
    return { root, entry }
  }

  it('commits selected external groups before the main scope with one reviewed message', async () => {
    const f = await fixture()
    const b = await addExternal(f, 'shared/b')
    const a = await addExternal(f, 'shared/a')
    await addExternal(f, 'shared/unchecked')
    const calls: { scope: string; paths: string[]; message: string }[] = []
    f.deps.svn.commit = async (scope, targets, message) => {
      calls.push({ scope, paths: targets.map((target) => target.absolutePath), message: await readFile(message, 'utf8') })
      expect(f.manager.status(f.draftId)?.state).toBe('running')
      return { ok: true, value: { revision: String(40 + calls.length), output: `Committed ${scope}` } }
    }
    expect(await f.manager.run('window', { ...f.request, fileIds: ['file', b.entry.fileId, a.entry.fileId], includeExternals: true }))
      .toEqual({ ok: true, revision: '41, 42, 43' })
    expect(calls).toEqual([
      { scope: a.root, paths: [a.entry.path], message: `${f.request.message}\n` },
      { scope: b.root, paths: [b.entry.path], message: `${f.request.message}\n` },
      { scope: f.root, paths: [f.path], message: `${f.request.message}\n` },
    ])
    expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'done', output: expect.stringContaining(`${a.root}: 41`) })
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', revision: '41, 42, 43' })
  })

  it('can commit only an external without including the main scope', async () => {
    const f = await fixture()
    const external = await addExternal(f, 'shared/lib')
    const commit = vi.spyOn(f.deps.svn, 'commit')
    expect(await f.manager.run('window', { ...f.request, fileIds: [external.entry.fileId], includeExternals: true })).toMatchObject({ ok: true })
    expect(commit).toHaveBeenCalledExactlyOnceWith(external.root, [expect.objectContaining({ absolutePath: external.entry.path })], expect.any(String), expect.any(Function))
  })

  it('checks every group before the first write and refuses changed external roots', async () => {
    const f = await fixture()
    const external = await addExternal(f, 'shared/lib')
    const request = { ...f.request, fileIds: ['file', external.entry.fileId], includeExternals: true as const }
    const commit = vi.spyOn(f.deps.svn, 'commit')
    const stamp = f.snapshot.entries[0].modifiedAt!
    await utimes(f.path, new Date(stamp + 10_000), new Date(stamp + 10_000))
    expect(await f.manager.run('window', request)).toMatchObject({ ok: false, code: 'stale' })
    expect(commit).not.toHaveBeenCalled()
    f.deps.vcsStatus.detect = async (cwd, id) => ({ id, cwd, root: f.root, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null })
    expect(await f.manager.run('window', request)).toMatchObject({ ok: false, code: 'external-target', reloadRequired: true })
    expect(commit).not.toHaveBeenCalled()
  })

  it('locks all selected external scopes against another dialog until the batch ends', async () => {
    const f = await fixture()
    const a = await addExternal(f, 'shared/a')
    const b = await addExternal(f, 'shared/b')
    const separate = await f.manager.prepare('session', 'svn', b.root, null)
    if (!separate.ok) throw new Error(separate.detail)
    f.manager.attach(separate.value.draftId, 'window')
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    f.deps.svn.commit = async () => {
      started()
      await new Promise<void>((resolve) => { finish = resolve })
      return { ok: false, code: 'svn-failed', detail: 'Stop here' }
    }
    const run = f.manager.run('window', { ...f.request, fileIds: [a.entry.fileId, b.entry.fileId], includeExternals: true })
    await entered
    const request = { ...f.request, draftId: separate.value.draftId, fileIds: [b.entry.fileId] }
    expect(await f.manager.run('window', request)).toMatchObject({ ok: false, code: 'busy' })
    finish()
    await run
    f.deps.svn.commit = async () => ({ ok: true, value: { revision: '50', output: 'done' } })
    expect(await f.manager.run('window', request)).toMatchObject({ ok: true })
  })

  it('reports partial commits, invalidates the old list and retries only refreshed remaining targets', async () => {
    const f = await fixture()
    const a = await addExternal(f, 'shared/a')
    const b = await addExternal(f, 'shared/b')
    const commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>()
      .mockResolvedValueOnce({ ok: true, value: { revision: '51', output: 'first committed' } })
      .mockResolvedValueOnce({ ok: false, code: 'locked', detail: 'second is locked' })
      .mockResolvedValue({ ok: true, value: { revision: '52', output: 'committed' } })
    f.deps.svn.commit = commit
    const request = { ...f.request, fileIds: ['file', a.entry.fileId, b.entry.fileId], includeExternals: true as const }
    const result = await f.manager.run('window', request)
    expect(result).toMatchObject({ ok: false, code: 'vcs-failed', reloadRequired: true,
      detail: expect.stringContaining(`${a.root}: 51`) })
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'failed', detail: expect.stringContaining('second is locked') })
    expect(commit.mock.calls.map(([scope]) => scope)).toEqual([a.root, b.root])
    expect(await f.manager.run('window', request)).toMatchObject({ ok: false, code: 'invalid-target', reloadRequired: true })
    expect(commit).toHaveBeenCalledTimes(2)
    f.snapshot.snapshotId = 'refreshed'
    f.snapshot.entries = f.snapshot.entries.filter((entry) => entry.fileId !== a.entry.fileId)
    expect(await f.manager.run('window', { ...request, snapshotId: 'refreshed', fileIds: ['file', b.entry.fileId] })).toMatchObject({ ok: true })
    expect(commit.mock.calls.map(([scope]) => scope)).toEqual([a.root, b.root, b.root, f.root])
  })

  it('updates only the outdated external, reports earlier commits and stops before the main commit', async () => {
    const f = await fixture()
    const a = await addExternal(f, 'shared/a')
    const b = await addExternal(f, 'shared/b')
    f.deps.svn.commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>()
      .mockResolvedValueOnce({ ok: true, value: { revision: '60', output: 'done' } })
      .mockResolvedValue({ ok: false, code: 'out-of-date', detail: 'E155011' })
    f.deps.svn.update = vi.fn(async () => ({ ok: true as const, value: { output: 'Updated' } }))
    const result = await f.manager.run('window', { ...f.request, fileIds: ['file', a.entry.fileId, b.entry.fileId], includeExternals: true })
    expect(result).toMatchObject({ ok: false, reloadRequired: true, detail: expect.stringContaining(`${a.root}: 60`) })
    expect(f.deps.svn.update).toHaveBeenCalledExactlyOnceWith(b.root)
    expect(f.deps.svn.commit).toHaveBeenCalledTimes(3)
    expect(f.manager.status(f.draftId)?.state).toBe('failed')
  })

  it.each(['changed', 'closed'] as const)('stops remaining groups if their file is %s after an earlier commit', async (kind) => {
    const f = await fixture()
    const external = await addExternal(f, 'shared/lib')
    const commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>(async () => {
      if (kind === 'changed') await utimes(f.path, new Date(0), new Date(0))
      else if (kind === 'closed') f.manager.release(f.draftId, 'window')
      else throw new Error(`Unknown test case: ${kind}`)
      return { ok: true, value: { revision: '61', output: 'done' } }
    })
    f.deps.svn.commit = commit
    expect(await f.manager.run('window', { ...f.request, fileIds: ['file', external.entry.fileId], includeExternals: true }))
      .toMatchObject({ ok: false, reloadRequired: true, detail: expect.stringContaining(`${external.root}: 61`) })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(f.manager.status(f.draftId)?.state).toBe('failed')
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
    ], expect.any(String), expect.any(Function))
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

  /**
   * A copy is published as one node, from its copyfrom source, so the files under it have no commit
   * of their own. Sending one as a target would run `svn commit --depth empty` on a path whose
   * parent add is still unpublished, which SVN refuses - and narrowing the copy is not something a
   * person can ask for in the first place.
   */
  it('commits a copied directory whole and never one of the files it carries', async () => {
    const f = await fixture()
    const directory = join(f.root, 'react')
    await mkdir(directory, { recursive: true })
    const carried = join(directory, 'axClientOnly.tsx')
    await writeFile(carried, 'body')
    const stamp = Math.round((await lstat(directory)).mtimeMs)
    const base = f.snapshot.entries[0]!
    f.snapshot.entries = [
      { ...base, fileId: 'react', path: directory, displayPath: 'react', nodeKind: 'directory', status: 'added', modifiedAt: stamp },
      { ...base, fileId: 'carried', path: carried, displayPath: 'react/axClientOnly.tsx', status: 'copied', modifiedAt: stamp },
    ]
    const access = f.deps.fileAccess
    f.deps.fileAccess = (owner, id, fileId) => {
      const result = access(owner, id, 'file')
      if (!result.ok) return result
      if (fileId === 'react') return { ok: true, value: { ...result.value, path: directory, nodeKind: 'directory', status: 'added', workingState: { modifiedAt: stamp, vcsEntry: true } } }
      if (fileId === 'carried') return { ok: true, value: { ...result.value, path: carried, status: 'copied', workingState: { modifiedAt: stamp, vcsEntry: true } } }
      return result
    }
    const calls: string[][] = []
    f.deps.svn.commit = async (_scope, targets, _message) => {
      calls.push(targets.map((target) => target.absolutePath))
      return { ok: true, value: { revision: '42', output: 'Committed revision 42.' } }
    }
    expect(await f.manager.run('window', { ...f.request, fileIds: ['react', 'carried'] })).toMatchObject({ ok: true })
    expect(calls).toEqual([[directory]])
  })

  /**
   * `svn delete --keep-local` publishes the removal and leaves the files behind, so each one comes
   * back as an untracked row inside the deleted directory. Staging one runs `svn add --parents`,
   * which replaces that directory and publishes the subtree again, so the pane draws those rows
   * disabled: a selection that still carries one is a stale snapshot, not a decision.
   */
  it('refuses an untracked path inside a directory the same commit deletes', async () => {
    const f = await fixture()
    const directory = join(f.root, 'data')
    await mkdir(join(directory, 'records'), { recursive: true })
    const kept = join(directory, 'records', 'run.json')
    await writeFile(kept, '{}')
    const stamp = Math.round((await lstat(kept)).mtimeMs)
    const base = f.snapshot.entries[0]!
    f.snapshot.entries = [
      { ...base, fileId: 'data', path: directory, displayPath: 'data', nodeKind: 'directory', status: 'deleted', modifiedAt: null },
      { ...base, fileId: 'kept', path: kept, displayPath: 'data/records/run.json', status: 'untracked', modifiedAt: stamp },
    ]
    const access = f.deps.fileAccess
    f.deps.fileAccess = (owner, id, fileId) => {
      const result = access(owner, id, 'file')
      if (!result.ok) return result
      if (fileId === 'data') return { ok: true, value: { ...result.value, path: directory, nodeKind: 'directory', status: 'deleted', workingState: { modifiedAt: null, vcsEntry: true } } }
      if (fileId === 'kept') return { ok: true, value: { ...result.value, path: kept, status: 'untracked', workingState: { modifiedAt: stamp, vcsEntry: true } } }
      return result
    }
    f.deps.svn.commit = async () => { throw new Error('Unexpected SVN commit') }
    expect(await f.manager.run('window', { ...f.request, fileIds: ['data', 'kept'] }))
      .toMatchObject({ ok: false, code: 'invalid-target', detail: expect.stringContaining('a directory this commit deletes') })
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

  it('commits an SVN deletion that kept its file on disk, and keeps refusing that for Git', async () => {
    const f = await fixture()
    f.snapshot.entries[0].status = 'deleted'
    await utimes(f.path, new Date(), new Date(Date.now() + 10_000))
    expect(await f.manager.run('window', f.request)).toEqual({ ok: true, revision: '42' })
    expect(f.writes).toHaveLength(1)
    const git = await fixture('git')
    git.snapshot.entries[0].status = 'deleted'
    expect(await git.manager.run('window', git.request)).toMatchObject({ ok: false, code: 'stale' })
    expect(git.writes).toEqual([])
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

  it.each(['svn', 'git'] as const)('requests a reload for an expired or mismatched %s list without writing', async (vcs) => {
    const f = await fixture(vcs)
    const svn = vi.spyOn(f.deps.svn, 'commit')
    const git = vi.spyOn(f.deps.git, 'commit')
    const refusal = { ok: false, code: 'invalid-target', reloadRequired: true }
    expect(await f.manager.run('window', { ...f.request, snapshotId: 'expired' })).toMatchObject(refusal)
    f.snapshot.sessionId = 'another-session'
    expect(await f.manager.run('window', f.request)).toMatchObject(refusal)
    f.snapshot.sessionId = 'session'
    f.snapshot.source.selected = vcs === 'svn' ? 'git' : 'svn'
    expect(await f.manager.run('window', f.request)).toMatchObject(refusal)
    f.snapshot.source.selected = vcs
    const invalidFile = await f.manager.run('window', { ...f.request, fileIds: ['unknown'] })
    expect(invalidFile).toMatchObject({ ok: false, code: 'invalid-target' })
    expect(invalidFile).not.toHaveProperty('reloadRequired')
    expect(svn).not.toHaveBeenCalled()
    expect(git).not.toHaveBeenCalled()
    expect(f.manager.read('window', f.draftId)?.phase.kind).toBe('editing')
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
    f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: 'locked' })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'vcs-failed' })
    expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'failed', detail: 'locked' })
    f.manager.attach(f.draftId, 'second')
    f.manager.revokeOwner('window')
    expect(f.manager.openSessions().sessionIds).toEqual(['session'])
    f.manager.revokeOwner('second')
    expect(f.manager.openSessions().sessionIds).toEqual([])
  })

  it('updates an outdated scope once under the commit lock and gives up on a second out-of-date', async () => {
    const f = await fixture()
    f.deps.svn.commit = vi.fn(async () => ({ ok: false as const, code: 'out-of-date' as const, detail: 'E155011: out of date' }))
    f.deps.svn.update = vi.fn(async (scope: string) => {
      expect(scope).toBe(f.root)
      expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'running', detail: expect.stringContaining('Updating') })
      expect(f.manager.status(f.draftId)?.state).toBe('running')
      expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'busy' })
      return { ok: true as const, value: { output: 'Updated to revision 43.' } }
    })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, reloadRequired: true,
      detail: expect.stringContaining('E155011') })
    expect(f.deps.svn.commit).toHaveBeenCalledTimes(2)
    expect(f.deps.svn.update).toHaveBeenCalledTimes(1)
    expect(f.settled).toEqual([f.root])
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'failed', revision: null, detail: expect.stringContaining('E155011') })
    expect(f.manager.read('window', f.draftId)?.message).toBe(f.request.message)
  })

  it('commits the reviewed selection itself after an update that left it alone', async () => {
    const f = await fixture()
    const commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>()
      .mockResolvedValueOnce({ ok: false, code: 'out-of-date', detail: 'E155011: out of date' })
      .mockResolvedValue({ ok: true, value: { revision: '45', output: 'Committed revision 45.' } })
    f.deps.svn.commit = commit
    f.deps.svn.update = vi.fn(async () => ({ ok: true as const, value: { output: 'Updated to revision 44.' } }))
    expect(await f.manager.run('window', f.request)).toEqual({ ok: true, revision: '45' })
    expect(commit).toHaveBeenCalledTimes(2)
    expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'done', revision: '45',
      output: expect.stringContaining('Updated to revision 44.') })
  })

  it('stops the retry when the update wrote into a file this commit holds', async () => {
    const f = await fixture()
    f.deps.svn.commit = vi.fn(async () => ({ ok: false as const, code: 'out-of-date' as const, detail: 'E155011: out of date' }))
    f.deps.svn.update = vi.fn(async () => {
      await utimes(f.path, new Date(), new Date(Date.now() + 10_000))
      return { ok: true as const, value: { output: 'U    file.txt' } }
    })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, reloadRequired: true,
      detail: expect.stringContaining('The update changed a file this commit holds') })
    expect(f.deps.svn.commit).toHaveBeenCalledTimes(1)
  })

  it.each(['conflicts', 'exception'])('reports update %s with the original commit error and refreshes VCS facts', async (kind) => {
    const f = await fixture()
    f.deps.svn.commit = async () => ({ ok: false, code: 'out-of-date', detail: 'E170004: directory is out of date' })
    f.deps.svn.update = async () => {
      if (kind === 'exception') throw new Error('Connection lost')
      return { ok: false, code: 'svn-failed', detail: 'Conflict in app/file.ts' }
    }
    const result = await f.manager.run('window', f.request)
    expect(result).toMatchObject({ ok: false, reloadRequired: true, detail: expect.stringContaining('E170004') })
    expect(result).toMatchObject({ detail: expect.stringContaining(kind === 'exception' ? 'Connection lost' : 'app/file.ts') })
    expect(f.settled).toEqual([f.root])
    f.deps.svn.commit = async () => ({ ok: true, value: { revision: '44', output: 'Committed' } })
    expect(await f.manager.run('window', f.request)).toEqual({ ok: true, revision: '44' })
  })

  it.each(['svn', 'git'] as const)('never updates %s after an unrelated failure', async (vcs) => {
    const f = await fixture(vcs)
    f.deps.svn.update = vi.fn(async () => { throw new Error('Must not update') })
    f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: 'locked' })
    f.deps.git.commit = async () => { throw new Error('Git failed') }
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, detail: vcs === 'svn' ? 'locked' : 'Git failed' })
    expect(f.deps.svn.update).not.toHaveBeenCalled()
  })

  it('allows explicit outside scopes and still refuses missing VCS and checkpoint worktrees', async () => {
    const f = await fixture()
    expect(await f.manager.prepare('session', 'svn', '..', null)).toMatchObject({ ok: true })
    f.deps.vcsStatus.detect = async () => null
    expect(await f.manager.prepare('session', 'svn', null, null)).toMatchObject({ ok: false, code: 'no-working-copy' })
    f.deps.vcsStatus.detect = async (cwd, id) => ({ id, cwd, root: f.root, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null })
    f.deps.checkpointStore.worktreeBelongsToStore = async () => true
    await mkdir(join(f.root, 'nested'))
    expect(await f.manager.prepare('session', 'git', 'nested', null)).toMatchObject({ ok: false, code: 'store-worktree' })
  })
})
