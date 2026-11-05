import type { FileChangesAccess } from '../fileChanges/fileChangesAccess'
import type { FileViewerDocumentSource } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteChangesRequest, RemoteContentCursor, RemoteContentPage } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteSessionInteraction } from './remoteSessionViews'
import { RemoteContentAccess } from './remoteContentAccess'
import { RemoteContentPages } from './remoteContentPages'

export class RemoteChangesAccess {
  private readonly access: FileChangesAccess
  private readonly allows: (view: RemoteSessionInteraction, source: FileViewerDocumentSource) => Promise<boolean>
  private readonly admit: (view: RemoteSessionInteraction, source: FileViewerDocumentSource) => void
  private readonly pages = new RemoteContentPages()
  private readonly active = new Map<string, object>()

  constructor(access: FileChangesAccess, allows: RemoteChangesAccess['allows'], admit: RemoteChangesAccess['admit']) {
    this.access = access
    this.allows = allows
    this.admit = admit
  }

  async request(view: RemoteSessionInteraction, request: RemoteChangesRequest): Promise<RemoteControlStepResult<RemoteContentPage>> {
    const owner = RemoteContentAccess.owner(view)
    const token = this.active.get(owner) ?? {}
    this.active.set(owner, token)
    const value = await this.perform(view, request, () => this.active.get(owner) === token)
    if (this.active.get(owner) !== token) return { ok: false, error: { code: 'unavailable', detail: 'Source view was released' } }
    return this.pages.put(owner, value)
  }

  page(view: RemoteSessionInteraction, cursor: RemoteContentCursor): RemoteControlStepResult<RemoteContentPage> {
    return this.pages.read(RemoteContentAccess.owner(view), cursor)
  }

  release(view: RemoteSessionInteraction): void {
    const owner = RemoteContentAccess.owner(view)
    this.active.delete(owner)
    this.pages.release(owner)
    this.access.revokeOwner(owner)
  }

  private async perform(view: RemoteSessionInteraction, request: RemoteChangesRequest, live: () => boolean): Promise<unknown> {
    const owner = RemoteContentAccess.owner(view)
    if (request.kind === 'list') return this.access.list(owner, view.sessionId, request.preferredVcs)
    else if (request.kind === 'working-tree') return this.access.workingTree(owner, view.sessionId, request.source)
    else if (request.kind === 'scoped') {
      const allowed = await this.allows(view, request.source)
      if (!allowed || !live()) return { ok: false, code: 'invalid-context', detail: 'The changes scope has no source proof for this view' }
      return this.access.scopedWorkingTree(owner, request.source)
    }
    else if (request.kind === 'history') return this.access.history(owner, request.snapshotId, request.cursor)
    else if (request.kind === 'diff') return this.access.diff(owner, request.request)
    else if (request.kind === 'open') {
      const opened = await this.access.openFile(owner, request.snapshotId, request.fileId)
      if (opened.ok && live()) this.admit(view, opened.value.source)
      return opened
    }
    else throw new Error(`Unknown changes request: ${JSON.stringify(request)}`)
  }
}
