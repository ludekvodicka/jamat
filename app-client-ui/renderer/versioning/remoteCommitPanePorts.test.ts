import { expect, it, vi } from 'vitest'
import type { RemoteReviewRequest } from '../../../lib-orchestrator/remoteControl/remoteReviewApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { VersioningCommitDraftDto } from '../../shared/versioningCommit'
import { CommitPaneChannel } from './commitPanePorts'
import { RemoteCommitPanePorts } from './remoteCommitPanePorts'

const draft: VersioningCommitDraftDto = { draftId: 'review', epoch: 'source', sessionId: 'session', vcs: 'svn', source: 'svn',
  scopeRoot: 'Q:/outside', scopeTooltip: 'Q:/outside', message: 'Accepted', editedByPerson: true, proposedByAgent: false,
  revision: 5, phase: { kind: 'editing' }, selection: { snapshotId: 'snapshot', paths: ['Q:/outside/a'] } }

function fixture(endpoint = 'peer', result: (request: RemoteReviewRequest) => unknown = () => draft) {
  const requestReviews = vi.fn<AppClientUiBridge['remote']['requestReviews']>(async (_endpoint, _view, request) => {
    const value = request.kind === 'open' ? { ok: true, value: { draftId: 'review', scopeRoot: 'Q:/outside', title: 'Review' }, messageApplied: false } : result(request)
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    return { ok: true, value: { ok: true, value: { transferId: 'transfer', version: 'version', offset: 0,
      totalBytes: bytes.length, next: null, base64: btoa(String.fromCharCode(...bytes)) } } }
  })
  const project = vi.fn(async () => {})
  const changed = vi.fn(async () => {})
  const changes = { openFile: vi.fn() } as unknown as AppClientUiBridge['fileChanges']
  const provider = new RemoteCommitPanePorts({ kind: 'remote', remoteEndpointId: endpoint, sessionId: 'session' }, 0,
    async () => ({ viewId: 'equal-view', epoch: 'connection', sessionId: 'session', viewerId: 'viewer' }),
    { requestReviews, readReviewPage: vi.fn() }, { project, changed, changes, releaseFile: vi.fn(),
      subscribe: () => () => {}, reportError: vi.fn(), settings: { getSettings: vi.fn(), saveSettings: vi.fn() }, computer: () => 'Peer PC' })
  return { provider, ports: provider.ports, requestReviews, project, changed }
}

it('opens the source identity through endpoint-qualified ports and projects its local activation once', async () => {
  const a = fixture('one'), b = fixture('two')
  expect(await a.ports.versioning.openDraft('session', 'svn', 'Q:/outside', undefined, 'review')).toMatchObject({ ok: true, value: { ok: true } })
  await b.ports.versioning.openDraft('session', 'svn', 'Q:/outside', undefined, 'review')
  expect(a.requestReviews).toHaveBeenCalledWith('one', 'equal-view', { kind: 'open', reviewId: 'review' })
  expect(b.requestReviews).toHaveBeenCalledWith('two', 'equal-view', { kind: 'open', reviewId: 'review' })
  expect(a.ports.identity).not.toBe(b.ports.identity)
  expect(a.project).not.toHaveBeenCalled()
  await a.ports.projectReview?.(draft, 'review-item', 'semantic-open')
  expect(a.project).toHaveBeenCalledWith(draft, 'review-item', 'semantic-open')
})

it.each([{ ...draft, sessionId: 'foreign' }, { ...draft, draftId: 'other' }, { ...draft, forged: true }])('refuses a foreign or non-strict decoded review', async (value) => {
  const f = fixture('peer', () => value)
  expect(await f.ports.versioning.readCommit('review')).toMatchObject({ ok: false })
})

it('retired ports never route a new call or fall back to a local owner', async () => {
  const f = fixture()
  f.provider.clear()
  expect(await f.ports.versioning.readCommit('review')).toMatchObject({ ok: false, error: expect.stringContaining('retired') })
  expect(f.requestReviews).not.toHaveBeenCalled()
})

// UA1-J12-3: a request the channel answered for the source read as a changed review.
it('marks an answer the channel gave instead of the source, and proves acceptance only from a later source read', async () => {
  let current: VersioningCommitDraftDto = draft
  const f = fixture('peer', () => current)
  const channel = (code: string, detail: string) => f.requestReviews.mockResolvedValueOnce({ ok: true, value: { ok: false, error: { code, detail } } } as never)
  const edit = { draftId: 'review', epoch: 'source', expectedRevision: 5, selection: { snapshotId: 'snapshot', fileIds: ['a'] } }
  const finish = { draftId: 'review', epoch: 'source', expectedRevision: 5, operationId: 'operation', kind: 'finish' as const, snapshotId: 'snapshot',
    fileIds: ['a'], message: 'Accepted', workflow: { workflowId: 'finish', revision: 3, actionId: 'finish-again' as const, agreement: {} } }
  channel('timeout', 'Remote session view request timed out')
  const timedOut = await f.ports.versioning.editCommit!(edit)
  expect(timedOut).toMatchObject({ ok: false, error: 'Remote session view request timed out' })
  expect(CommitPaneChannel.lossOf(timedOut)).toEqual({ computer: 'Peer PC', accepted: false })
  channel('unavailable', 'Remote AppClientUI disconnected')
  expect(CommitPaneChannel.lossOf(await f.ports.versioning.decideCommit!(finish))).toEqual({ computer: 'Peer PC', accepted: false })
  channel('forbidden', 'Shared Finish approval is unsupported by this peer')
  expect(CommitPaneChannel.lossOf(await f.ports.versioning.decideCommit!(finish))).toBeNull()
  current = { ...draft, revision: 6, phase: { kind: 'running', startedAt: 1 }, workflow: { workflowId: 'finish', acceptedAt: 1 } }
  await f.ports.versioning.readCommit('review')
  channel('timeout', 'Remote session view request timed out')
  expect(CommitPaneChannel.lossOf(await f.ports.versioning.decideCommit!(finish))).toEqual({ computer: 'Peer PC', accepted: true })
  channel('timeout', 'Remote session view request timed out')
  expect(CommitPaneChannel.lossOf(await f.ports.versioning.decideCommit!({ ...finish, expectedRevision: 6 }))).toEqual({ computer: 'Peer PC', accepted: false })
})
