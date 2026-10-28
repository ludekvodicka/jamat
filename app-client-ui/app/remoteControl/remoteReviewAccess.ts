import type { VersioningCommitOpenResult } from '../../shared/versioningCommit'
import { VersioningCommitPaths, VersioningCommitReceipts } from '../../shared/versioningCommit'
import type { FileViewerDocumentSource } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteReviewRequest } from '../../../lib-orchestrator/remoteControl/remoteReviewApi.types'
import type { RemoteContentCursor } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { VersioningCommitManager } from '../versioning/versioningCommitManager'
import type { ReviewInteractionAccess } from '../versioning/reviewInteractionAccess'
import type { FileChangesAccess } from '../fileChanges/fileChangesAccess'
import type { RemoteSessionInteraction } from './remoteSessionViews'
import { RemoteContentAccess } from './remoteContentAccess'
import { RemoteContentPages } from './remoteContentPages'

export class RemoteReviewAccess {
  private readonly manager: VersioningCommitManager
  private readonly interactions: ReviewInteractionAccess
  private readonly files: Pick<FileChangesAccess, 'workingTree'>
  private readonly active: (view: RemoteSessionInteraction) => boolean
  private readonly admit: (view: RemoteSessionInteraction, source: FileViewerDocumentSource) => void
  private readonly pages = new RemoteContentPages()
  private readonly creating = new Map<string, Promise<VersioningCommitOpenResult>>()
  private readonly publish: ((sessionId: string, vcs: 'svn' | 'git', result: Extract<VersioningCommitOpenResult, { ok: true }>, openId: string) => Promise<void>) | undefined

  constructor(manager: VersioningCommitManager, interactions: ReviewInteractionAccess,
    files: RemoteReviewAccess['files'], active: RemoteReviewAccess['active'], admit: RemoteReviewAccess['admit'], publish?: RemoteReviewAccess['publish']) {
    this.manager = manager
    this.interactions = interactions
    this.files = files
    this.active = active
    this.admit = admit
    this.publish = publish
  }

  async request(view: RemoteSessionInteraction, request: RemoteReviewRequest) {
    if (!this.active(view)) throw new Error('The source view was revoked')
    const value = await this.perform(view, request)
    if (!this.active(view)) {
      this.release(view)
      throw new Error('The source view was released; accepted work continues')
    }
    return this.pages.put(RemoteContentAccess.owner(view), value)
  }

  page(view: RemoteSessionInteraction, cursor: RemoteContentCursor) { return this.pages.read(RemoteContentAccess.owner(view), cursor) }

  release(view: RemoteSessionInteraction): void {
    const owner = RemoteContentAccess.owner(view)
    this.manager.revokeOwner(owner)
    this.pages.release(owner)
  }

  private async perform(view: RemoteSessionInteraction, request: RemoteReviewRequest): Promise<unknown> {
    const owner = RemoteContentAccess.owner(view)
    if (request.kind === 'create') {
      if (!this.publish) throw new Error('Opening source reviews is unavailable')
      if (request.scopeRoot !== undefined) {
        const scope = await this.files.workingTree(owner, view.sessionId, request.vcs, request.scopeRoot)
        if (!scope.ok) return { ok: false, code: 'no-working-copy', detail: scope.detail }
        if (!this.active(view)) throw new Error('The source view was revoked')
      }
      const key = JSON.stringify([view.sessionId, request.vcs, request.scopeRoot])
      let pending = this.creating.get(key)
      if (!pending) {
        pending = this.manager.prepare(view.sessionId, request.vcs, request.scopeRoot ?? null, null, undefined, { fresh: true })
        this.creating.set(key, pending)
      }
      try {
        const result = await pending
        if (result.ok) {
          this.manager.attach(result.value.draftId, owner)
          await this.publish(view.sessionId, request.vcs, result, request.openId)
        }
        return result
      } finally { if (this.creating.get(key) === pending) this.creating.delete(key) }
    }
    else if (request.kind === 'list') return this.manager.catalog(view.sessionId)
      .map((draft) => view.commitReceipts ? draft : VersioningCommitReceipts.forLegacyPeer(draft))
    else if (request.kind === 'workflow') return this.manager.openWorkflow(view.sessionId, request.vcs, request.scopeRoot, owner)
    else if (request.kind === 'open') return this.manager.openReview(view.sessionId, request.reviewId, owner)
    const id = request.kind === 'edit' ? request.edit.draftId : request.kind === 'decide' ? request.decision.draftId : request.reviewId
    const draft = this.manager.read(owner, id)
    if (!draft || draft.sessionId !== view.sessionId) throw new Error('The review is not attached to this source view')
    if (request.kind === 'read') return view.commitReceipts ? draft : VersioningCommitReceipts.forLegacyPeer(draft)
    else if (request.kind === 'edit') {
      const result = await this.manager.edit(owner, request.edit)
      if (view.commitReceipts) return result
      return result.ok ? { ...result, value: VersioningCommitReceipts.forLegacyPeer(result.value) }
        : { ...result, ...(result.current === undefined ? {} : { current: VersioningCommitReceipts.forLegacyPeer(result.current) }) }
    }
    else if (request.kind === 'decide') {
      const result = await this.manager.decide(this.interactions.peer(view, owner, () => this.active(view)), request.decision)
      if (result.ok && result.reviewId && this.active(view)) this.manager.openReview(view.sessionId, result.reviewId, owner)
      return result
    }
    else if (request.kind === 'release') { this.manager.release(request.reviewId, owner); return null }
    else if (request.kind === 'files') {
      const result = await this.files.workingTree(owner, view.sessionId, draft.source, draft.scopeRoot, true,
        undefined, draft.paths?.map(VersioningCommitPaths.pathOf))
      if (!result.ok) return result
      if (!this.active(view)) throw new Error('The source view was revoked while listing review files')
      const snapshot = this.manager.files(owner, id, result.value)
      for (const entry of snapshot.entries) this.admit(view, { kind: 'workspace', sessionId: view.sessionId, path: entry.path, workingTree: { scopeRoot: draft.scopeRoot, source: draft.source } })
      const checkedPaths = this.manager.checkedPaths(owner, id, snapshot)
      return { ok: true, value: snapshot, ...(checkedPaths === null ? {} : { checkedPaths }) }
    } else throw new Error(`Unknown review request: ${JSON.stringify(request satisfies never)}`)
  }
}
