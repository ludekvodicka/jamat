import { app, shell, type WebContents } from 'electron'
import type { OrchestratorNativeApi } from '../../../lib-orchestrator/clientApi/orchestratorProcess.types'
import type { FileViewerExportFormat, FileViewerExportResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'

type NativeViewer = { path: OrchestratorNativeApi['viewerPath']; imageDragPath: OrchestratorNativeApi['viewerImageDragPath'] }
import type { ServiceCaller } from '../shared/serviceTransport.types'
import { ClipboardAccess } from '../shared/clipboardAccess'
import { ErrorText } from '../../shared/errorText'
import type { FileHtmlPreviewStore } from '../fileViewer/fileHtmlPreviewStore'
import type { FileViewerDragExport } from '../fileViewer/fileViewerDragExport'
import type { DocumentExport } from './documentExport'
import { ElectronServiceIpcBase } from './electronServiceIpcBase'

export class ServiceFileViewerShellIpc extends ElectronServiceIpcBase<typeof ServiceFileViewerShellIpc.channelsConst> {
  static readonly channelsConst = {
    'fileViewer:copy-path': true,
    'fileViewer:export': true,
    'fileViewer:start-image-drag': true,
    'fileViewer:start-resource-drag': true,
    'fileViewer:open-external': true,
    'fileViewer:register-html-preview': true,
    'fileViewer:release-html-preview': true,
  } as const
  private static readonly resourceDragMillisecondsConst = 30_000
  private readonly viewer: NativeViewer
  private readonly ownerIdOf: (sender: WebContents) => string | null
  private readonly exporter: Pick<DocumentExport, 'write'>
  private readonly drag: Pick<FileViewerDragExport, 'copy'>
  private readonly htmlPreviews: Pick<FileHtmlPreviewStore, 'register' | 'release'>

  constructor(viewer: NativeViewer, ownerIdOf: (sender: WebContents) => string | null, exporter: Pick<DocumentExport, 'write'>,
    drag: Pick<FileViewerDragExport, 'copy'>, htmlPreviews: Pick<FileHtmlPreviewStore, 'register' | 'release'>) {
    super()
    this.viewer = viewer
    this.ownerIdOf = ownerIdOf
    this.exporter = exporter
    this.drag = drag
    this.htmlPreviews = htmlPreviews
  }

  initialize(): void {
    this.register('fileViewer:copy-path', (caller, documentId) => this.copyPath(caller, documentId))
    this.register('fileViewer:export', (caller, documentId, format, html) => this.exportDocument(caller, documentId, format, html))
    this.register('fileViewer:start-image-drag', (caller, documentId) => this.startImageDrag(caller, documentId))
    this.register('fileViewer:start-resource-drag', (caller, resourceId) => this.startResourceDrag(caller, resourceId))
    this.register('fileViewer:open-external', (caller, url) => {
      this.ownerId(caller)
      return this.openExternal(url)
    })
    this.register('fileViewer:register-html-preview', (caller, html) => {
      const ownerId = this.ownerId(caller)
      return this.htmlPreviews.register(ownerId, html)
    })
    this.register('fileViewer:release-html-preview', (caller, previewId) => {
      const ownerId = this.ownerId(caller)
      if (typeof previewId === 'string' && previewId.length > 0) this.htmlPreviews.release(ownerId, previewId)
    })
    this.assertComplete(ServiceFileViewerShellIpc.channelsConst)
  }

  private async copyPath(caller: ServiceCaller, documentId: string): Promise<boolean> {
    const ownerId = this.ownerId(caller)
    const found = await this.viewer.path(ownerId, documentId)
    if (!this.transport.isCurrent(caller) || this.ownerId(caller) !== ownerId) return false
    if (!found.ok) return false
    return ClipboardAccess.writeText(found.path)
  }

  private async exportDocument(caller: ServiceCaller, documentId: string, format: FileViewerExportFormat, html: string): Promise<FileViewerExportResult> {
    const ownerId = this.ownerId(caller)
    if (format !== 'html' && format !== 'pdf') throw new Error(`Unknown export format: ${JSON.stringify(format)}`)
    if (typeof html !== 'string') throw new Error('The exported document must be HTML text')
    const found = await this.viewer.path(ownerId, documentId)
    if (!found.ok) return { ok: false, detail: found.detail }
    let path: string
    try { path = await this.exporter.write(found.path, format, html) }
    catch (error) { return { ok: false, detail: ErrorText.of(error) } }
    return { ok: true, path, pathCopied: await ClipboardAccess.writeText(path) }
  }

  private async openExternal(value: string): Promise<boolean> {
    let url: URL
    try { url = new URL(value) }
    catch { return false }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    await shell.openExternal(url.toString())
    return true
  }

  private async startImageDrag(caller: ServiceCaller, documentId: string): Promise<boolean> {
    const ownerId = this.ownerId(caller)
    const sender = this.sender(caller)
    const path = await this.viewer.imageDragPath(ownerId, documentId)
    if (path === null) return false
    const icon = await app.getFileIcon(path, { size: 'normal' })
    // The window or grant can disappear while the OS retrieves the file icon.
    if (!this.transport.isCurrent(caller) || sender.isDestroyed() || this.ownerIdOf(sender) !== ownerId || icon.isEmpty()) return false
    if (await this.viewer.imageDragPath(ownerId, documentId) !== path) return false
    if (!this.transport.isCurrent(caller) || sender.isDestroyed() || this.ownerIdOf(sender) !== ownerId) return false
    sender.startDrag({ file: path, icon })
    return true
  }

  /**
   * The resource id is the grant the file protocol already serves to this renderer, so holding it is
   * the permission; the drag export copies its bytes and refuses anything that is not a source image.
   */
  private async startResourceDrag(caller: ServiceCaller, resourceId: string): Promise<boolean> {
    const ownerId = this.ownerId(caller)
    const sender = this.sender(caller)
    if (typeof resourceId !== 'string' || resourceId.length === 0) throw new Error('The dragged image has no resource id')
    const path = await this.drag.copy(resourceId, AbortSignal.timeout(ServiceFileViewerShellIpc.resourceDragMillisecondsConst))
    const icon = await app.getFileIcon(path, { size: 'normal' })
    if (!this.transport.isCurrent(caller) || sender.isDestroyed() || this.ownerIdOf(sender) !== ownerId || icon.isEmpty()) return false
    sender.startDrag({ file: path, icon })
    return true
  }

  private ownerId(caller: ServiceCaller): string {
    const ownerId = this.ownerIdOf(this.sender(caller))
    if (ownerId === null) throw new Error('File viewer request came from an unknown workspace')
    return ownerId
  }
}
