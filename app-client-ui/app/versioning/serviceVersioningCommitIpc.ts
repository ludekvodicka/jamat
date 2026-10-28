import { RemoteReviewSchemas } from '../../../lib-orchestrator/remoteControl/remoteReviewSchemas'
import { randomUUID } from 'node:crypto'
import type { ReviewInteractionAccess } from './reviewInteractionAccess'
import type { VersioningReviewDecision } from '../../shared/versioningCommit'
import { VersioningCommitPaths } from '../../shared/versioningCommit'
import type { WebContents } from 'electron'

import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { VersioningCommitManager } from './versioningCommitManager'
import type { FileChangesAccess } from '../fileChanges/fileChangesAccess'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'

export class ServiceVersioningCommitIpc extends ServiceIpcBase<typeof ServiceVersioningCommitIpc.channelsConst> {
  static readonly channelsConst = {
    'versioning:commit-open-draft': true,
    'versioning:commit-read': true,
    'versioning:commit-files': true,
    'versioning:commit-external-diff': true,
    'versioning:commit-open-tab': true,
    'versioning:commit-decide': true,
    'versioning:commit-edit': true,
    'versioning:commit-set-message': true,
    'versioning:commit-run': true,
    'versioning:commit-revert': true,
    'versioning:commit-tortoise': true,
    'versioning:commit-cancel': true,
    'versioning:commit-close': true,
    'versioning:commit-open-sessions': true,
  } as const

  private readonly manager: VersioningCommitManager
  private readonly ownerIdOf: (sender: WebContents) => string | null
  private readonly files: Pick<FileChangesAccess, 'workingTree'>
  private readonly openTab: (sessionId: string, vcs: 'svn' | 'git', scope?: string) => Promise<ReturnType<AppClientUiIpcInvokeMap['versioning:commit-open-tab']>>
  private readonly interactions?: ReviewInteractionAccess

  constructor(manager: VersioningCommitManager, ownerIdOf: ServiceVersioningCommitIpc['ownerIdOf'],
    files: ServiceVersioningCommitIpc['files'], openTab: ServiceVersioningCommitIpc['openTab'],
    interactions?: ReviewInteractionAccess) {
    super()
    this.manager = manager
    this.ownerIdOf = ownerIdOf
    this.files = files
    this.openTab = openTab
    this.interactions = interactions
  }

  initialize(): void {
    this.register('versioning:commit-external-diff', (event) => { this.owner(event.sender); return { ok: false, detail: 'Reload the review to open a revision-bound source diff' } })
    this.register('versioning:commit-open-tab', (event, sessionId, vcs, scope) => { this.owner(event.sender); return this.openTab(sessionId, vcs, scope) })
    this.register('versioning:commit-open-draft', async (event, sessionId, vcs, scope, paths, reviewId, reviewOnly) => {
      const ownerId = this.owner(event.sender)
      if (reviewId !== undefined) return this.manager.openReview(sessionId, reviewId, ownerId)
      const prepared = await this.manager.prepare(sessionId, vcs, scope, null, paths, { reviewOnly })
      if (prepared.ok) {
        if (event.sender.isDestroyed()) this.manager.releaseUnattached(prepared.value.draftId)
        else this.manager.attach(prepared.value.draftId, ownerId)
      }
      return prepared
    })
    this.register('versioning:commit-read', (event, draftId) => this.manager.read(this.owner(event.sender), draftId))
    this.register('versioning:commit-files', async (event, draftId) => {
      const ownerId = this.owner(event.sender)
      const draft = this.manager.read(ownerId, draftId)
      if (draft === null) return { ok: false, code: 'invalid-context', detail: 'The commit dialog no longer exists' }
      const result = await this.files.workingTree(ownerId, draft.sessionId, draft.source, draft.scopeRoot, true,
        undefined, draft.paths?.map(VersioningCommitPaths.pathOf))
      if (!result.ok) return result
      const snapshot = this.manager.files(ownerId, draftId, result.value)
      const checkedPaths = this.manager.checkedPaths(ownerId, draftId, snapshot)
      return { ok: true, value: snapshot, ...(checkedPaths === null ? {} : { checkedPaths }) }
    })
    this.register('versioning:commit-edit', (event, request) => this.manager.edit(this.owner(event.sender), RemoteReviewSchemas.edit.parse(request), request.messageSource === 'restored-draft' ? 'restored-draft' : 'person-local'))
    this.register('versioning:commit-set-message', (event) => { this.owner(event.sender); throw new Error('Reload the review before editing its shared message') })
    this.register('versioning:commit-decide', (event, request) => this.decide(event.sender, request))
    this.register('versioning:commit-run', (event, request) => request.epoch === undefined || request.expectedRevision === undefined
      ? { ok: false, code: 'stale', detail: 'Reload this review before approving' }
      : this.decide(event.sender, { ...request, epoch: request.epoch, expectedRevision: request.expectedRevision, kind: 'approve', operationId: randomUUID() }))
    this.register('versioning:commit-revert', (event) => { this.owner(event.sender); return { ok: false, code: 'stale', detail: 'Reload the review to confirm exact revision-bound revert targets' } })
    this.register('versioning:commit-tortoise', (event) => { this.owner(event.sender); return { ok: false, code: 'stale', detail: 'Reload the review to open exact revision-bound external targets' } })
    this.register('versioning:commit-cancel', (event) => { this.owner(event.sender); return { ok: false, error: { code: 'invalid-request', detail: 'Reload the review before cancelling' } } })
    this.register('versioning:commit-close', (event, draftId) => this.manager.release(draftId, this.owner(event.sender)))
    this.register('versioning:commit-open-sessions', (event) => { this.owner(event.sender); return this.manager.openSessions() })
    this.assertComplete(ServiceVersioningCommitIpc.channelsConst)
  }

  private decide(sender: WebContents, input: VersioningReviewDecision) {
    const request = RemoteReviewSchemas.decision.parse(input)
    const ownerId = this.owner(sender)
    const draft = this.manager.read(ownerId, request.draftId)
    if (!draft || !this.interactions) return Promise.resolve({ ok: false as const, code: 'forbidden' as const, detail: 'This review is not admitted to the workspace' })
    return this.manager.decide(this.interactions.local(ownerId, draft.sessionId,
      () => !sender.isDestroyed() && this.ownerIdOf(sender) === ownerId), request)
  }

  private owner(sender: WebContents): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('Commit request came from an unknown workspace')
    // A reload keeps draft text and results; only a dead window gives up its ownership.
    this.watchSender(sender, () => this.manager.revokeOwner(ownerId), false)
    return ownerId
  }
}
