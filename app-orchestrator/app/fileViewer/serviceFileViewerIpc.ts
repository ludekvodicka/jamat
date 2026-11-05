import type { ServiceCaller } from '../../../lib-orchestrator/clientApi/serviceTransport.types'
import type { FileViewerOpenResult, FileViewerDirectoryResult, FileViewerResourceResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'

import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import { ServiceIpcBase } from '../../../lib-orchestrator/clientApi/serviceIpcBase'
import type { FileViewerAccess } from './fileViewerAccess'

export class ServiceFileViewerIpc extends ServiceIpcBase<
  typeof ServiceFileViewerIpc.channelsConst
> {
  static readonly channelsConst = {
    'fileViewer:open-workspace': true,
    'fileViewer:restore': true,
    'fileViewer:text': true,
    'fileViewer:version': true,
    'fileViewer:toggle-task': true,
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
    'fileViewer:release': true,
  } as const

  private readonly viewer: FileViewer
  private readonly access: FileViewerAccess
  private readonly ownerIdOf: (caller: ServiceCaller) => string | null

  constructor(viewer: FileViewer, access: FileViewerAccess, ownerIdOf: (caller: ServiceCaller) => string | null) {
    super()
    this.owners = new Map()
    this.viewer = viewer
    this.access = access
    this.ownerIdOf = ownerIdOf
  }

  private readonly owners: Map<string, string>

  initialize(): void {
    this.transport.onCaller('gone', caller => {
      const ownerId = this.owners.get(caller.id)
      this.owners.delete(caller.id)
      if (ownerId !== undefined) this.viewer.revokeOwner(ownerId)
    })
    this.register('fileViewer:open-workspace', (event, sessionId, path, supportsDiff) =>
      this.granted(event, this.access.openWorkspace(this.ownerId(event), sessionId, path, supportsDiff)))
    this.register('fileViewer:restore', (event, source, supportsDiff) =>
      this.granted(event, this.access.restore(this.ownerId(event), source, supportsDiff)))
    this.register('fileViewer:text', (event, documentId) =>
      this.viewer.text(this.ownerId(event), documentId))
    this.register('fileViewer:version', (event, documentId) =>
      this.viewer.version(this.ownerId(event), documentId))
    this.register('fileViewer:toggle-task', (event, request) =>
      this.viewer.toggleTask(this.ownerId(event), request))
    this.register('fileViewer:chunk', (event, documentId, offset) =>
      this.viewer.chunk(this.ownerId(event), documentId, offset))
    this.register('fileViewer:root-directory', (event, sessionId) =>
      this.granted(event, this.access.rootDirectory(this.ownerId(event), sessionId)))
    this.register('fileViewer:project-directory', (event, sessionId) =>
      this.granted(event, this.access.projectDirectory(this.ownerId(event), sessionId)))
    this.register('fileViewer:directory-at', (event, sessionId, path) =>
      this.granted(event, this.access.directoryAt(this.ownerId(event), sessionId, path)))
    this.register('fileViewer:document-directory', (event, documentId) =>
      this.granted(event, this.viewer.directoryForDocument(this.ownerId(event), documentId)))
    this.register('fileViewer:directory-entry', (event, directoryId, entryId) =>
      this.granted(event, this.viewer.directoryEntry(this.ownerId(event), directoryId, entryId)))
    this.register('fileViewer:parent-directory', (event, directoryId) =>
      this.granted(event, this.viewer.parentDirectory(this.ownerId(event), directoryId)))
    this.register('fileViewer:open-entry', (event, directoryId, entryId) =>
      this.granted(event, this.viewer.openFileEntry(this.ownerId(event), directoryId, entryId)))
    this.register('fileViewer:media-resource', (event, documentId) =>
      this.granted(event, this.viewer.mediaResource(this.ownerId(event), documentId)))
    this.register('fileViewer:relative-resource', (event, documentId, reference) =>
      this.granted(event, this.viewer.relativeResource(this.ownerId(event), documentId, reference)))
    this.register('fileViewer:release', (event, documentId) =>
      this.viewer.release(this.ownerId(event), documentId))
    this.assertComplete(ServiceFileViewerIpc.channelsConst)
  }

  private async granted<T extends FileViewerOpenResult | FileViewerDirectoryResult | FileViewerResourceResult>(caller: ServiceCaller, pending: Promise<T>): Promise<T> {
    const ownerId = this.owners.get(caller.id)!
    const result = await pending
    if (this.transport.isCurrent(caller)) return result
    if (result.ok) {
      const value = result.value
      if ('documentId' in value) this.viewer.releaseGrant(ownerId, value.documentId)
      else if ('directoryId' in value) this.viewer.releaseGrant(ownerId, value.directoryId)
      else if ('resourceId' in value) this.viewer.releaseGrant(ownerId, value.resourceId)
      else throw new Error('Unknown file viewer grant')
    }
    throw new Error('The renderer is no longer available')
  }

  private ownerId(caller: ServiceCaller): string {
    const ownerId = this.ownerIdOf(caller)
    if (ownerId === null) throw new Error('File viewer request came from an unknown workspace')
    this.owners.set(caller.id, ownerId)
    return ownerId
  }
}
