import type { RemoteFileRequest, RemoteContentCursor, RemoteContentPage } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteContentPages } from './remoteContentPages'
import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { FileViewerDocumentSource, FileViewerOpenResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { FileViewerAccess } from '../fileViewer/fileViewerAccess'
import type { RemoteSessionInteraction } from './remoteSessionViews'
import type { TabFileOpenResolver } from '../tabs/tabFileOpenResolver'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { join, isAbsolute } from 'node:path'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'

export class RemoteContentAccess {
  private readonly access: FileViewerAccess
  private readonly viewer: FileViewer
  private readonly paths?: TabFileOpenResolver
  private readonly sessions?: Pick<SessionManager, 'snapshot' | 'workingContext'>
  private readonly pages = new RemoteContentPages()
  private readonly active = new Map<string, AbortController>()
  private readonly reading = new Map<string, number>()
  private readonly sources = new Map<string, Set<string>>()

  constructor(access: FileViewerAccess, viewer: FileViewer, paths?: TabFileOpenResolver, sessions?: RemoteContentAccess['sessions']) {
    this.access = access
    this.viewer = viewer
    this.paths = paths
    this.sessions = sessions
  }

  async request(view: RemoteSessionInteraction, request: RemoteFileRequest): Promise<RemoteControlStepResult<RemoteContentPage>> {
    const owner = RemoteContentAccess.owner(view)
    let controller = this.active.get(owner)
    if (!controller) { controller = new AbortController(); this.active.set(owner, controller) }
    const value = await this.perform(view, request, controller.signal)
    if (controller.signal.aborted) {
      this.viewer.revokeOwner(owner)
      this.paths?.release(owner)
      return { ok: false, error: { code: 'unavailable', detail: 'Source view was released' } }
    }
    return this.pages.put(owner, value)
  }

  page(view: RemoteSessionInteraction, cursor: RemoteContentCursor): RemoteControlStepResult<RemoteContentPage> {
    return this.pages.read(RemoteContentAccess.owner(view), cursor)
  }

  private async perform(view: RemoteSessionInteraction, request: RemoteFileRequest, signal: AbortSignal): Promise<unknown> {
    const owner = RemoteContentAccess.owner(view)
    if (request.kind === 'conflict' || request.kind === 'merge-brief') {
      const action = this.sessions?.snapshot().sessions.find((entry) => entry.sessionId === view.sessionId)?.svnAction
      if (request.kind === 'merge-brief')
        return action?.mergeBrief ? this.viewer.openDetected(owner, view.sessionId, null, action.mergeBrief)
          : { ok: false, code: 'not-found', detail: 'The source session has no merger brief' }
      if (!action?.conflicts?.entries.some((entry) => entry.path === request.path))
        return { ok: false, code: 'invalid-source', detail: 'This path is not in the source conflict set' }
      const context = await this.sessions!.workingContext(view.sessionId)
      if (!context.ok || !context.value.worktree) return { ok: false, code: 'invalid-source', detail: 'The source worktree is unavailable' }
      const root = context.value.worktree.worktreePath
      const absolute = join(root, request.path)
      if (!request.path || isAbsolute(request.path) || !PathCompare.isInside(root, absolute))
        return { ok: false, code: 'outside-root', detail: 'The conflict path is outside its source worktree' }
      return this.viewer.openDetected(owner, view.sessionId, root, absolute)
    }
    if (request.kind === 'detect') {
      if (!this.paths) throw new Error('Source path detection is unavailable')
      return this.paths.detect(owner, view.sessionId, request.capture)
    }
    else if (request.kind === 'detected-file' || request.kind === 'detected-directory') {
      if (!this.paths) throw new Error('Source path detection is unavailable')
      return this.paths.detected(owner, view.sessionId, request.requestId, request.detectionId, request.kind === 'detected-file' ? 'file' : 'directory')
    }
    else if (request.kind === 'restore') return this.restore(view, request.source, request.supportsDiff)
    else if (request.kind === 'release') { this.viewer.release(owner, request.documentId); return null }
    else if (request.kind === 'version') return this.viewer.version(owner, request.documentId)
    else if (request.kind === 'resource-metadata') {
      const metadata = await this.viewer.resourceMetadata(request.resourceId, owner)
      return metadata.kind === 'ready' && metadata.resource.contentVersion !== request.version ? { kind: 'changed' } : metadata
    }
    else if (request.kind === 'bytes' || request.kind === 'resource-bytes') {
      const endpoint = JSON.stringify([view.peerId, view.epoch])
      const count = this.reading.get(endpoint) ?? 0
      if (count >= 4) throw new Error('This endpoint already has four content reads in flight')
      this.reading.set(endpoint, count + 1)
      try {
        const read = request.kind === 'bytes'
          ? await this.viewer.readBytes(owner, request.documentId, request.version, request.offset, request.length, signal)
          : await this.viewer.readResourceBytes(request.resourceId, request.version, request.offset, request.length, signal, owner)
        return read.ok ? { ok: true, value: { version: read.value.contentVersion, offset: read.value.offset,
          length: read.value.length, totalSize: read.value.totalSize, eof: read.value.eof, base64: Buffer.from(read.value.bytes).toString('base64') } } : read
      } finally {
        const remaining = this.reading.get(endpoint)! - 1
        if (remaining === 0) this.reading.delete(endpoint)
        else this.reading.set(endpoint, remaining)
      }
    }
    else if (request.kind === 'root-directory') return this.access.rootDirectory(owner, view.sessionId)
    else if (request.kind === 'project-directory') return this.access.projectDirectory(owner, view.sessionId)
    else if (request.kind === 'directory-at') return this.access.directoryAt(owner, view.sessionId, request.path)
    else if (request.kind === 'document-directory') return this.viewer.directoryForDocument(owner, request.documentId)
    else if (request.kind === 'directory-entry') return this.viewer.directoryEntry(owner, request.directoryId, request.entryId)
    else if (request.kind === 'parent-directory') return this.viewer.parentDirectory(owner, request.directoryId)
    else if (request.kind === 'open-entry') return this.viewer.openFileEntry(owner, request.directoryId, request.entryId)
    else if (request.kind === 'export') return this.viewer.exportResource(owner, request.documentId)
    else if (request.kind === 'media') return this.viewer.mediaResource(owner, request.documentId)
    else if (request.kind === 'relative') return this.viewer.relativeResource(owner, request.documentId, request.reference)
    else throw new Error(`Unknown file request: ${JSON.stringify(request)}`)
  }

  async restore(view: RemoteSessionInteraction, source: FileViewerDocumentSource, supportsDiff: boolean): Promise<FileViewerOpenResult> {
    if (!await this.allowsSource(view, source))
      return { ok: false, code: 'invalid-source', detail: 'The file has no source proof for this view' }
    if (source.kind === 'detected') {
      const action = this.sessions?.snapshot().sessions.find((entry) => entry.sessionId === view.sessionId)?.svnAction
      if (action?.mergeBrief && PathCompare.comparable(action.mergeBrief) === PathCompare.comparable(source.path))
        return this.viewer.openDetected(RemoteContentAccess.owner(view), view.sessionId, null, action.mergeBrief)
      if (action?.conflicts) {
        const context = await this.sessions!.workingContext(view.sessionId)
        const root = context.ok ? context.value.worktree?.worktreePath : undefined
        if (root && action.conflicts.entries.some((entry) => !isAbsolute(entry.path)
          && PathCompare.isInside(root, join(root, entry.path))
          && PathCompare.comparable(join(root, entry.path)) === PathCompare.comparable(source.path)))
          return this.viewer.openDetected(RemoteContentAccess.owner(view), view.sessionId, root, source.path)
      }
    }
    return this.access.restore(RemoteContentAccess.owner(view), source, supportsDiff)
  }

  async allowsSource(view: RemoteSessionInteraction, source: FileViewerDocumentSource): Promise<boolean> {
    return source.sessionId === view.sessionId && (!source.workingTree
      || this.sources.get(RemoteContentAccess.owner(view))?.has(JSON.stringify(source)) === true
      || await this.access.containsWorkingTree(source))
  }

  admitSource(view: RemoteSessionInteraction, source: FileViewerDocumentSource): void {
    if (source.sessionId !== view.sessionId) throw new Error('A source proof cannot cross sessions')
    const owner = RemoteContentAccess.owner(view)
    const sources = this.sources.get(owner) ?? new Set<string>()
    if (sources.size >= 256) sources.delete(sources.values().next().value!)
    sources.add(JSON.stringify(source))
    this.sources.set(owner, sources)
  }

  release(view: RemoteSessionInteraction): void {
    const owner = RemoteContentAccess.owner(view)
    this.active.get(owner)?.abort()
    this.active.delete(owner)
    this.pages.release(owner)
    this.paths?.release(owner)
    this.viewer.revokeOwner(owner)
    this.sources.delete(RemoteContentAccess.owner(view))
  }

  static owner(view: RemoteSessionInteraction): string {
    return JSON.stringify(['session-view', view.peerId, view.epoch, view.sessionId, view.viewerId, view.viewId])
  }
}
