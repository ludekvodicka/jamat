import { describe, expect, it, vi } from 'vitest'
import type { VersioningCommitManager } from '../versioning/versioningCommitManager'
import type { ReviewInteractionAccess } from '../versioning/reviewInteractionAccess'
import type { FileChangesAccess } from '../fileChanges/fileChangesAccess'
import type { RemoteSessionInteraction } from './remoteSessionViews'
import type { VersioningCommitOpenResult } from '../../shared/versioningCommit'
import { RemoteReviewAccess } from './remoteReviewAccess'

describe('source review opening', () => {
  const view: RemoteSessionInteraction = { peerId: 'peer', sessionId: 'source', epoch: 'epoch', viewId: 'view', viewerId: 'window' }
  const result = { ok: true, value: { draftId: 'draft', scopeRoot: 'C:/source', title: 'Commit SVN' }, messageApplied: false } satisfies VersioningCommitOpenResult

  it('coalesces concurrent source review creation and publishes the same review to both viewers', async () => {
    let finish!: (value: VersioningCommitOpenResult) => void
    const pending = new Promise<VersioningCommitOpenResult>((resolve) => { finish = resolve })
    const prepare = vi.fn(() => pending), attach = vi.fn(), publish = vi.fn(async () => {})
    const manager = { prepare, attach } as unknown as VersioningCommitManager
    const access = new RemoteReviewAccess(manager, {} as ReviewInteractionAccess, {} as FileChangesAccess, () => true, () => {}, publish)
    const first = access.request(view, { kind: 'create', vcs: 'svn', openId: 'one' })
    const second = access.request({ ...view, viewId: 'other', viewerId: 'other' }, { kind: 'create', vcs: 'svn', openId: 'two' })
    expect(prepare).toHaveBeenCalledExactlyOnceWith('source', 'svn', null, null, undefined, { fresh: true })
    finish(result)
    await Promise.all([first, second])
    expect(attach).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenNthCalledWith(1, 'source', 'svn', result, 'one')
    expect(publish).toHaveBeenNthCalledWith(2, 'source', 'svn', result, 'two')
    expect(attach.mock.calls[0][1]).not.toBe(attach.mock.calls[1][1])
  })

  it('releases a view revoked during preparation while retaining the published source review', async () => {
    let active = true
    const revokeOwner = vi.fn(), attach = vi.fn(), publish = vi.fn(async () => { active = false })
    const manager = { prepare: vi.fn(async () => result), attach, revokeOwner } as unknown as VersioningCommitManager
    const access = new RemoteReviewAccess(manager, {} as ReviewInteractionAccess, {} as FileChangesAccess, () => active, () => {}, publish)
    await expect(access.request(view, { kind: 'create', vcs: 'git', openId: 'one' })).rejects.toThrow('released')
    expect(publish).toHaveBeenCalledOnce()
    expect(revokeOwner).toHaveBeenCalledWith(attach.mock.calls[0][1])
  })
})


it('refuses a source review scope not admitted by the session file owner', async () => {
  const prepare = vi.fn()
  const workingTree = vi.fn(async () => ({ ok: false, code: 'invalid-context', detail: 'Outside source session' }))
  const access = new RemoteReviewAccess({ prepare } as unknown as VersioningCommitManager, {} as ReviewInteractionAccess,
    { workingTree } as unknown as FileChangesAccess, () => true, () => {}, async () => {})
  const page = await access.request({ peerId: 'peer', epoch: 'epoch', viewerId: 'window', viewId: 'view', sessionId: 'source' },
    { kind: 'create', vcs: 'svn', openId: 'one', scopeRoot: 'C:/other' })
  expect(page.ok && JSON.parse(Buffer.from(page.value.base64, 'base64').toString())).toMatchObject({ ok: false, detail: 'Outside source session' })
  expect(prepare).not.toHaveBeenCalled()
})
