import { app, shell, type WebContents } from 'electron'

import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import { ClipboardAccess } from '../shared/clipboardAccess'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { FileViewerAccess } from './fileViewerAccess'

export class ServiceFileViewerIpc extends ServiceIpcBase<
  typeof ServiceFileViewerIpc.channelsConst
> {
  static readonly channelsConst = {
    'fileViewer:open-workspace': true,
    'fileViewer:restore': true,
    'fileViewer:text': true,
    'fileViewer:version': true,
    'fileViewer:chunk': true,
    'fileViewer:root-directory': true,
    'fileViewer:project-directory': true,
    'fileViewer:directory-at': true,
    'fileViewer:document-directory': true,
    'fileViewer:directory-entry': true,
    'fileViewer:parent-directory': true,
    'fileViewer:open-entry': true,
    'fileViewer:media-resource': true,
    'fileViewer:relative-resource': true,
    'fileViewer:copy-path': true,
    'fileViewer:start-image-drag': true,
    'fileViewer:open-external': true,
    'fileViewer:release': true,
  } as const

  private readonly viewer: FileViewer
  private readonly access: FileViewerAccess
  private readonly ownerIdOf: (sender: WebContents) => string | null

  constructor(viewer: FileViewer, access: FileViewerAccess, ownerIdOf: (sender: WebContents) => string | null) {
    super()
    this.viewer = viewer
    this.access = access
    this.ownerIdOf = ownerIdOf
  }

  initialize(): void {
    this.register('fileViewer:open-workspace', (event, sessionId, path, supportsDiff) =>
      this.access.openWorkspace(this.ownerId(event.sender), sessionId, path, supportsDiff))
    this.register('fileViewer:restore', (event, source, supportsDiff) =>
      this.access.restore(this.ownerId(event.sender), source, supportsDiff))
    this.register('fileViewer:text', (event, documentId) =>
      this.viewer.text(this.ownerId(event.sender), documentId))
    this.register('fileViewer:version', (event, documentId) =>
      this.viewer.version(this.ownerId(event.sender), documentId))
    this.register('fileViewer:chunk', (event, documentId, offset) =>
      this.viewer.chunk(this.ownerId(event.sender), documentId, offset))
    this.register('fileViewer:root-directory', (event, sessionId) =>
      this.access.rootDirectory(this.ownerId(event.sender), sessionId))
    this.register('fileViewer:project-directory', (event, sessionId) =>
      this.access.projectDirectory(this.ownerId(event.sender), sessionId))
    this.register('fileViewer:directory-at', (event, sessionId, path) =>
      this.access.directoryAt(this.ownerId(event.sender), sessionId, path))
    this.register('fileViewer:document-directory', (event, documentId) =>
      this.viewer.directoryForDocument(this.ownerId(event.sender), documentId))
    this.register('fileViewer:directory-entry', (event, directoryId, entryId) =>
      this.viewer.directoryEntry(this.ownerId(event.sender), directoryId, entryId))
    this.register('fileViewer:parent-directory', (event, directoryId) =>
      this.viewer.parentDirectory(this.ownerId(event.sender), directoryId))
    this.register('fileViewer:open-entry', (event, directoryId, entryId) =>
      this.viewer.openFileEntry(this.ownerId(event.sender), directoryId, entryId))
    this.register('fileViewer:media-resource', (event, documentId) =>
      this.viewer.mediaResource(this.ownerId(event.sender), documentId))
    this.register('fileViewer:relative-resource', (event, documentId, reference) =>
      this.viewer.relativeResource(this.ownerId(event.sender), documentId, reference))
    this.register('fileViewer:copy-path', (event, documentId) =>
      this.copyPath(this.ownerId(event.sender), documentId))
    this.register('fileViewer:start-image-drag', (event, documentId) =>
      this.startImageDrag(event.sender, documentId))
    this.register('fileViewer:open-external', (event, url) => {
      this.ownerId(event.sender)
      return this.openExternal(url)
    })
    this.register('fileViewer:release', (event, documentId) =>
      this.viewer.release(this.ownerId(event.sender), documentId))
    this.assertComplete(ServiceFileViewerIpc.channelsConst)
  }

  private async copyPath(ownerId: string, documentId: string): Promise<boolean> {
    const found = this.viewer.path(ownerId, documentId)
    if (!found.ok) return false
    return ClipboardAccess.writeText(found.path)
  }

  private async openExternal(value: string): Promise<boolean> {
    let url: URL
    try { url = new URL(value) }
    catch { return false }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    await shell.openExternal(url.toString())
    return true
  }

  private async startImageDrag(sender: WebContents, documentId: string): Promise<boolean> {
    const ownerId = this.ownerId(sender)
    const path = await this.viewer.imageDragPath(ownerId, documentId)
    if (path === null) return false
    const icon = await app.getFileIcon(path, { size: 'normal' })
    // The window or grant can disappear while the OS retrieves the file icon.
    if (sender.isDestroyed() || this.ownerIdOf(sender) !== ownerId || icon.isEmpty()) return false
    if (await this.viewer.imageDragPath(ownerId, documentId) !== path) return false
    if (sender.isDestroyed() || this.ownerIdOf(sender) !== ownerId) return false
    sender.startDrag({ file: path, icon })
    return true
  }

  private ownerId(sender: WebContents): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('File viewer request came from an unknown workspace')
    return ownerId
  }
}
