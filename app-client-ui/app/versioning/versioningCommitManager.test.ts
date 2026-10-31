import type { VersioningWorkflowState } from '../../shared/versioningCommit'
import { FileChangesFingerprint } from '../../../lib-orchestrator/fileChangesManager/fileChangesFingerprint'
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { SessionCommitReceipt } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { VersioningWorkflowAccess } from './versioningWorkflowAccess'
import { VersioningCommitLimits } from '../../shared/versioningCommit'
import { VersioningCommitManager, type VersioningCommitManagerDeps } from './versioningCommitManager'
import { RemoteReviewAccess } from '../remoteControl/remoteReviewAccess'
import { RemoteContentAccess } from '../remoteControl/remoteContentAccess'
import { ReviewInteractionAccess } from './reviewInteractionAccess'
import { VersioningReviewStore } from './versioningReviewStore'
import { VersioningCommitMessageStore } from './versioningCommitMessageStore'

describe('app-client-ui/app/versioning/versioningCommitManager', () => {
  it('routes managed SVN split commits to Finish while allowing its review-only editor', async () => {
    const f = await fixture()
    f.deps.sessions.worktreeAt = async () => ({ sessionId: 'worker', kind: 'svn', path: f.root })
    expect(await f.manager.prepare('session', 'svn', null, null)).toMatchObject({ ok: false, code: 'use-finish' })
    expect(await f.manager.prepare('session', 'svn', null, null, undefined, { reviewOnly: true })).toMatchObject({ ok: true })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'use-finish' })
    expect(await f.manager.openTortoise('window', f.draftId, '[App] Change')).toMatchObject({ ok: false, code: 'use-finish' })
    f.deps.sessions.worktreeAt = async () => null
    expect(await f.manager.prepare('session', 'svn', null, null)).toMatchObject({ ok: true })
  })
  it('refuses an unregistered SVN worktree path from another profile', async () => {
    const f = await fixture()
    const worktree = join(f.root, '.worktrees', 'other-profile')
    f.deps.sessions.workingContext = async () => ({ ok: true, value: { sessionId: 'session', cwd: worktree, agent: null, worktree: null } })
    f.deps.vcsStatus.detect = async (cwd, id) => ({ id, root: worktree, cwd, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null })
    expect(await f.manager.prepare('session', 'svn', null, null)).toMatchObject({ ok: false, code: 'use-finish' })
  })

  it('refuses a restored main-root draft selecting a nested SVN worktree for publication or Tortoise', async () => {
    const f = await fixture()
    f.snapshot.entries[0].path = join(f.root, '.worktrees', 'foreign', 'a.txt')
    f.manager.files('window', f.draftId, f.snapshot)
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'use-finish' })
    expect(await f.manager.openTortoise('window', f.draftId, '[App] Change')).toMatchObject({ ok: false, code: 'use-finish' })
    expect(f.writes).toEqual([])
  })

  it('keeps setup rows out of the initial stored selection', async () => {
    const f = await fixture()
    f.snapshot.entries[0].origin = 'setup'
    f.manager.files('window', f.draftId, f.snapshot)
    expect(f.manager.read('window', f.draftId)?.selection?.paths).not.toContain(f.snapshot.entries[0].path)
  })

  it('carries proposal, local and remote message sources through storage', async () => {
    const f = await fixture()
    expect(f.manager.read('window', f.draftId)).toMatchObject({ messageSource: 'agent-proposal', messageAt: expect.any(Number) })
    f.manager.setMessage('window', f.draftId, '[Jamat] Local')
    expect(f.manager.read('window', f.draftId)?.messageSource).toBe('person-local')
    const draft = f.manager.read('window', f.draftId)!
    expect(f.manager.edit('window', { draftId: draft.draftId, epoch: draft.epoch!, expectedRevision: draft.revision, message: '[Jamat] Remote' }))
      .toMatchObject({ ok: true, value: { messageSource: 'person-remote' } })
    const edited = f.manager.read('window', f.draftId)!
    expect(f.manager.edit('window', { draftId: edited.draftId, epoch: edited.epoch!, expectedRevision: edited.revision, message: '[Jamat] Restored', messageSource: 'restored-draft' }))
      .toMatchObject({ ok: true, value: { messageSource: 'restored-draft' } })
    const document = JSON.parse(await readFile(f.messageFile, 'utf8'))
    expect(Object.values(document.messages)).toEqual([expect.objectContaining({ source: 'restored-draft', at: expect.any(Number) })])
  })

  it('reads old stored messages with unknown provenance', async () => {
    const f = await fixture()
    const document = JSON.parse(await readFile(f.messageFile, 'utf8'))
    for (const message of Object.values(document.messages) as Record<string, unknown>[]) { delete message.source; delete message.at }
    await writeFile(f.messageFile, JSON.stringify(document))
    const manager = restart(f)
    const opened = await manager.prepare('session', 'svn', null, null)
    if (!opened.ok) throw new Error(opened.detail)
    manager.attach(opened.value.draftId, 'window')
    expect(manager.read('window', opened.value.draftId)).toMatchObject({ messageSource: 'unknown', messageAt: 0 })
  })

  it('restores the same pending review and empty human text with a fresh epoch but no leases or file grants', async () => {
    const f = await fixture()
    const file = join(f.root, 'reviews.json')
    f.deps.reviews = new VersioningReviewStore(file, f.report)
    f.manager.files('window', f.draftId, f.snapshot)
    f.manager.setMessage('window', f.draftId, '')
    const before = f.manager.read('window', f.draftId)!
    f.manager.release(f.draftId, 'window')
    const manager = new VersioningCommitManager({ ...f.deps, reviews: new VersioningReviewStore(file, f.report),
      snapshotOf: () => null, fileAccess: () => ({ ok: false, code: 'unknown-file', detail: 'No restored grants' }) })
    expect(manager.read('window', f.draftId)).toBeNull()
    expect(manager.openSessions().sessionIds).toEqual(['session'])
    manager.attach(f.draftId, 'viewer')
    // The emptied field survives the restart, but it is nobody's message (2026-10-30).
    expect(manager.read('viewer', f.draftId)).toMatchObject({ message: '', editedByPerson: false, phase: { kind: 'editing' } })
    expect(manager.read('viewer', f.draftId)?.epoch).not.toBe(before.epoch)
    expect(await manager.run('viewer', f.request)).toMatchObject({ ok: false, reloadRequired: true })
    const saved = await readFile(file, 'utf8')
    expect(saved).not.toContain('owners')
    expect(saved).not.toContain('fileReviews')
    expect(saved).not.toContain('epoch')
  })

  it('finishes every accepted external group after its last viewer detaches', async () => {
    const f = await fixture()
    const external = await addExternal(f, 'shared/lib')
    f.deps.svn.commit = vi.fn(async () => {
      f.manager.release(f.draftId, 'window')
      return { ok: true as const, value: { committedPaths: [], revision: '61', output: 'done' } }
    })
    expect(await f.manager.run('window', { ...f.request, fileIds: ['file', external.entry.fileId], includeExternals: true }))
      .toEqual({ ok: true, revision: '61, 61' })
    expect(f.deps.svn.commit).toHaveBeenCalledTimes(2)
  })

  it('restores closed result retention without reviving a settled review', async () => {
    const f = await fixture()
    const file = join(f.root, 'reviews.json')
    f.deps.reviews = new VersioningReviewStore(file, f.report)
    f.deps.now = () => 100
    await f.manager.run('window', f.request)
    f.manager.release(f.draftId, 'window')
    const manager = new VersioningCommitManager({ ...f.deps, reviews: new VersioningReviewStore(file, f.report), now: () => 101 })
    expect(manager.status(f.draftId)).toMatchObject({ state: 'committed', closed: true })
    manager.attach(f.draftId, 'viewer')
    expect(manager.read('viewer', f.draftId)).toBeNull()
    const expired = new VersioningCommitManager({ ...f.deps, reviews: new VersioningReviewStore(file, f.report), now: () => 86_400_101 })
    expect(expired.status(f.draftId)).toBeNull()
  })

  it('keeps the accepted message and revision when durable review persistence refuses an edit', async () => {
    const f = await fixture()
    f.deps.reviews = { read: () => [], save: () => true }
    f.manager.setMessage('window', f.draftId, 'Accepted')
    const before = f.manager.read('window', f.draftId)
    f.deps.reviews.save = () => false
    expect(() => f.manager.setMessage('window', f.draftId, 'Unsaved')).toThrow('could not be saved')
    expect(f.manager.read('window', f.draftId)).toEqual(before)
    expect(f.deps.messages.read(before!)).toMatchObject({ message: 'Accepted' })
  })

  it('accepts one CAS edit at N and refuses stale message, selection and approval', async () => {
    const f = await fixture()
    f.manager.files('window', f.draftId, f.snapshot)
    const draft = f.manager.read('window', f.draftId)!
    const request = { draftId: f.draftId, epoch: draft.epoch!, expectedRevision: draft.revision }
    expect(f.manager.edit('window', { ...request, message: '' })).toMatchObject({ ok: true, value: { revision: draft.revision + 1, message: '' } })
    expect(f.manager.edit('window', { ...request, message: 'Lost update' })).toMatchObject({ ok: false, code: 'stale', current: { message: '' } })
    expect(f.manager.edit('window', { ...request, selection: { snapshotId: 'snapshot', fileIds: ['file'] } })).toMatchObject({ ok: false, code: 'stale' })
    expect(await f.manager.run('window', { ...f.request, ...request })).toMatchObject({ ok: false, code: 'stale' })
    expect(f.writes).toEqual([])
  })

  it('persists exact source selection and refuses unseen file ids', async () => {
    const f = await fixture()
    const file = join(f.root, 'reviews.json')
    f.deps.reviews = new VersioningReviewStore(file, f.report)
    f.manager.files('window', f.draftId, f.snapshot)
    const draft = f.manager.read('window', f.draftId)!
    const request = { draftId: f.draftId, epoch: draft.epoch!, expectedRevision: draft.revision }
    expect(f.manager.edit('window', { ...request, selection: { snapshotId: 'snapshot', fileIds: ['unseen'] } }))
      .toMatchObject({ ok: false, code: 'invalid-target' })
    expect(f.manager.edit('window', { ...request, message: '', selection: { snapshotId: 'snapshot', fileIds: ['file'] } })).toMatchObject({ ok: true })
    const manager = new VersioningCommitManager({ ...f.deps, reviews: new VersioningReviewStore(file, f.report) })
    manager.attach(f.draftId, 'viewer')
    expect(manager.read('viewer', f.draftId)).toMatchObject({ message: '', selection: { snapshotId: 'snapshot', paths: [f.path] } })
  })

  async function admitted(f: Awaited<ReturnType<typeof fixture>>, active = () => true) {
    const access = new ReviewInteractionAccess()
    f.deps.interactions = access
    f.manager.files('window', f.draftId, f.snapshot)
    const draft = f.manager.read('window', f.draftId)!
    const edited = f.manager.edit('window', { draftId: f.draftId, epoch: draft.epoch!, expectedRevision: draft.revision,
      message: f.request.message, selection: { snapshotId: 'snapshot', fileIds: ['file'] } })
    if (!edited.ok) throw new Error(edited.detail)
    return { interaction: access.local('window', 'session', active), request: { ...f.request, kind: 'approve' as const,
      epoch: edited.value.epoch!, expectedRevision: edited.value.revision, operationId: 'human-press' } }
  }

  async function finishFixture(vcs: 'svn' | 'git' = 'svn') {
    const f = await fixture(vcs)
    const fingerprint = await FileChangesFingerprint.of(f.path)
    const fileAccess = f.deps.fileAccess
    f.deps.fileAccess = (...args) => {
      const result = fileAccess(...args)
      return result.ok ? { ok: true, value: { ...result.value, workingState: { ...result.value.workingState!, fingerprint } } } : result
    }
    let state: VersioningWorkflowState = { kind: 'running' }
    const check = vi.fn((): string | null => null)
    const start = vi.fn(async () => ({ ok: true as const, revision: '' }))
    f.deps.workflow = { offers: () => true, check, start, state: () => state, changed: (paths) => `Changed since this review was read: ${paths.join(', ')}` }
    f.deps.reviews = new VersioningReviewStore(join(f.root, 'reviews.json'), f.report)
    const { interaction, request } = await admitted(f)
    return { ...f, interaction, fingerprint, check, start, state: (next: VersioningWorkflowState) => { state = next },
      decision: { ...request, kind: 'finish' as const, workflow: { workflowId: 'finish', revision: 7, actionId: 'finish-again' as const, agreement: {} } } }
  }

  it('shows the saved application proposal in a multi-repository review without filling external or person-owned messages', async () => {
    const f = await fixture()
    const repositories = [f.root, join(f.root, 'shared')].map((root, index) => ({ root, repository: `https://svn/repo${index}`,
      repositoryName: `repo${index}`, expectedPrefix: `[repo${index}]`, paths: ['a.txt'], message: '', source: 'unknown' as const, acknowledged: [] }))
    const snapshot = { revision: 7, sessions: [{ sessionId: 'session', actions: { sections: [{ workflowId: 'finish', open: true,
      actions: [{ id: 'finish-again', requiresCommit: true }], rounds: [{ steps: [{ state: 'waits', body: { kind: 'commit', vcs: 'svn', scopeRoot: f.root, repositories } }] }] }] } }] }
    f.deps.workflow = new VersioningWorkflowAccess({ snapshot: () => snapshot as never, finishWorktreeSession: vi.fn() })
    expect(await f.manager.propose('session', f.root, '[repo0] Verify prepared application')).toMatchObject({ ok: true })
    const before = f.manager.read('window', f.draftId)!
    expect(before.repositories?.map(({ message, source }) => ({ message, source }))).toEqual([
      { message: '[repo0] Verify prepared application', source: 'agent-proposal' }, { message: '', source: 'unknown' },
    ])
    const edited = f.manager.edit('window', { draftId: f.draftId, epoch: before.epoch!, expectedRevision: before.revision,
      repositoryMessage: { root: f.root, message: '' } }, 'person-local')
    expect(edited).toMatchObject({ ok: true, value: { repositories: [
      { message: '', source: 'person-local' }, { message: '', source: 'unknown' },
    ] } })
    expect(f.manager.read('window', f.draftId)?.repositories?.[0].message).toBe('')
    repositories[0].paths = ['changed-since-review.txt']
    repositories.splice(1, 1)
    const refreshed = f.manager.read('window', f.draftId)!
    expect(refreshed.repositories).toHaveLength(1)
    expect(refreshed.repositories?.[0]).toMatchObject({ paths: ['changed-since-review.txt'], message: '', source: 'person-local' })
  })

  function finishRepositories(f: Awaited<ReturnType<typeof fixture>>) {
    const repositories = [f.root, join(f.root, 'lib', 'ea')].map((root, index) => ({ root, repository: `https://svn/${index === 0 ? 'app' : 'ea'}/j12`,
      repositoryName: 'j12', expectedPrefix: '[j12]', paths: ['a.txt'], message: index === 0 ? '[j12] Agent proposal A' : '', source: index === 0 ? 'agent-proposal' as const : 'unknown' as const, acknowledged: [] }))
    const snapshot = { revision: 7, sessions: [{ sessionId: 'session', actions: { sections: [{ workflowId: 'finish', open: true,
      actions: [{ id: 'finish-again', requiresCommit: true }], rounds: [{ steps: [{ state: 'waits', body: { kind: 'commit', vcs: 'svn', scopeRoot: f.root, repositories } }] }] }] } }] }
    f.deps.workflow = new VersioningWorkflowAccess({ snapshot: () => snapshot as never, finishWorktreeSession: vi.fn() })
    f.deps.sessions.proposeWorktreeReady = vi.fn(async () => {})
    return repositories
  }

  it('refuses a proposal for a repository whose message a person wrote in the open Finish review (UA1-J12-5)', async () => {
    const f = await fixture()
    finishRepositories(f)
    const before = f.manager.read('window', f.draftId)!
    expect(f.manager.edit('window', { draftId: f.draftId, epoch: before.epoch!, expectedRevision: before.revision,
      repositoryMessage: { root: f.root, message: '[j12] Person text' } }, 'person-local')).toMatchObject({ ok: true })
    expect(await f.manager.propose('session', f.root, '[j12] Agent proposal B')).toMatchObject({ ok: false, code: 'message-edited',
      detail: expect.stringContaining('the proposal was not stored') })
    const after = f.manager.read('window', f.draftId)!
    expect(after.repositories?.[0]).toMatchObject({ message: '[j12] Person text', source: 'person-local' })
    expect(after.message).toBe('proposal')
    expect(f.deps.sessions.proposeWorktreeReady).not.toHaveBeenCalled()
  })

  it('shows a later proposal in the repository field of the open Finish review with the findings of its own text (UA1-J12-2, UA1-J12-5)', async () => {
    const f = await fixture()
    finishRepositories(f)
    const before = f.manager.read('window', f.draftId)!
    // A person's edit of the other repository saves every row of the review in the draft.
    expect(f.manager.edit('window', { draftId: f.draftId, epoch: before.epoch!, expectedRevision: before.revision,
      repositoryMessage: { root: join(f.root, 'lib', 'ea'), message: '[j12] EA text' } }, 'person-local')).toMatchObject({ ok: true })
    expect(await f.manager.propose('session', f.root, 'Here is the commit message for the change:\n[j12] Agent proposal B')).toEqual({ ok: true, scopeRoot: f.root })
    const after = f.manager.read('window', f.draftId)!
    expect(after.repositories?.map(({ message, source }) => ({ message, source }))).toEqual([
      { message: 'Here is the commit message for the change:\n[j12] Agent proposal B', source: 'agent-proposal' },
      { message: '[j12] EA text', source: 'person-local' },
    ])
    expect(after.repositories?.[0].findings).toEqual([
      { id: 'no-prefix', text: 'No [Project] prefix', confirm: true }, { id: 'chat-opening', text: 'Chat opening', confirm: true },
    ])
  })

  // Mirabia 113: `message-edited` answered an empty repository field because of the review's own flag (2026-10-30).
  it('judges a multi-repository Finish proposal by its repository field, not by the hidden review message', async () => {
    const f = await fixture()
    finishRepositories(f)
    f.manager.setMessage('window', f.draftId, '[j12] Hidden review text')
    expect(f.manager.read('window', f.draftId)).toMatchObject({ editedByPerson: true })
    expect(await f.manager.propose('session', f.root, '[j12] Agent proposal B')).toEqual({ ok: true, scopeRoot: f.root })
    expect(f.manager.read('window', f.draftId)?.repositories?.[0]).toMatchObject({ message: '[j12] Agent proposal B', source: 'agent-proposal' })
    expect(f.deps.sessions.proposeWorktreeReady).toHaveBeenCalledWith('session')
  })

  it('stores a proposal into a repository field the person emptied or left at its prefix', async () => {
    const f = await fixture()
    finishRepositories(f)
    const before = f.manager.read('window', f.draftId)!
    expect(f.manager.edit('window', { draftId: f.draftId, epoch: before.epoch!, expectedRevision: before.revision,
      repositoryMessage: { root: f.root, message: '[j12] ' } }, 'person-local')).toMatchObject({ ok: true })
    expect(await f.manager.propose('session', f.root, '[j12] Agent proposal B')).toEqual({ ok: true, scopeRoot: f.root })
    expect(f.manager.read('window', f.draftId)?.repositories?.[0]).toMatchObject({ message: '[j12] Agent proposal B', source: 'agent-proposal' })
  })

  it('stores a proposal over an empty message an older build kept as edited by a person', async () => {
    const f = await fixture()
    expect(f.deps.messages.save({ sessionId: 'worker', vcs: 'svn', scopeRoot: f.root, message: '', editedByPerson: true, proposedByAgent: false,
      messageSource: 'person-local', messageAt: 1 })).toBe(true)
    expect(await f.manager.propose('worker', f.root, 'Fix orders')).toEqual({ ok: true, scopeRoot: f.root })
    expect(f.manager.proposalOf('worker', f.root)).toBe('Fix orders')
  })

  // CVUT 031 and 034: `[worker-agent]` was refused only at Publish, three times (2026-10-30).
  it('refuses a proposal under another prefix than its repository row expects, and stores nothing', async () => {
    const f = await fixture()
    finishRepositories(f)
    expect(await f.manager.propose('session', f.root, '[worker-agent] Refactor wave 1')).toEqual({ ok: false, code: 'message-prefix',
      detail: 'j12: message must start with [j12]; the proposal was not stored' })
    expect(f.manager.read('window', f.draftId)?.repositories?.[0]).toMatchObject({ message: '[j12] Agent proposal A', source: 'agent-proposal' })
    expect(f.manager.proposalOf('session', f.root)).toBe('proposal')
    expect(f.deps.sessions.proposeWorktreeReady).not.toHaveBeenCalled()
    expect(await f.manager.propose('session', f.root, 'Refactor wave 1')).toEqual({ ok: true, scopeRoot: f.root })
  })

  it('keeps the message written for each repository while a review leaves that repository out and edits another', async () => {
    const f = await fixture()
    const repositories = [f.root, join(f.root, 'shared')].map((root, index) => ({ root, repository: `https://svn/repo${index}`,
      repositoryName: `repo${index}`, expectedPrefix: `[repo${index}]`, paths: ['a.txt'], message: '', source: 'unknown' as const, acknowledged: [] }))
    const shown = [...repositories]
    const snapshot = { revision: 7, sessions: [{ sessionId: 'session', actions: { sections: [{ workflowId: 'finish', open: true,
      actions: [{ id: 'finish-again', requiresCommit: true }], rounds: [{ steps: [{ state: 'waits', body: { kind: 'commit', vcs: 'svn', scopeRoot: f.root, repositories: shown } }] }] }] } }] }
    f.deps.workflow = new VersioningWorkflowAccess({ snapshot: () => snapshot as never, finishWorktreeSession: vi.fn() })
    const edit = (root: string, message: string) => {
      const draft = f.manager.read('window', f.draftId)!
      expect(f.manager.edit('window', { draftId: f.draftId, epoch: draft.epoch!, expectedRevision: draft.revision, repositoryMessage: { root, message } }, 'person-local'))
        .toMatchObject({ ok: true })
    }
    edit(repositories[1].root, '[repo1] Shared change')
    shown.splice(1, 1)
    edit(f.root, '[repo0] App change')
    shown.push(repositories[1])
    expect(f.manager.read('window', f.draftId)?.repositories?.map(({ message, source }) => ({ message, source }))).toEqual([
      { message: '[repo0] App change', source: 'person-local' }, { message: '[repo1] Shared change', source: 'person-local' },
    ])
  })

  it.each(['person-local', 'person-remote'] as const)('saves repository text through the source draft before %s Finish approval', async (source) => {
    const f = await finishFixture()
    const repositories = [f.root, join(f.root, 'shared')].map((root, index) => ({ root, repository: `https://svn/repo${index}`,
      repositoryName: `repo${index}`, expectedPrefix: `[repo${index}]`, paths: ['a.txt'], message: `[repo${index}] Original`, source: 'agent-proposal' as const, acknowledged: [] }))
    const snapshot = { revision: 7, sessions: [{ sessionId: 'session', actions: { sections: [{ workflowId: 'finish', open: true,
      actions: [{ id: 'finish-again', requiresCommit: true }], rounds: [{ steps: [{ state: 'waits', body: { kind: 'commit', vcs: 'svn', scopeRoot: f.root, repositories } }] }] }] } }] }
    const finishWorktreeSession = vi.fn(async () => ({ ok: true as const, value: { sessionId: 'session', actionId: 'finish' } }))
    f.deps.workflow = new VersioningWorkflowAccess({ snapshot: () => snapshot as never, finishWorktreeSession })
    const before = f.manager.read('window', f.draftId)!
    expect(before.repositories?.map((row) => row.source)).toEqual(['agent-proposal', 'agent-proposal'])
    const edited = f.manager.edit('window', { draftId: f.draftId, epoch: before.epoch!, expectedRevision: before.revision,
      repositoryMessage: { root: f.root, message: '[repo0] Edited' } }, source)
    expect(edited).toMatchObject({ ok: true })
    const draft = f.manager.read('window', f.draftId)!
    expect(draft.repositories?.map((row) => row.source)).toEqual([source, 'agent-proposal'])
    expect(draft.repositories?.[0].findings).toEqual([])
    const decision = { ...f.decision, epoch: draft.epoch!, expectedRevision: draft.revision,
      workflow: { ...f.decision.workflow, repositories: draft.repositories } }
    expect(await f.manager.decide(f.interaction, decision)).toMatchObject({ ok: true })
    expect(finishWorktreeSession).toHaveBeenCalledWith('session', expect.objectContaining({ repositories: draft.repositories }))
  })

  it('preserves a peer-edited message through local source Finish approval and persisted drafts', async () => {
    const f = await finishFixture()
    const snapshot = { revision: 7, sessions: [{ sessionId: 'session', actions: { sections: [{ workflowId: 'finish', open: true, summary: 'Review the synced changes',
      actions: [{ id: 'finish-again', requiresCommit: true }], rounds: [{ steps: [{ state: 'waits', body: { kind: 'commit', vcs: 'svn', scopeRoot: f.root } }] }] }] } }] }
    const finishWorktreeSession = vi.fn(async () => ({ ok: true as const, value: { sessionId: 'session', actionId: 'finish' } }))
    f.deps.workflow = new VersioningWorkflowAccess({ snapshot: () => snapshot as never, finishWorktreeSession })
    const interactions = new ReviewInteractionAccess()
    f.deps.interactions = interactions
    const view = { peerId: 'paired-peer', sessionId: 'session', viewId: 'view', viewerId: 'controller', epoch: 'connection', commitReceipts: true as const }
    const remote = new RemoteReviewAccess(f.manager, interactions, { workingTree: vi.fn(async () => ({ ok: true as const, value: f.snapshot })) }, () => true, vi.fn())
    const request = async (body: Parameters<typeof remote.request>[1]) => {
      const answer = await remote.request(view, body)
      if (!answer.ok) throw new Error(answer.error.detail)
      return JSON.parse(Buffer.from(answer.value.base64, 'base64').toString('utf8'))
    }
    expect(await request({ kind: 'open', reviewId: f.draftId })).toMatchObject({ ok: true })
    const before = f.manager.read('window', f.draftId)!
    expect(await request({ kind: 'edit', edit: { draftId: f.draftId, epoch: before.epoch!, expectedRevision: before.revision,
      message: '[repository] Remote Finish text\r\nSecond line' } })).toMatchObject({ ok: true })
    const edited = f.manager.read('window', f.draftId)!
    expect(edited).toMatchObject({ message: '[repository] Remote Finish text\nSecond line', messageSource: 'person-remote' })
    const stored = await readFile(f.messageFile, 'utf8')
    expect(f.deps.reviews!.read()[0]?.dto).toMatchObject({ messageSource: 'person-remote', messageAt: edited.messageAt })
    expect(await f.manager.decide(interactions.local('window', 'session', () => true), { ...f.decision,
      message: edited.message.replace(/\n/g, '\r\n'), epoch: edited.epoch!, expectedRevision: edited.revision })).toMatchObject({ ok: true })
    expect(finishWorktreeSession).toHaveBeenCalledWith('session', expect.objectContaining({ message: edited.message, messageSource: 'person-remote' }))
    expect(f.manager.read('window', f.draftId)).toMatchObject({ messageSource: 'person-remote', messageAt: edited.messageAt })
    expect(await readFile(f.messageFile, 'utf8')).toBe(stored)
    expect(f.deps.reviews!.read()[0]?.dto).toMatchObject({ messageSource: 'person-remote', messageAt: edited.messageAt })
    expect(f.writes).toEqual([])
  })

  it.each(['svn', 'git'] as const)('claims one %s Finish, retains its lock after detach, and restores its source outcome', async (vcs) => {
    const f = await finishFixture(vcs)
    const first = f.manager.decide(f.interaction, f.decision)
    expect(f.manager.decide(f.interaction, { ...f.decision })).toBe(first)
    expect(await f.manager.decide(f.interaction, { ...f.decision, operationId: 'second' })).toMatchObject({ ok: false, code: 'busy' })
    expect(await first).toEqual({ ok: true, revision: '' })
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ message: f.decision.message }), f.decision.workflow, [f.path], { [f.path]: f.fingerprint })
    expect(f.writes).toEqual([])
    f.manager.release(f.draftId, 'window')
    const sibling = await f.manager.prepare('session', vcs, f.path, 'Other review')
    if (!sibling.ok) throw new Error(sibling.detail)
    f.manager.attach(sibling.value.draftId, 'window')
    expect(await f.manager.run('window', { ...f.request, draftId: sibling.value.draftId })).toMatchObject({ ok: false, code: 'busy' })
    const restored = new VersioningCommitManager(f.deps)
    restored.attach(f.draftId, 'new-view')
    expect(restored.read('new-view', f.draftId)?.phase.kind).toBe('running')
    f.state({ kind: 'done', revision: vcs === 'svn' ? 'r43' : 'abc123', output: 'Source receipt' })
    expect(restored.status(f.draftId)).toMatchObject({ state: 'committed', revision: vcs === 'svn' ? 'r43' : 'abc123' })
    expect(await restored.decide(f.interaction, f.decision)).toEqual({ ok: true, revision: vcs === 'svn' ? 'r43' : 'abc123' })
    f.state({ kind: 'uncertain', detail: 'Source session was removed after completion' })
    const settled = new VersioningCommitManager(f.deps)
    expect(settled.status(f.draftId)).toMatchObject({ state: 'committed', revision: vcs === 'svn' ? 'r43' : 'abc123' })
    expect(await settled.decide(f.interaction, f.decision)).toEqual({ ok: true, revision: vcs === 'svn' ? 'r43' : 'abc123' })
    expect(f.start).toHaveBeenCalledTimes(1)
  })

  // 13 Finish drafts stayed running with an empty receipt once nobody read them again (2026-10-30).
  it('closes an unshown Finish review once its Finish committed, with the revision on its receipt, also after a restart', async () => {
    const f = await finishFixture()
    expect(await f.manager.decide(f.interaction, f.decision)).toEqual({ ok: true, revision: '' })
    f.manager.release(f.draftId, 'window')
    expect(f.deps.reviews!.read()[0]).toMatchObject({ dto: { phase: { kind: 'running' } }, decisions: [expect.objectContaining({ result: { ok: true, revision: '' } })] })
    f.state({ kind: 'done', revision: 'r43', output: 'Published' })
    const restored = new VersioningCommitManager(f.deps)
    expect(restored.openSessions().reviews).toHaveLength(1)
    restored.workflowChanged()
    expect(restored.openSessions().reviews).toEqual([])
    expect(restored.status(f.draftId)).toMatchObject({ state: 'committed', revision: 'r43', closed: true })
    expect(f.deps.reviews!.read()[0]).toMatchObject({ closedAt: expect.any(Number),
      decisions: [expect.objectContaining({ result: { ok: true, revision: 'r43' } })] })
  })

  it('leaves a Finish review open while a pane shows it', async () => {
    const f = await finishFixture()
    expect(await f.manager.decide(f.interaction, f.decision)).toEqual({ ok: true, revision: '' })
    f.state({ kind: 'done', revision: 'r43', output: 'Published' })
    f.manager.workflowChanged()
    expect(f.deps.reviews!.read()[0].closedAt).toBeUndefined()
    // The approval answered before the Finish published; the shown pane learns the end from the sessions.
    expect(f.deps.reviews!.read()[0].dto.phase).toMatchObject({ kind: 'done', revision: 'r43' })
  })

  it('closes an unshown Finish review whose session is gone, and keeps one whose Finish still runs', async () => {
    const f = await finishFixture()
    expect(await f.manager.decide(f.interaction, f.decision)).toEqual({ ok: true, revision: '' })
    f.manager.release(f.draftId, 'window')
    let gone = false
    f.deps.workflow!.abandoned = () => gone
    const restored = new VersioningCommitManager(f.deps)
    restored.workflowChanged()
    expect(restored.openSessions().reviews).toHaveLength(1)
    gone = true
    f.state({ kind: 'uncertain', detail: 'The original Finish outcome is not available.' })
    restored.workflowChanged()
    expect(restored.openSessions().reviews).toEqual([])
    expect(restored.status(f.draftId)).toMatchObject({ state: 'failed', closed: true })
    expect(f.deps.reviews!.read()[0].closedAt).toEqual(expect.any(Number))
  })

  it('leaves a refused Finish approval editable, so the refusal does not outlive the next preparation', async () => {
    const f = await finishFixture()
    const detail = 'Repository changes require a new preparation and confirmation: lib/ea/version.txt'
    f.start.mockResolvedValue({ ok: false, code: 'vcs-failed', detail } as never)
    expect(await f.manager.decide(f.interaction, f.decision)).toEqual({ ok: false, code: 'vcs-failed', detail })
    expect(f.manager.read('window', f.draftId)?.phase).toEqual({ kind: 'editing' })
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'editing' })
  })

  it('names every changed file of a stale Finish review and leaves the wording to the Finish', async () => {
    const f = await finishFixture()
    f.deps.workflow!.changed = (paths) => `Changed: ${paths.join(', ')}`
    const second = await addSecondFile(f)
    const fingerprints: Record<string, string> = { [f.path]: f.fingerprint, [second.path]: await FileChangesFingerprint.of(second.path) }
    const access = f.deps.fileAccess
    f.deps.fileAccess = (...args) => {
      const result = access(...args)
      return result.ok ? { ok: true, value: { ...result.value, workingState: { ...result.value.workingState!, fingerprint: fingerprints[result.value.path] } } } : result
    }
    f.manager.files('window', f.draftId, f.snapshot)
    const draft = f.manager.read('window', f.draftId)!
    const edited = f.manager.edit('window', { draftId: f.draftId, epoch: draft.epoch!, expectedRevision: draft.revision,
      selection: { snapshotId: 'snapshot', fileIds: ['file', 'second'] } })
    if (!edited.ok) throw new Error(edited.detail)
    for (const path of [f.path, second.path]) {
      const stamp = await lstat(path)
      await writeFile(path, 'other bytes')
      await utimes(path, stamp.atime, stamp.mtime)
    }
    expect(await f.manager.decide(f.interaction, { ...f.decision, fileIds: ['file', 'second'], epoch: edited.value.epoch!,
      expectedRevision: edited.value.revision, operationId: 'stale' })).toEqual({ ok: false, code: 'stale', detail: 'Changed: file.txt, second.txt' })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('selects a path that appears in a Finish review after its selection was saved, and keeps a cleared path cleared', async () => {
    const f = await finishFixture()
    f.deps.workflow!.owns = () => true
    const draft = f.manager.read('window', f.draftId)!
    expect(f.manager.edit('window', { draftId: f.draftId, epoch: draft.epoch!, expectedRevision: draft.revision,
      selection: { snapshotId: 'snapshot', fileIds: [] } })).toMatchObject({ ok: true })
    const second = await addSecondFile(f)
    f.manager.files('window', f.draftId, f.snapshot)
    expect(f.manager.read('window', f.draftId)?.selection).toEqual({ snapshotId: 'snapshot', paths: [second.path] })
    f.manager.files('window', f.draftId, f.snapshot)
    expect(f.manager.read('window', f.draftId)?.selection?.paths).toEqual([second.path])
  })

  it('keeps the saved selection of a plain commit dialog when a new path appears', async () => {
    const f = await fixture()
    f.manager.files('window', f.draftId, f.snapshot)
    await addSecondFile(f)
    f.manager.files('window', f.draftId, f.snapshot)
    expect(f.manager.read('window', f.draftId)?.selection?.paths).toEqual([f.path])
  })

  it.each(['changed-action', 'changed-bytes', 'revoked-view'] as const)('refuses %s before the source Finish is accepted', async (reason) => {
    const f = await finishFixture()
    if (reason === 'changed-action') f.check.mockReturnValue('Finish changed')
    else if (reason === 'changed-bytes') {
      const stamp = await lstat(f.path)
      await writeFile(f.path, 'other bytes')
      await utimes(f.path, stamp.atime, stamp.mtime)
    } else if (reason === 'revoked-view') f.deps.interactions = { isActive: () => false }
    else throw new Error(`Unknown reason: ${reason satisfies never}`)
    expect(await f.manager.decide(f.interaction, f.decision)).toMatchObject({ ok: false })
    expect(f.start).not.toHaveBeenCalled()
    expect(f.writes).toEqual([])
  })

  it('keeps an unproved Finish acceptance uncertain instead of replaying it after restart', async () => {
    const f = await finishFixture()
    f.start.mockRejectedValue(new Error('source callback interrupted'))
    expect(await f.manager.decide(f.interaction, f.decision)).toMatchObject({ ok: false, code: 'uncertain' })
    const restored = new VersioningCommitManager(f.deps)
    restored.attach(f.draftId, 'window')
    const draft = restored.read('window', f.draftId)!
    expect(await restored.decide(f.interaction, { ...f.decision, epoch: draft.epoch!, expectedRevision: draft.revision, operationId: 'new-id' })).toMatchObject({ ok: false })
    expect(f.start).toHaveBeenCalledTimes(1)
  })

  it('reconciles a lost Finish acknowledgement to the proved source result without executing again', async () => {
    const f = await finishFixture()
    f.start.mockRejectedValue(new Error('Source acknowledgement lost'))
    expect(await f.manager.decide(f.interaction, f.decision)).toMatchObject({ ok: false, code: 'uncertain' })
    f.state({ kind: 'done', revision: 'r48', output: 'Verified source receipt' })
    const restored = new VersioningCommitManager(f.deps)
    expect(await restored.decide(f.interaction, f.decision)).toEqual({ ok: true, revision: 'r48' })
    expect(restored.status(f.draftId)).toMatchObject({ state: 'committed', revision: 'r48' })
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.writes).toEqual([])
  })

  it('reconciles a lost acknowledgement to a source conflict that needs a fresh review', async () => {
    const f = await finishFixture()
    f.start.mockRejectedValue(new Error('Source acknowledgement lost'))
    await f.manager.decide(f.interaction, f.decision)
    f.state({ kind: 'waiting', detail: 'Resolve the incoming source conflict' })
    const restored = new VersioningCommitManager(f.deps)
    expect(await restored.decide(f.interaction, f.decision)).toEqual({ ok: false, code: 'vcs-failed', detail: 'Resolve the incoming source conflict' })
    expect(restored.status(f.draftId)).toMatchObject({ state: 'failed' })
    expect(f.start).toHaveBeenCalledOnce()
  })

  it.each(['live', 'restarted'] as const)('frees a %s review whose Finish a corrective review replaced, so the corrective review publishes', async (client) => {
    const f = await finishFixture()
    const waiting = (workflowId: string) => ({ workflowId, kind: 'finish', open: true, summary: 'Ready for validation',
      actions: [{ id: 'finish-again', requiresCommit: true }], rounds: [{ steps: [{ state: 'waits', body: { kind: 'commit', vcs: 'svn', scopeRoot: f.root } }] }] })
    const sections: ReturnType<typeof waiting>[] = [waiting('finish')]
    const snapshot = { revision: 7, sessions: [{ sessionId: 'session', actions: { sections } }] }
    const finishWorktreeSession = vi.fn(async () => {
      sections[0] = { ...sections[0], summary: 'Committing', actions: [], rounds: [{ steps: [{ ...sections[0].rounds[0].steps[0], state: 'running' }] }] }
      return { ok: true as const, value: { sessionId: 'session', actionId: 'finish' } }
    })
    f.deps.workflow = new VersioningWorkflowAccess({ snapshot: () => snapshot as never, finishWorktreeSession })
    expect(await f.manager.decide(f.interaction, f.decision)).toEqual({ ok: true, revision: '' })
    // Published with differences, then Review corrective changes: the source closes the first action and opens a new one.
    sections.splice(0, 1, { ...sections[0], open: false, summary: 'Action ended' }, waiting('corrective'))
    const manager = client === 'live' ? f.manager : new VersioningCommitManager(f.deps)
    manager.attach(f.draftId, 'window')
    const draft = manager.read('window', f.draftId)!
    expect(draft).toMatchObject({ phase: { kind: 'editing' } })
    expect(draft.workflow).toBeUndefined()
    const edited = manager.edit('window', { draftId: f.draftId, epoch: draft.epoch!, expectedRevision: draft.revision,
      selection: { snapshotId: 'snapshot', fileIds: ['file'] } })
    if (!edited.ok) throw new Error(edited.detail)
    expect(await manager.decide(f.interaction, { ...f.decision, epoch: edited.value.epoch!, expectedRevision: edited.value.revision,
      operationId: 'corrective-press', workflow: { ...f.decision.workflow, workflowId: 'corrective' } })).toEqual({ ok: true, revision: '' })
    expect(finishWorktreeSession).toHaveBeenCalledTimes(2)
    expect(manager.read('window', f.draftId)?.workflow?.workflowId).toBe('corrective')
  })

  it('claims concurrent human approvals once and returns the original receipt after response loss', async () => {
    const f = await fixture()
    const { interaction, request } = await admitted(f)
    const first = f.manager.decide(interaction, request)
    const replay = f.manager.decide(interaction, { ...request })
    expect(replay).toBe(first)
    expect(await f.manager.decide(interaction, { ...request, operationId: 'second-press' })).toMatchObject({ ok: false, code: 'busy' })
    expect(await first).toEqual({ ok: true, revision: '42' })
    expect(await f.manager.decide(interaction, request)).toEqual({ ok: true, revision: '42' })
    expect(await f.manager.decide(interaction, { ...request, message: 'Changed replay' })).toMatchObject({ ok: false, code: 'conflict' })
    expect(f.writes).toHaveLength(1)
  })

  it('refuses forged, stale and revoked human approval before any source write', async () => {
    const f = await fixture()
    let active = true
    const { interaction, request } = await admitted(f, () => active)
    expect(await f.manager.decide({ ...interaction }, request)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await f.manager.decide(interaction, { ...request, expectedRevision: request.expectedRevision - 1 })).toMatchObject({ ok: false, code: 'stale' })
    const pending = f.manager.decide(interaction, request)
    active = false
    expect(await pending).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.writes).toEqual([])
  })

  it.each(['approve', 'cancel'] as const)('accepts only the first %s in an approval/cancellation race', async (first) => {
    const f = await fixture()
    const { interaction, request } = await admitted(f)
    const cancel = { draftId: f.draftId, epoch: request.epoch, expectedRevision: request.expectedRevision, operationId: 'cancel', kind: 'cancel' as const }
    const pending = f.manager.decide(interaction, first === 'approve' ? request : cancel)
    expect(await f.manager.decide(interaction, first === 'approve' ? cancel : request)).toMatchObject({ ok: false, code: 'busy' })
    expect(await pending).toMatchObject({ ok: true })
    expect(f.writes).toHaveLength(first === 'approve' ? 1 : 0)
    if (first === 'cancel') {
      const fresh = f.manager.read('window', f.draftId)!
      expect(await f.manager.decide(interaction, { ...request, operationId: 'fresh', expectedRevision: fresh.revision })).toMatchObject({ ok: false, code: 'busy' })
    }
  })

  it('refuses stale revert, claims exact targets once, and keeps accepted work after detach', async () => {
    const f = await fixture()
    const { interaction, request } = await admitted(f)
    const revert = { draftId: f.draftId, epoch: request.epoch, expectedRevision: request.expectedRevision, operationId: 'revert', kind: 'revert' as const, snapshotId: 'snapshot', fileIds: ['file'], confirmed: true as const }
    expect(await f.manager.decide(interaction, { ...revert, expectedRevision: request.expectedRevision - 1 })).toMatchObject({ ok: false, code: 'stale' })
    expect(f.writes).toEqual([])
    f.deps.svn.revertFile = vi.fn(async (_scope, path) => {
      expect(path).toBe(f.path)
      expect(f.manager.read('window', f.draftId)?.phase.kind).toBe('running')
      expect(await f.manager.decide(interaction, { draftId: f.draftId, epoch: request.epoch, expectedRevision: request.expectedRevision, operationId: 'cancel-running', kind: 'cancel' })).toMatchObject({ ok: false, code: 'busy' })
      f.manager.release(f.draftId, 'window')
      return { ok: true as const, value: undefined }
    })
    expect(await f.manager.decide(interaction, revert)).toEqual({ ok: true, revision: '' })
    expect(await f.manager.decide(interaction, revert)).toEqual({ ok: true, revision: '' })
    expect(f.deps.svn.revertFile).toHaveBeenCalledTimes(1)
  })

  it('binds external review paths and keeps shared running/closed state without inventing publication', async () => {
    const f = await fixture()
    const { interaction, request } = await admitted(f)
    const external = { ...request, kind: 'external-review' as const }
    let finish!: () => void
    const closed = new Promise<void>((resolve) => { finish = resolve })
    f.deps.tortoise.open = vi.fn(async (input) => {
      expect(input.paths).toEqual([f.path])
      expect(await readFile(input.messageFile, 'utf8')).toBe(request.message)
      return { ok: true as const, closed }
    })
    const pending = f.manager.decide(interaction, external)
    await vi.waitFor(() => expect(f.deps.tortoise.open).toHaveBeenCalledTimes(1))
    expect(f.manager.read('window', f.draftId)?.externalReview).toBe('running')
    expect(await f.manager.decide(interaction, { kind: 'cancel', draftId: f.draftId, epoch: request.epoch, expectedRevision: request.expectedRevision, operationId: 'cancel-external' })).toMatchObject({ ok: false, code: 'busy' })
    finish()
    expect(await pending).toEqual({ ok: true, revision: '' })
    expect(f.manager.read('window', f.draftId)).toMatchObject({ externalReview: 'closed', phase: { kind: 'editing' } })
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'external-closed', revision: null })
    expect(await f.manager.decide(interaction, external)).toEqual({ ok: true, revision: '' })
    expect(f.deps.tortoise.open).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('hands recursive external directories over only with every displayed descendant selected (%s)', async (includeChild) => {
    const f = await fixture()
    const opened = await f.manager.prepare('session', 'svn', null, 'Recursive', [{ path: f.root, depth: 'infinity' }])
    if (!opened.ok) throw new Error(opened.detail)
    f.draftId = opened.value.draftId
    f.manager.attach(f.draftId, 'window')
    const stamp = Math.round((await lstat(f.root)).mtimeMs)
    f.snapshot.entries = [{ ...f.snapshot.entries[0], fileId: 'directory', path: f.root, displayPath: '.', nodeKind: 'directory', modifiedAt: stamp }, ...f.snapshot.entries]
    const fileAccess = f.deps.fileAccess
    f.deps.fileAccess = (owner, id, file) => file === 'directory'
      ? { ok: true, value: { sessionId: 'session', cwd: f.root, path: f.root, nodeKind: 'directory', status: 'modified', workingState: { modifiedAt: stamp, vcsEntry: true } } }
      : fileAccess(owner, id, file)
    f.manager.files('window', f.draftId, f.snapshot)
    const before = f.manager.read('window', f.draftId)!
    const fileIds = includeChild ? ['directory', 'file'] : ['directory']
    const edit = f.manager.edit('window', { draftId: f.draftId, epoch: before.epoch!, expectedRevision: before.revision, selection: { snapshotId: 'snapshot', fileIds } })
    if (!edit.ok) throw new Error(edit.detail)
    const access = new ReviewInteractionAccess()
    f.deps.interactions = access
    f.deps.tortoise.open = vi.fn(async () => ({ ok: true as const, closed: Promise.resolve() }))
    const result = await f.manager.decide(access.local('window', 'session', () => true), { kind: 'external-review', draftId: f.draftId,
      epoch: before.epoch!, expectedRevision: edit.value.revision, operationId: 'recursive', snapshotId: 'snapshot', fileIds, message: edit.value.message })
    expect(result.ok).toBe(includeChild)
    if (includeChild) expect(f.deps.tortoise.open).toHaveBeenCalledWith(expect.objectContaining({ paths: [f.root] }))
    else {
      expect(result).toMatchObject({ ok: false, code: 'invalid-target', detail: expect.stringContaining('every displayed descendant') })
      expect(f.deps.tortoise.open).not.toHaveBeenCalled()
    }
  })

  it('routes only a current owned external diff and advertises the source tool independently', async () => {
    const f = await fixture()
    const { interaction, request } = await admitted(f)
    f.snapshot.defaultBaseline = { baselineId: 'base', kind: 'svn-base', revision: null, label: 'BASE', createdAt: null }
    f.manager.files('window', f.draftId, f.snapshot)
    f.deps.externalDiffAvailable = () => true
    f.deps.externalDiff = vi.fn(async () => ({ ok: true as const }))
    const diff = { kind: 'external-diff' as const, draftId: f.draftId, epoch: request.epoch, expectedRevision: f.manager.read('window', f.draftId)!.revision, operationId: 'diff', snapshotId: 'snapshot', fileId: 'file', baselineId: 'base' }
    expect(f.manager.read('window', f.draftId)?.externalDiffAvailable).toBe(true)
    expect(await f.manager.decide(interaction, { ...diff, baselineId: 'foreign' })).toMatchObject({ ok: false, code: 'invalid-target' })
    expect(await f.manager.decide(interaction, diff)).toEqual({ ok: true, revision: '' })
    expect(await f.manager.decide(interaction, diff)).toEqual({ ok: true, revision: '' })
    expect(f.deps.externalDiff).toHaveBeenCalledExactlyOnceWith('window', { snapshotId: 'snapshot', fileId: 'file', baselineId: 'base' })
  })

  it('persists intent before publication and preserves its result through a new store instance', async () => {
    const f = await fixture()
    const file = join(f.root, 'reviews.json')
    f.deps.reviews = new VersioningReviewStore(file, f.report)
    const { interaction, request } = await admitted(f)
    f.deps.svn.commit = vi.fn(async () => {
      const saved = new VersioningReviewStore(file, f.report).read()[0]
      expect(saved.decisions).toMatchObject([{ operationId: request.operationId, actorId: interaction.actorId }])
      expect(saved.decisions?.[0].result).toBeUndefined()
      return { ok: true as const, value: { committedPaths: [f.path], revision: '44', output: 'Committed' } }
    })
    expect(await f.manager.decide(interaction, request)).toEqual({ ok: true, revision: '44' })
    const restored = new VersioningReviewStore(file, f.report).read()[0]
    expect(restored.decisions?.[0].result).toEqual({ ok: true, revision: '44' })
    expect(restored.committedPaths).toEqual([f.path])
  })

  it.each(['source', 'peer'] as const)('shares a CLI review and its outside-scope source files; %s approves once', async (winner) => {
    const f = await fixture()
    const origin = join(f.root, 'session-origin')
    await mkdir(origin)
    await f.manager.cancel(f.draftId)
    f.manager.release(f.draftId, 'window')
    f.deps.sessions.workingContext = async () => ({ ok: true, value: { sessionId: 'session', cwd: origin, agent: null, worktree: null } })
    const prepared = await f.manager.prepare('session', 'svn', f.root, 'Outside project')
    if (!prepared.ok) throw new Error(prepared.detail)
    f.draftId = prepared.value.draftId
    f.request.draftId = f.draftId
    f.manager.attach(f.draftId, 'window')
    const interactions = new ReviewInteractionAccess()
    f.deps.interactions = interactions
    const originalFile = f.deps.fileAccess
    f.deps.fileAccess = (_owner, snapshotId, id) => originalFile('window', snapshotId, id)
    const view = { peerId: 'paired-peer', sessionId: 'session', viewId: 'view', viewerId: 'controller', epoch: 'connection', commitReceipts: true as const }
    let live = true
    const admit = vi.fn()
    const files = { workingTree: vi.fn(async () => ({ ok: true as const, value: f.snapshot })) }
    const remote = new RemoteReviewAccess(f.manager, interactions, files, () => live, admit)
    const decode = async (request: Parameters<typeof remote.request>[1]) => {
      const page = await remote.request(view, request)
      if (!page.ok) throw new Error(page.error.detail)
      return JSON.parse(Buffer.from(page.value.base64, 'base64').toString('utf8'))
    }
    expect(await decode({ kind: 'open', reviewId: f.draftId })).toMatchObject({ ok: true, value: { draftId: f.draftId } })
    expect(await decode({ kind: 'files', reviewId: f.draftId })).toMatchObject({ ok: true, value: { snapshotId: 'snapshot' } })
    expect(files.workingTree).toHaveBeenCalledWith(RemoteContentAccess.owner(view), 'session', 'svn', f.root, true, undefined, undefined)
    expect(admit).toHaveBeenCalledWith(view, { kind: 'workspace', sessionId: 'session', path: f.path, workingTree: { scopeRoot: f.root, source: 'svn' } })
    const shared = f.manager.read('window', f.draftId)!
    const edit = { draftId: f.draftId, epoch: shared.epoch!, expectedRevision: shared.revision, message: 'Shared human text', selection: { snapshotId: 'snapshot', fileIds: ['file'] } }
    const edited = await decode({ kind: 'edit', edit })
    expect(edited).toMatchObject({ ok: true })
    expect(f.manager.read('window', f.draftId)?.message).toBe('Shared human text')
    const decision = { ...f.request, message: 'Shared human text', kind: 'approve' as const, operationId: 'one-human', epoch: shared.epoch!, expectedRevision: edited.value.revision }
    const result = winner === 'peer' ? await decode({ kind: 'decide', decision })
      : await f.manager.decide(interactions.local('window', 'session', () => true), decision)
    expect(result).toMatchObject({ ok: true, revision: '42' })
    expect(await decode({ kind: 'read', reviewId: f.draftId })).toMatchObject({ phase: { kind: 'done' } })
    expect(await decode({ kind: 'decide', decision: { ...decision, operationId: 'late-press' } })).toMatchObject({ ok: false })
    expect(f.writes).toHaveLength(1)
    live = false
    remote.release(view)
    expect(f.manager.status(f.draftId)?.state).toBe('committed')
  })

  it('keeps requested paths separate from actual SVN paths after the review closes', async () => {
    const f = await fixture()
    const unchanged = join(f.root, 'unchanged.txt')
    await writeFile(unchanged, 'already committed')
    const prepared = await f.manager.prepare('session', 'svn', null, null, [f.path, unchanged])
    if (!prepared.ok) throw new Error(prepared.detail)
    const draftId = prepared.value.draftId
    f.manager.attach(draftId, 'window')
    expect(f.manager.files('window', draftId, f.snapshot).warnings).toEqual([])
    f.deps.svn.commit = async () => ({ ok: true, value: { revision: '42', output: 'Committed', committedPaths: [f.path] } })
    expect(await f.manager.run('window', { ...f.request, draftId })).toMatchObject({ ok: true })
    f.manager.release(draftId, 'window')
    expect(f.manager.status(draftId)).toMatchObject({ state: 'committed', closed: true,
      paths: [f.path, unchanged].sort(), committedPaths: [f.path] })
    expect(f.manager.status(draftId)?.omittedPaths).toBeUndefined()
  })

  it('retains the revision and explicitly reports a selected changed path missing from the publication receipt', async () => {
    const f = await fixture()
    const file = join(f.root, 'reviews.json')
    f.deps.reviews = new VersioningReviewStore(file, f.report)
    f.deps.svn.commit = async () => ({ ok: true, value: { revision: '42', output: 'Committed', committedPaths: [] } })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: true, revision: '42' })
    expect(f.manager.read('window', f.draftId)?.published).toEqual([{ scopeRoot: f.root, revision: '42', paths: [], omittedPaths: [f.path] }])
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', revision: '42', omittedPaths: [f.path], detail: expect.stringContaining(f.path) })
    const restored = new VersioningReviewStore(file, f.report).read()[0]
    expect(restored.dto.published).toEqual([{ scopeRoot: f.root, revision: '42', paths: [], omittedPaths: [f.path] }])
  })

  describe('close lines for a review the CLI opened', () => {
    it('gives one line after the commit, settles it and keeps it settled across a restart', async () => {
      const f = await fixture()
      const file = join(f.root, 'reviews.json')
      f.deps.reviews = new VersioningReviewStore(file, f.report)
      f.deps.now = () => 1_000
      expect(await f.manager.prepare('session', 'svn', null, null, undefined, { wakeOnClose: true })).toMatchObject({ ok: true, value: { draftId: f.draftId } })
      const source = f.manager.notifySource()
      expect(source.pending()).toEqual([])
      expect(await f.manager.run('window', f.request)).toMatchObject({ ok: true })
      const line = `Jamat: commit review ${f.draftId} committed revision 42 in ${f.root}. Verify the result and finish your reply.`
      expect(source.pending()).toEqual([{ id: f.draftId, sessionId: 'session', text: line, at: 1_000, attempts: 0 }])
      await source.note([f.draftId], 'attempted', 2_000)
      expect(source.pending()).toMatchObject([{ attempts: 1 }])
      await source.note([f.draftId], 'delivered', 3_000)
      expect(source.pending()).toEqual([])
      expect(new VersioningCommitManager({ ...f.deps, reviews: new VersioningReviewStore(file, f.report) }).notifySource().pending()).toEqual([])
    })

    it('gives no line for a review a person opened', async () => {
      const f = await fixture()
      expect(await f.manager.run('window', f.request)).toMatchObject({ ok: true })
      expect(f.manager.notifySource().pending()).toEqual([])
    })

    it('waits for every pane to release a review the person cancelled', async () => {
      const f = await fixture()
      await f.manager.prepare('session', 'svn', null, null, undefined, { wakeOnClose: true })
      const { interaction, request } = await admitted(f)
      expect(await f.manager.decide(interaction, { kind: 'cancel', draftId: f.draftId, epoch: request.epoch, expectedRevision: request.expectedRevision,
        operationId: 'person-cancel' })).toMatchObject({ ok: true })
      expect(f.manager.status(f.draftId)?.closed).toBe(false)
      expect(f.manager.notifySource().pending()).toEqual([])
      f.manager.release(f.draftId, 'window')
      expect(f.manager.notifySource().pending()).toMatchObject([{ text: `Jamat: commit review ${f.draftId} in ${f.root} was cancelled; nothing was committed. Verify the result and finish your reply.` }])
    })

    // Codex i83: the agent's own `commit cancel` already answered cancelled, and the line started a needless turn (2026-10-30).
    it('gives no line for a review the agent cancelled with its own command, also after a restart', async () => {
      const f = await fixture()
      const file = join(f.root, 'reviews.json')
      f.deps.reviews = new VersioningReviewStore(file, f.report)
      await f.manager.prepare('session', 'svn', null, null, undefined, { wakeOnClose: true })
      expect(await f.manager.cancel(f.draftId)).toMatchObject({ ok: true, value: { state: 'cancelled' } })
      f.manager.release(f.draftId, 'window')
      expect(f.manager.status(f.draftId)).toMatchObject({ state: 'cancelled', closed: true })
      expect(f.manager.notifySource().pending()).toEqual([])
      expect(new VersioningCommitManager({ ...f.deps, reviews: new VersioningReviewStore(file, f.report) }).notifySource().pending()).toEqual([])
    })

    it('reports a failure only once the person closed its review, on one line', async () => {
      const f = await fixture()
      await f.manager.prepare('session', 'svn', null, null, undefined, { wakeOnClose: true })
      f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: 'E155004:\n  locked.' })
      expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false })
      expect(f.manager.notifySource().pending()).toEqual([])
      f.manager.release(f.draftId, 'window')
      expect(f.manager.notifySource().pending()).toMatchObject([{ text: `Jamat: commit review ${f.draftId} in ${f.root} failed: E155004: locked. Verify the result and finish your reply.` }])
    })

    it('shortens a long failure detail and keeps the line within the notifier limit', async () => {
      const f = await fixture()
      await f.manager.prepare('session', 'svn', null, null, undefined, { wakeOnClose: true })
      f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: `E155004 ${'x'.repeat(2_000)}` })
      await f.manager.run('window', f.request)
      f.manager.release(f.draftId, 'window')
      const [line] = f.manager.notifySource().pending()
      expect(line.text.length).toBeLessThanOrEqual(800)
      expect(line.text).toMatch(/failed: E155004 x+…\. Verify the result and finish your reply\.$/)
    })

    it('gives the line after a restart when the review settled before its first pass', async () => {
      const f = await fixture()
      const file = join(f.root, 'reviews.json')
      f.deps.reviews = new VersioningReviewStore(file, f.report)
      await f.manager.prepare('session', 'svn', null, null, undefined, { wakeOnClose: true })
      expect(await f.manager.run('window', f.request)).toMatchObject({ ok: true })
      const restored = new VersioningCommitManager({ ...f.deps, reviews: new VersioningReviewStore(file, f.report) })
      expect(restored.notifySource().pending()).toMatchObject([{ id: f.draftId, text: expect.stringContaining('committed revision 42') }])
    })
  })

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
    expect(await f.manager.cancel(f.draftId)).toMatchObject({ ok: true, value: { state: 'cancelled' } })
    expect(f.manager.read('window', f.draftId)?.phase.kind).toBe('cancelled')
    expect(f.manager.setMessage('window', f.draftId, 'Late edit')).toBe(false)
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'unknown-draft' })
    expect(await f.manager.openTortoise('window', f.draftId, 'Late handoff')).toMatchObject({ ok: false, code: 'unknown-draft' })
    expect(await f.manager.revert('window', { draftId: f.draftId, snapshotId: 'snapshot', fileId: 'file' }, async () => true))
      .toMatchObject({ ok: false, code: 'unknown-draft' })
    f.manager.release(f.draftId, 'window')
    expect(f.manager.status(f.draftId)?.closed).toBe(false)
    f.manager.release(f.draftId, 'second')
    expect(await cancelled).toMatchObject({ ok: true, value: { state: 'cancelled', revision: null } })
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
      expect(await cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } })
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

  it('keeps a pending review when its last owner closes, beyond result retention', async () => {
    const f = await fixture()
    let now = 100
    f.deps.now = () => now
    f.manager.attach(f.draftId, 'second')
    f.manager.release(f.draftId, 'window')
    expect(f.manager.status(f.draftId)?.state).toBe('editing')
    f.manager.revokeOwner('second')
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'editing', closed: true, revision: null })
    now += 86_400_000
    expect(f.manager.status(f.draftId)?.state).toBe('editing')
    expect(f.manager.status('unknown')).toBeNull()
  })

  it('keeps the actual running commit result when its window closes during the write', async () => {
    const f = await fixture()
    f.deps.svn.commit = async () => {
      f.manager.revokeOwner('window')
      expect(f.manager.status(f.draftId)).toMatchObject({ state: 'running', closed: true })
      return { ok: true, value: { committedPaths: [], revision: '43', output: 'Committed' } }
    }
    await f.manager.run('window', f.request)
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', closed: true, revision: '43' })
  })

  // A Finish waits for the outcome of the review it opens; an ended review still in its pane would
  // answer the old outcome at once.
  it('gives a caller that waits for a fresh review a new draft instead of one that ended in an open pane', async () => {
    const f = await fixture()
    await f.manager.run('window', f.request)
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', closed: false })
    expect(await f.manager.prepare('session', 'svn', null, 'Again')).toMatchObject({ ok: true, value: { draftId: f.draftId } })

    const fresh = await f.manager.prepare('session', 'svn', null, 'Next proposal', undefined, { fresh: true })
    if (!fresh.ok) throw new Error(fresh.detail)

    expect(fresh.value.draftId).not.toBe(f.draftId)
    expect(f.manager.status(fresh.value.draftId)).toMatchObject({ state: 'editing', closed: true })
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'committed', closed: true, revision: '42' })
    expect(f.manager.read('window', f.draftId)).toBeNull()
    // The pane finds its draft gone and opens the scope again.
    expect(await f.manager.prepare('session', 'svn', null, null)).toMatchObject({ ok: true, value: { draftId: fresh.value.draftId } })
  })

  it('replaces a review taken to Tortoise for a fresh caller and keeps one still open for editing', async () => {
    const f = await fixture()
    f.deps.tortoise.open = async () => ({ ok: true, closed: Promise.resolve() })
    expect(await f.manager.prepare('session', 'svn', null, 'Still editing', undefined, { fresh: true }))
      .toMatchObject({ ok: true, value: { draftId: f.draftId } })
    expect(await f.manager.openTortoise('window', f.draftId, 'Message')).toMatchObject({ ok: true })
    expect(f.manager.status(f.draftId)?.state).toBe('external-closed')

    const fresh = await f.manager.prepare('session', 'svn', null, 'Next proposal', undefined, { fresh: true })

    expect(fresh.ok && fresh.value.draftId).not.toBe(f.draftId)
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'external-closed', closed: true })
  })

  it('retains a failed commit after closing and allows a retry while still open', async () => {
    const f = await fixture()
    f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: 'locked' })
    await f.manager.run('window', f.request)
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'failed', closed: false, detail: 'locked' })
    f.manager.release(f.draftId, 'window')
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'failed', closed: true, revision: null })
  })

  // `commit propose`: a worker's message waits for the person's review; nothing opens and nothing commits.
  it('keeps a proposal for the working copy of a session without opening a review, also across a restart', async () => {
    const f = await fixture()
    f.deps.sessions.proposeWorktreeReady = vi.fn(async () => {})
    expect(await f.manager.propose('worker', f.root, 'Fix orders\r\n\r\nBody')).toEqual({ ok: true, scopeRoot: f.root })
    expect(f.deps.sessions.proposeWorktreeReady).toHaveBeenCalledWith('worker')
    expect(f.manager.openSessions().sessionIds).toEqual(['session'])
    expect(f.manager.proposalOf('worker', f.root)).toBe('Fix orders\n\nBody')
    expect(f.manager.proposalOf('worker', join(f.root, 'elsewhere'))).toBeNull()
    expect(f.manager.proposalOf('session', f.root)).toBe('proposal')

    const restarted = restart(f)
    expect(restarted.proposalOf('worker', f.root)).toBe('Fix orders\n\nBody')
    // The worker's own split of that root starts with the proposal, like any proposal it was handed.
    const split = await restarted.prepare('worker', 'svn', null, null)
    if (!split.ok) throw new Error(split.detail)
    restarted.attach(split.value.draftId, 'window')
    expect(restarted.read('window', split.value.draftId)).toMatchObject({ message: 'Fix orders\n\nBody', proposedByAgent: true, editedByPerson: false })
    expect(f.writes).toEqual([])
  })

  it('shows a proposal in the open review of its scope and never replaces what a person wrote', async () => {
    const f = await fixture()
    const before = f.manager.read('window', f.draftId)?.revision ?? 0
    expect(await f.manager.propose('session', f.root, 'Agent text')).toEqual({ ok: true, scopeRoot: f.root })
    expect(f.manager.read('window', f.draftId)).toMatchObject({ message: 'Agent text', proposedByAgent: true })
    expect(f.manager.read('window', f.draftId)?.revision).toBeGreaterThan(before)

    f.manager.setMessage('window', f.draftId, 'Person text')
    expect(await f.manager.propose('session', f.root, 'Again')).toMatchObject({ ok: false, code: 'message-edited' })
    expect(f.manager.read('window', f.draftId)?.message).toBe('Person text')
    expect(restart(f).proposalOf('session', f.root)).toBe('Person text')
  })

  it('refuses an empty or oversized proposal and a directory outside any SVN working copy', async () => {
    const f = await fixture()
    expect(await f.manager.propose('worker', f.root, ' \n ')).toMatchObject({ ok: false, code: 'message-empty' })
    expect(await f.manager.propose('worker', f.root, 'x'.repeat(VersioningCommitLimits.messageMaxCharactersConst + 1)))
      .toMatchObject({ ok: false, code: 'message-too-long' })
    f.deps.vcsStatus.detect = async () => null
    expect(await f.manager.propose('worker', f.root, 'Fix')).toMatchObject({ ok: false, code: 'no-working-copy' })
    expect(f.manager.proposalOf('worker', f.root)).toBeNull()
  })

  it('forgets the proposal of one session and root once a Finish committed it, and keeps every other', async () => {
    const f = await fixture()
    await f.manager.propose('worker', f.root, 'Fix orders')
    await f.manager.propose('other', f.root, 'Other work')

    f.manager.forgetProposal('worker', f.root)
    expect(f.manager.proposalOf('worker', f.root)).toBeNull()
    expect(f.manager.proposalOf('other', f.root)).toBe('Other work')
    expect(restart(f).proposalOf('worker', f.root)).toBeNull()
    // Nothing kept is nothing to forget.
    f.manager.forgetProposal('worker', f.root)
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
    const messageFile = join(root, 'state', 'commit-messages.json')
    const report = vi.fn()
    let serial = 0
    const deps: VersioningCommitManagerDeps = {
      messages: new VersioningCommitMessageStore(messageFile, report),
      sessions: { worktreeAt: async () => null, workingContext: async (sessionId) => ({ ok: true, value: { sessionId, cwd: root, agent: null, worktree: null } }) },
      vcsStatus: { detect: async (cwd, id) => ({ id, root, cwd, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null }) },
      tortoise: { open: async () => { throw new Error('Unexpected Tortoise dialog') } },
      snapshotOf: (owner, id) => owner === 'window' && id === snapshot.snapshotId ? snapshot : null,
      fileAccess: (owner, id, fileId) => owner === 'window' && id === snapshot.snapshotId && fileId === 'file'
        ? { ok: true, value: { sessionId: 'session', cwd: root, path, nodeKind: 'file', status: 'modified', workingState: { modifiedAt: stamp, vcsEntry: true } } }
        : { ok: false, code: 'unknown-file', detail: 'unknown' },
      git: { revertFile: async () => { throw new Error('Unexpected Git revert') }, commit: async () => { throw new Error('Unexpected Git commit') } },
      svn: { updateOutOfDate: async () => { throw new Error('Unexpected SVN update') },
        revertFile: async () => { writes.push('reverted'); return { ok: true, value: undefined } }, commit: async (_scope, _targets, message) => {
        phases.push(manager.read('window', draftId)?.phase.kind ?? 'absent')
        writes.push(await readFile(message, 'utf8'))
        return { ok: true, value: { committedPaths: [], revision: '42', output: 'Committed revision 42.' } }
      } },
      onChanged: () => {}, newId: () => `draft-${++serial}`,
    }
    const manager = new VersioningCommitManager(deps)
    const prepared = await manager.prepare('session', vcs, null, 'proposal')
    if (!prepared.ok) throw new Error(prepared.detail)
    const draftId = prepared.value.draftId
    manager.attach(draftId, 'window')
    return { manager, deps, root, path, snapshot, draftId, writes, phases, messageFile, report,
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

  it('preserves person-edited text and its precedence after restart', async () => {
    const f = await fixture()
    const message = 'Reviewed\n\nPříliš žluťoučký kůň'
    expect(f.manager.setMessage('window', f.draftId, message)).toBe(true)
    const manager = restart(f)
    const opened = await manager.prepare('session', 'svn', null, 'Replacement proposal')
    if (!opened.ok) throw new Error(opened.detail)
    manager.attach(opened.value.draftId, 'window')
    expect(opened.messageApplied).toBe(false)
    expect(manager.read('window', opened.value.draftId)).toMatchObject({ message, editedByPerson: true })
  })

  // Mirabia 113: a field the person emptied, or left at its prefix, is nobody's message (2026-10-30).
  it.each(['', '[Jamat] '])('fills a field the person left at %j with a later proposal, also after restart', async (message) => {
    const f = await fixture()
    expect(f.manager.setMessage('window', f.draftId, message)).toBe(true)
    expect(f.manager.read('window', f.draftId)).toMatchObject({ message, editedByPerson: false, proposedByAgent: false, messageSource: 'person-local' })
    const manager = restart(f)
    const opened = await manager.prepare('session', 'svn', null, 'Replacement proposal')
    if (!opened.ok) throw new Error(opened.detail)
    manager.attach(opened.value.draftId, 'window')
    expect(opened.messageApplied).toBe(true)
    expect(manager.read('window', opened.value.draftId)).toMatchObject({ message: 'Replacement proposal', editedByPerson: false, proposedByAgent: true })
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
    expect(manager.read('window', opened.value.draftId)?.message).toBe('')
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

  it('keeps a single-file draft distinct, hides its sibling and rejects the sibling id from a wider snapshot', async () => {
    const f = await fixture()
    const sibling = await addSecondFile(f)
    const opened = await f.manager.prepare('session', 'svn', f.path, 'one file')
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value).toMatchObject({ scopeRoot: f.root, paths: [f.path] })
    expect(opened.value.draftId).not.toBe(f.draftId)
    f.manager.attach(opened.value.draftId, 'window')
    const shown = f.manager.files('window', opened.value.draftId, f.snapshot)
    expect(shown.entries.map((entry) => entry.fileId)).toEqual(['file'])
    expect(f.manager.checkedPaths('window', opened.value.draftId, shown)).toEqual([f.path])
    const commit = vi.spyOn(f.deps.svn, 'commit')
    const request = { ...f.request, draftId: opened.value.draftId }
    expect(await f.manager.run('window', { ...request, fileIds: [sibling.fileId] })).toMatchObject({ ok: false, code: 'invalid-target' })
    expect(commit).not.toHaveBeenCalled()
    expect(await f.manager.run('window', request)).toMatchObject({ ok: true })
    expect(commit.mock.calls[0][1].map((target) => target.absolutePath)).toEqual([f.path])
  })

  /** r345: the review of a product group's `svn:ignore` started with 123 foreign paths checked. */
  it('checks a named file, a named subtree and a node-only directory, and every row of a plain scope', async () => {
    const f = await fixture()
    const project = join(f.root, 'Project')
    const other = join(f.root, 'Other')
    await mkdir(project)
    await mkdir(other)
    const row = (path: string, nodeKind: 'file' | 'directory') => ({ ...f.snapshot.entries[0], fileId: path, path, displayPath: path, nodeKind })
    f.snapshot.entries = [row(f.root, 'directory'), row(f.path, 'file'), row(project, 'directory'), row(join(project, 'a.ts'), 'file'),
      row(join(project, 'deep', 'b.ts'), 'file'), row(join(other, 'c.ts'), 'file')]
    const checked = async (paths: Parameters<VersioningCommitManager['prepare']>[4]) => {
      const opened = await f.manager.prepare('session', 'svn', null, null, paths)
      if (!opened.ok) throw new Error(opened.detail)
      f.manager.attach(opened.value.draftId, 'window')
      return { opened: opened.value, checked: f.manager.checkedPaths('window', opened.value.draftId,
        f.manager.files('window', opened.value.draftId, f.snapshot)) }
    }
    expect(f.manager.checkedPaths('window', f.draftId, f.snapshot)).toBeNull()
    expect((await checked([{ path: f.root, depth: 'infinity' }])).checked).toBeNull()
    const node = await checked([{ path: f.root, depth: 'empty' }])
    expect(node.opened).toMatchObject({ scopeRoot: f.root, paths: [{ path: f.root, depth: 'empty' }] })
    expect(node.checked).toEqual([f.root])
    expect(f.manager.read('window', node.opened.draftId)?.scopeTooltip).toBe(`${f.root}\n  . (this folder only)`)
    expect((await checked([{ path: f.root, depth: 'empty' }, project, f.path])).checked)
      .toEqual([f.root, f.path, project, join(project, 'a.ts'), join(project, 'deep', 'b.ts')])
    // Only what the targets reach is read into the review: below a node-only directory its other
    // work is shown unchecked, and nothing beside the targets appears.
    const mixed = await checked([{ path: project, depth: 'empty' }, join(other, 'c.ts')])
    expect(mixed.checked).toEqual([project, join(other, 'c.ts')])
    expect(f.manager.files('window', mixed.opened.draftId, f.snapshot).entries.map((entry) => entry.path))
      .toEqual([project, join(project, 'a.ts'), join(project, 'deep', 'b.ts'), join(other, 'c.ts')])
    // Named twice, a directory keeps the wider selection; a file has no depth to keep.
    expect((await checked([{ path: project, depth: 'empty' }, project, f.path])).opened.paths).toEqual([project, f.path])
    expect((await checked([{ path: f.path, depth: 'empty' }])).opened.paths).toEqual([f.path])
  })

  it.each([
    [[{ path: 'file.txt' }]], [[{ path: 'file.txt', depth: 'files' }]], [[{ path: 'file.txt', depth: 'empty', recursive: false }]],
    [[{ path: '', depth: 'empty' }]], [['a\nb']], [[42]],
  ])('refuses the requested targets %j before reading anything', async (paths) => {
    const f = await fixture()
    const detect = vi.spyOn(f.deps.vcsStatus, 'detect')
    expect(await f.manager.prepare('session', 'svn', null, null, paths as never))
      .toMatchObject({ ok: false, code: 'no-working-copy', detail: 'Supply a nonempty list of literal commit paths' })
    expect(detect).not.toHaveBeenCalled()
  })

  it('keeps a node-only and a subtree review of one directory apart, also in their saved messages', async () => {
    const f = await fixture()
    const project = join(f.root, 'Project')
    await mkdir(project)
    const node = await f.manager.prepare('session', 'svn', null, 'Ignore data', [{ path: project, depth: 'empty' }])
    const subtree = await f.manager.prepare('session', 'svn', null, 'Whole project', [project, f.path])
    if (!node.ok || !subtree.ok) throw new Error('Not opened')
    expect(node.value.draftId).not.toBe(subtree.value.draftId)
    expect(await f.manager.prepare('session', 'svn', node.value.scopeRoot, null, node.value.paths)).toMatchObject({ value: { draftId: node.value.draftId } })
    f.manager.revokeOwner('window')
    const manager = restart(f)
    const reopened = await manager.prepare('session', 'svn', null, null, [{ path: project, depth: 'empty' }])
    if (!reopened.ok) throw new Error(reopened.detail)
    manager.attach(reopened.value.draftId, 'window')
    expect(manager.read('window', reopened.value.draftId)?.message).toBe('Ignore data')
  })

  it('hands the out-of-date failure and the checked nodes of a plain scope to the SVN recovery', async () => {
    const f = await fixture()
    f.deps.svn.commit = async () => ({ ok: false, code: 'out-of-date', detail: 'E155011' })
    f.deps.svn.updateOutOfDate = vi.fn(async () => ({ ok: true as const, value: { output: 'Updated' } }))
    await f.manager.run('window', f.request)
    expect(f.deps.svn.updateOutOfDate).toHaveBeenCalledExactlyOnceWith(f.root, 'E155011', [f.path])
  })

  /** B1: a recovery that would have raised tree conflicts stops before any write, so nothing asks for a reload. */
  it('reports a refused recovery without a retry or a reload', async () => {
    const f = await fixture()
    f.deps.svn.commit = vi.fn(async () => ({ ok: false as const, code: 'out-of-date' as const, detail: "svn: E155011: Directory 'blocks' is out of date" }))
    f.deps.svn.updateOutOfDate = vi.fn(async () => ({ ok: false as const, code: 'refused' as const, detail: 'Update blocks yourself: it is one side of a move' }))
    const result = await f.manager.run('window', f.request)
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('Update blocks yourself') })
    expect(result).not.toHaveProperty('reloadRequired')
    expect(result).toMatchObject({ detail: expect.stringContaining("Directory 'blocks' is out of date") })
    expect(f.deps.svn.commit).toHaveBeenCalledTimes(1)
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
    expect(f.manager.checkedPaths('window', opened.value.draftId, { ...f.snapshot, entries: [child] })).toEqual([])
  })

  it.each([
    { explicit: false, complete: true }, { explicit: true, complete: true },
    { explicit: false, complete: false }, { explicit: true, complete: false },
  ])('hands recursive directories to Tortoise only with every descendant selected (%j)', async ({ explicit, complete }) => {
    const f = await fixture()
    const directory = join(f.root, 'new')
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(join(directory, 'nested', 'chosen.txt'), 'chosen')
    await writeFile(join(directory, 'nested', 'unchecked.txt'), 'unchecked')
    const entries = await Promise.all(['new', 'new/nested', 'new/nested/chosen.txt', 'new/nested/unchecked.txt'].map(async (name) => {
      const path = join(f.root, name)
      const stat = await lstat(path)
      return { ...f.snapshot.entries[0], fileId: name, path, displayPath: name,
        nodeKind: stat.isDirectory() ? 'directory' as const : 'file' as const,
        status: 'untracked' as const, modifiedAt: Math.round(stat.mtimeMs) }
    }))
    f.snapshot.entries = [...f.snapshot.entries, ...entries]
    f.deps.fileAccess = (_owner, _snapshot, id) => {
      const entry = f.snapshot.entries.find((candidate) => candidate.fileId === id)
      return entry === undefined ? { ok: false, code: 'unknown-file', detail: 'unknown' }
        : { ok: true, value: { sessionId: 'session', cwd: f.root, path: entry.path, nodeKind: entry.nodeKind,
          status: entry.status, workingState: { vcsEntry: true, modifiedAt: entry.modifiedAt } } }
    }
    const opened = await f.manager.prepare('session', 'svn', null, null, explicit ? [directory, f.path] : undefined)
    if (!opened.ok) throw new Error(opened.detail)
    const draftId = opened.value.draftId
    f.manager.attach(draftId, 'window')
    f.manager.files('window', draftId, f.snapshot)
    const before = f.manager.read('window', draftId)!
    const binding = { snapshotId: f.snapshot.snapshotId,
      fileIds: f.snapshot.entries.filter((entry) => complete || entry.fileId !== 'new/nested/unchecked.txt').map((entry) => entry.fileId) }
    expect(f.manager.edit('window', { draftId, epoch: before.epoch!, expectedRevision: before.revision,
      message: 'Reviewed', selection: binding })).toMatchObject({ ok: true })
    f.deps.tortoise.open = vi.fn(async () => ({ ok: true as const, closed: Promise.resolve() }))

    const result = await f.manager.openTortoise('window', draftId, 'Reviewed', binding)

    if (complete) {
      expect(result).toEqual({ ok: true })
      expect(f.deps.tortoise.open).toHaveBeenCalledWith(expect.objectContaining({ scope: f.root, paths: [f.path, directory] }))
    } else {
      expect(result).toMatchObject({ ok: false, code: 'invalid-target', detail: expect.stringContaining('every displayed descendant selected') })
      expect(f.deps.tortoise.open).not.toHaveBeenCalled()
    }
    expect(f.writes).toEqual([])
  })

  it('refuses to hand a node-only selection to Tortoise, which would show and check the work below it', async () => {
    const f = await fixture()
    f.deps.tortoise.open = vi.fn(async () => { throw new Error('Unexpected Tortoise dialog') })
    const opened = await f.manager.prepare('session', 'svn', null, null, [{ path: f.root, depth: 'empty' }])
    if (!opened.ok) throw new Error(opened.detail)
    f.manager.attach(opened.value.draftId, 'window')
    expect(await f.manager.openTortoise('window', opened.value.draftId, 'Message'))
      .toMatchObject({ ok: false, code: 'invalid-target', detail: expect.stringContaining('own node') })
    expect(f.deps.tortoise.open).not.toHaveBeenCalled()
    expect(f.manager.status(opened.value.draftId)).toMatchObject({ state: 'editing' })
  })

  it('updates only the reviewed file after an out-of-date single-file commit', async () => {
    const f = await fixture()
    const opened = await f.manager.prepare('session', 'svn', f.path, null)
    if (!opened.ok) throw new Error(opened.detail)
    f.manager.attach(opened.value.draftId, 'window')
    f.deps.svn.commit = async () => ({ ok: false, code: 'out-of-date', detail: 'E155011' })
    f.deps.svn.updateOutOfDate = vi.fn(async () => ({ ok: true as const, value: { output: 'Updated' } }))
    expect(await f.manager.run('window', { ...f.request, draftId: opened.value.draftId })).toMatchObject({ ok: false, reloadRequired: true })
    expect(f.deps.svn.updateOutOfDate).toHaveBeenCalledWith(f.root, 'E155011', [f.path])
  })

  /** 051 kept the red "commit review required" mark over its landed row: its Finish committed itself. */
  it('stops marking a Finish review open once its Finish no longer offers it, and says so once', async () => {
    const f = await fixture()
    let offered = true
    f.deps.workflow = { offers: () => offered, owns: () => true, check: () => null,
      start: async () => ({ ok: true as const, revision: '' }), state: () => ({ kind: 'running' as const }), changed: (paths) => paths.join(', ') }
    const changed = vi.fn()
    f.deps.onChanged = changed
    expect(f.manager.openSessions().sessionIds).toEqual(['session'])

    offered = false
    f.manager.workflowChanged()
    f.manager.workflowChanged()
    expect(f.manager.openSessions().sessionIds).toEqual([])
    expect(changed).toHaveBeenCalledTimes(1)

    f.deps.workflow = { ...f.deps.workflow, owns: () => false }
    expect(f.manager.openSessions().sessionIds).toEqual(['session'])
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
      return { ok: true, value: { committedPaths: [], revision: String(groupIndex), output: 'done' } }
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
      return { ok: true, value: { committedPaths: [], revision: String(40 + calls.length), output: `Committed ${scope}` } }
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
    f.deps.svn.commit = async () => ({ ok: true, value: { committedPaths: [], revision: '50', output: 'done' } })
    expect(await f.manager.run('window', request)).toMatchObject({ ok: true })
  })

  it('reports partial commits, invalidates the old list and retries only refreshed remaining targets', async () => {
    const f = await fixture()
    const a = await addExternal(f, 'shared/a')
    const b = await addExternal(f, 'shared/b')
    const commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>()
      .mockResolvedValueOnce({ ok: true, value: { committedPaths: [a.entry.path], revision: '51', output: 'first committed' } })
      .mockResolvedValueOnce({ ok: false, code: 'locked', detail: 'second is locked' })
      .mockImplementation(async (_scope, targets) => ({ ok: true, value: {
        committedPaths: targets.map((target) => target.absolutePath), revision: '52', output: 'committed',
      } }))
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
    expect(f.manager.status(f.draftId)?.committedPaths).toEqual([a.entry.path, b.entry.path, f.path])
  })

  it('updates only the outdated external, reports earlier commits and stops before the main commit', async () => {
    const f = await fixture()
    const a = await addExternal(f, 'shared/a')
    const b = await addExternal(f, 'shared/b')
    f.deps.svn.commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>()
      .mockResolvedValueOnce({ ok: true, value: { committedPaths: [], revision: '60', output: 'done' } })
      .mockResolvedValue({ ok: false, code: 'out-of-date', detail: 'E155011' })
    f.deps.svn.updateOutOfDate = vi.fn(async () => ({ ok: true as const, value: { output: 'Updated' } }))
    const result = await f.manager.run('window', { ...f.request, fileIds: ['file', a.entry.fileId, b.entry.fileId], includeExternals: true })
    expect(result).toMatchObject({ ok: false, reloadRequired: true, detail: expect.stringContaining(`${a.root}: 60`) })
    expect(f.deps.svn.updateOutOfDate).toHaveBeenCalledExactlyOnceWith(b.root, 'E155011', [b.entry.path])
    expect(f.deps.svn.commit).toHaveBeenCalledTimes(3)
    expect(f.manager.status(f.draftId)?.state).toBe('failed')
  })

  it.each(['changed'] as const)('stops remaining groups if their file is %s after an earlier commit', async (kind) => {
    const f = await fixture()
    const external = await addExternal(f, 'shared/lib')
    const commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>(async () => {
      if (kind === 'changed') await utimes(f.path, new Date(0), new Date(0))
      else throw new Error(`Unknown test case: ${kind}`)
      return { ok: true, value: { committedPaths: [], revision: '61', output: 'done' } }
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
    const commit = vi.fn(async () => ({ ok: true as const, value: { committedPaths: [], revision: '42', output: 'committed' } }))
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
      return { ok: true, value: { committedPaths: [], revision: '42', output: 'Committed revision 42.' } }
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
    expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'done', revision: '42' })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'busy' })
  })

  // A worktree session whose review committed may have its worktree removed once it ended.
  it('reports the receipt of an SVN review that committed or went to Tortoise, and of nothing else', async () => {
    const committed: SessionCommitReceipt[] = []
    const f = await fixture()
    f.deps.committed = (receipt) => committed.push(receipt)
    f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: 'E155004: the working copy is locked' })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false })
    expect(committed).toEqual([])
    f.deps.svn.commit = async () => ({ ok: true, value: { committedPaths: [f.path], revision: '42', output: 'Committed revision 42.' } })
    expect(await f.manager.run('window', f.request)).toEqual({ ok: true, revision: '42' })
    expect(committed).toEqual([{ sessionId: 'session', scopes: [{ scopeRoot: f.root, revision: 42 }], paths: [f.path] }])

    const tortoise = await fixture()
    tortoise.deps.committed = (receipt) => committed.push(receipt)
    tortoise.deps.tortoise.open = async () => ({ ok: true, closed: Promise.resolve() })
    expect(await tortoise.manager.openTortoise('window', tortoise.draftId, 'Message')).toMatchObject({ ok: true })
    expect(committed.slice(1)).toEqual([{ sessionId: 'session', scopes: [{ scopeRoot: tortoise.root, revision: null }], paths: [] }])

    const git = await fixture('git')
    git.deps.committed = (receipt) => committed.push(receipt)
    git.deps.git.commit = async () => ({ ok: true, value: { hash: 'abc1234', output: '' } })
    expect(await git.manager.run('window', git.request)).toMatchObject({ ok: true })
    expect(committed).toHaveLength(2)
  })

  it('gives each scope of a mount-then-root commit its own revision and reports every committed path', async () => {
    const committed: SessionCommitReceipt[] = []
    const f = await fixture()
    const mount = await addExternal(f, 'mount')
    f.deps.committed = (receipt) => committed.push(receipt)
    f.deps.svn.commit = async (scope, targets) => ({ ok: true, value: {
      committedPaths: targets.map((target) => target.absolutePath), revision: scope === mount.root ? '1234' : '1235', output: 'done' } })
    expect(await f.manager.run('window', { ...f.request, fileIds: ['file', mount.entry.fileId], includeExternals: true }))
      .toEqual({ ok: true, revision: '1234, 1235' })
    expect(committed).toEqual([{ sessionId: 'session',
      scopes: [{ scopeRoot: mount.root, revision: 1234 }, { scopeRoot: f.root, revision: 1235 }],
      paths: [mount.entry.path, f.path] }])
  })

  it('reports the scopes committed before a later scope failed', async () => {
    const committed: SessionCommitReceipt[] = []
    const f = await fixture()
    const mount = await addExternal(f, 'mount')
    const store = join(f.root, 'partial-reviews.json')
    f.deps.reviews = new VersioningReviewStore(store, f.report)
    f.deps.committed = (receipt) => committed.push(receipt)
    f.deps.svn.commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>()
      .mockResolvedValueOnce({ ok: true, value: { committedPaths: [mount.entry.path], revision: '70', output: 'done' } })
      .mockResolvedValueOnce({ ok: false, code: 'locked', detail: 'the root is locked' })
    expect(await f.manager.run('window', { ...f.request, fileIds: ['file', mount.entry.fileId], includeExternals: true }))
      .toMatchObject({ ok: false, code: 'vcs-failed' })
    expect(committed).toEqual([{ sessionId: 'session', scopes: [{ scopeRoot: mount.root, revision: 70 }], paths: [mount.entry.path] }])
    expect(f.manager.read('window', f.draftId)).toMatchObject({ published: [{ scopeRoot: mount.root, revision: '70', paths: [mount.entry.path] }],
      phase: { kind: 'failed', detail: expect.stringContaining('Remaining or unconfirmed:') } })
    expect(f.manager.status(f.draftId)?.committedPaths).toEqual([mount.entry.path])
    expect(new VersioningReviewStore(store, f.report).read()[0].dto.published).toEqual([{ scopeRoot: mount.root, revision: '70', paths: [mount.entry.path] }])
  })

  it('refuses changed reviewed bytes with a preserved modification time before publication', async () => {
    const f = await fixture()
    const file = f.snapshot.entries[0].path
    const stamp = await lstat(file)
    const fingerprint = await FileChangesFingerprint.of(file)
    const access = f.deps.fileAccess
    f.deps.fileAccess = (...args) => {
      const result = access(...args)
      return result.ok ? { ok: true, value: { ...result.value, workingState: { ...result.value.workingState!, fingerprint } } } : result
    }
    f.manager.files('window', f.draftId, f.snapshot)
    await writeFile(file, 'changed after review')
    await utimes(file, stamp.atime, stamp.mtime)
    f.deps.svn.commit = vi.fn(async () => { throw new Error('Must not publish changed content') })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'stale' })
    expect(f.deps.svn.commit).not.toHaveBeenCalled()
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

  it.each(['svn', 'git'] as const)('commits the unchanged %s review once after the shared snapshot cache expires', async (vcs) => {
    const f = await fixture(vcs)
    f.deps.git.commit = vi.fn(async () => ({ ok: true as const, value: { hash: 'abc123', output: 'Committed' } }))
    const svn = vi.spyOn(f.deps.svn, 'commit')
    f.manager.files('window', f.draftId, f.snapshot)
    f.deps.snapshotOf = () => null
    f.deps.fileAccess = () => ({ ok: false, code: 'snapshot-expired', detail: 'Evicted' })
    expect(await f.manager.run('window', f.request)).toEqual({ ok: true, revision: vcs === 'svn' ? '42' : 'abc123' })
    expect(vcs === 'svn' ? svn : f.deps.git.commit).toHaveBeenCalledTimes(1)
  })

  it('still rejects an actual file change after retaining a review', async () => {
    const f = await fixture()
    f.manager.files('window', f.draftId, f.snapshot)
    f.deps.snapshotOf = () => null
    f.deps.fileAccess = () => ({ ok: false, code: 'snapshot-expired', detail: 'Expired' })
    await writeFile(f.path, 'Changed during review')
    await utimes(f.path, new Date(), new Date(Date.now() + 10_000))
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'stale' })
    expect(f.writes).toEqual([])
  })

  it('retains only the latest review per owner and releases it when that owner closes', async () => {
    const f = await fixture()
    f.manager.files('window', f.draftId, f.snapshot)
    f.snapshot.snapshotId = 'refreshed'
    f.manager.files('window', f.draftId, f.snapshot)
    f.manager.attach(f.draftId, 'second')
    f.deps.snapshotOf = () => null
    f.deps.fileAccess = () => ({ ok: false, code: 'snapshot-expired', detail: 'Expired' })
    const request = { ...f.request, snapshotId: 'refreshed' }
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'invalid-target', reloadRequired: true })
    expect(await f.manager.run('second', request)).toMatchObject({ ok: false, code: 'invalid-target' })
    expect(await f.manager.run('window', { ...request, fileIds: ['foreign-file'] })).toMatchObject({ ok: false, code: 'invalid-target' })
    f.manager.release(f.draftId, 'window')
    f.manager.attach(f.draftId, 'window')
    expect(await f.manager.run('window', request)).toMatchObject({ ok: false, code: 'invalid-target', reloadRequired: true })
    expect(f.writes).toEqual([])
  })

  it('keeps revert confirmation usable after the shared snapshot expires', async () => {
    const f = await fixture()
    f.manager.files('window', f.draftId, f.snapshot)
    f.deps.snapshotOf = () => null
    f.deps.fileAccess = () => ({ ok: false, code: 'snapshot-expired', detail: 'Expired' })
    const confirm = vi.fn(async () => false)
    expect(await f.manager.revert('window', f.request, confirm)).toEqual({ ok: true, reverted: false })
    expect(confirm).toHaveBeenCalledWith([f.path], 'svn')
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
      return { ok: true, value: { committedPaths: [], revision: '42', output: 'done' } }
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
    expect(f.manager.openSessions().sessionIds).toEqual(['session'])
  })

  it('keeps a failed detached review discoverable after restart and reopens its exact selection for cancellation', async () => {
    const f = await fixture()
    const file = join(f.root, 'reviews.json')
    f.deps.reviews = new VersioningReviewStore(file, f.report)
    await f.manager.cancel(f.draftId)
    f.manager.release(f.draftId, 'window')
    const prepared = await f.manager.prepare('session', 'svn', null, 'Review one file', [f.path])
    if (!prepared.ok) throw new Error(prepared.detail)
    const id = prepared.value.draftId
    f.manager.attach(id, 'window')
    f.manager.files('window', id, f.snapshot)
    f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: 'locked' })
    expect(await f.manager.run('window', { ...f.request, draftId: id })).toMatchObject({ ok: false, code: 'vcs-failed' })
    f.manager.release(id, 'window')
    const manager = new VersioningCommitManager({ ...f.deps, reviews: new VersioningReviewStore(file, f.report) })
    expect(manager.reviews('session', 'window')).toEqual([])
    expect(manager.openSessions().reviews).toEqual([{ draftId: id, sessionId: 'session', vcs: 'svn',
      scopeRoot: prepared.value.scopeRoot, paths: [f.path], workflow: false }])
    expect(manager.openReview('session', id, 'window')).toMatchObject({ ok: true, value: { draftId: id, paths: [f.path] } })
    expect(manager.read('window', id)?.phase.kind).toBe('failed')
    await manager.cancel(id)
    expect(manager.openSessions()).toMatchObject({ sessionIds: [], reviews: [] })
  })

  it('updates an outdated scope once under the commit lock and gives up on a second out-of-date', async () => {
    const f = await fixture()
    f.deps.svn.commit = vi.fn(async () => ({ ok: false as const, code: 'out-of-date' as const, detail: 'E155011: out of date' }))
    f.deps.svn.updateOutOfDate = vi.fn(async (scope: string) => {
      expect(scope).toBe(f.root)
      expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'running', detail: expect.stringContaining('Updating') })
      expect(f.manager.status(f.draftId)?.state).toBe('running')
      expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, code: 'busy' })
      return { ok: true as const, value: { output: 'Updated to revision 43.' } }
    })
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, reloadRequired: true,
      detail: expect.stringContaining('E155011') })
    expect(f.deps.svn.commit).toHaveBeenCalledTimes(2)
    expect(f.deps.svn.updateOutOfDate).toHaveBeenCalledTimes(1)
    expect(f.manager.status(f.draftId)).toMatchObject({ state: 'failed', revision: null, detail: expect.stringContaining('E155011') })
    expect(f.manager.read('window', f.draftId)?.message).toBe(f.request.message)
  })

  it('commits the reviewed selection itself after an update that left it alone', async () => {
    const f = await fixture()
    const commit = vi.fn<VersioningCommitManagerDeps['svn']['commit']>()
      .mockResolvedValueOnce({ ok: false, code: 'out-of-date', detail: 'E155011: out of date' })
      .mockResolvedValue({ ok: true, value: { committedPaths: [], revision: '45', output: 'Committed revision 45.' } })
    f.deps.svn.commit = commit
    f.deps.svn.updateOutOfDate = vi.fn(async () => ({ ok: true as const, value: { output: 'Updated to revision 44.' } }))
    expect(await f.manager.run('window', f.request)).toEqual({ ok: true, revision: '45' })
    expect(commit).toHaveBeenCalledTimes(2)
    expect(f.manager.read('window', f.draftId)?.phase).toMatchObject({ kind: 'done', revision: '45',
      output: expect.stringContaining('Updated to revision 44.') })
  })

  it('stops the retry when the update wrote into a file this commit holds', async () => {
    const f = await fixture()
    f.deps.svn.commit = vi.fn(async () => ({ ok: false as const, code: 'out-of-date' as const, detail: 'E155011: out of date' }))
    f.deps.svn.updateOutOfDate = vi.fn(async () => {
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
    f.deps.svn.updateOutOfDate = async () => {
      if (kind === 'exception') throw new Error('Connection lost')
      return { ok: false, code: 'svn-failed', detail: 'Conflict in app/file.ts' }
    }
    const result = await f.manager.run('window', f.request)
    expect(result).toMatchObject({ ok: false, reloadRequired: true, detail: expect.stringContaining('E170004') })
    expect(result).toMatchObject({ detail: expect.stringContaining(kind === 'exception' ? 'Connection lost' : 'app/file.ts') })
    f.deps.svn.commit = async () => ({ ok: true, value: { committedPaths: [], revision: '44', output: 'Committed' } })
    expect(await f.manager.run('window', f.request)).toEqual({ ok: true, revision: '44' })
  })

  it.each(['svn', 'git'] as const)('never updates %s after an unrelated failure', async (vcs) => {
    const f = await fixture(vcs)
    f.deps.svn.updateOutOfDate = vi.fn(async () => { throw new Error('Must not update') })
    f.deps.svn.commit = async () => ({ ok: false, code: 'locked', detail: 'locked' })
    f.deps.git.commit = async () => { throw new Error('Git failed') }
    expect(await f.manager.run('window', f.request)).toMatchObject({ ok: false, detail: vcs === 'svn' ? 'locked' : 'Git failed' })
    expect(f.deps.svn.updateOutOfDate).not.toHaveBeenCalled()
  })

  it('climbs past the project Git answer of a new SVN directory to its working copy (Jamat#35)', async () => {
    const f = await fixture()
    const fresh = join(f.root, '.aidocs', 'completed')
    await mkdir(fresh, { recursive: true })
    const file = join(fresh, 'done.md')
    await writeFile(file, 'done\n')
    f.deps.vcsStatus.detect = async (cwd, id) => ({ id: cwd === fresh ? 'git' : id,
      cwd, root: f.root, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null })
    expect(await f.manager.prepare('session', 'svn', null, null, [file]))
      .toMatchObject({ ok: true, value: { scopeRoot: join(f.root, '.aidocs'), paths: [file] } })
  })

  it('allows explicit outside scopes and still refuses a missing VCS', async () => {
    const f = await fixture()
    expect(await f.manager.prepare('session', 'svn', '..', null)).toMatchObject({ ok: true })
    f.deps.vcsStatus.detect = async () => null
    expect(await f.manager.prepare('session', 'svn', null, null)).toMatchObject({ ok: false, code: 'no-working-copy' })
  })
})
