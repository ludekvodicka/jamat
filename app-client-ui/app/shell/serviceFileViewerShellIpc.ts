import { app, shell, type WebContents } from 'electron'
import type { OrchestratorNativeApi } from '../../../lib-orchestrator/clientApi/orchestratorProcess.types'
import type { FileViewerExportFormat, FileViewerExportResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'

type NativeViewer = { path: OrchestratorNativeApi['viewerPath']; imageDragPath: OrchestratorNativeApi['viewerImageDragPath'] }
import type { ServiceCaller } from '../shared/serviceTransport.types'
import { ClipboardAccess } from '../shared/clipboardAccess'
import { ErrorText } from '../../shared/errorText'
import type { DocumentExport } from './documentExport'
import { ElectronServiceIpcBase } from './electronServiceIpcBase'

export class ServiceFileViewerShellIpc extends ElectronServiceIpcBase<typeof ServiceFileViewerShellIpc.channelsConst> {
  static readonly channelsConst = {
    'fileViewer:copy-path': true,
    'fileViewer:export': true,
    'fileViewer:start-image-drag': true,
    'fileViewer:open-external': true,
  } as const
  private readonly viewer: NativeViewer
  private readonly ownerIdOf: (sender: WebContents) => string | null
  private readonly exporter: Pick<DocumentExport, 'write'>

  constructor(viewer: NativeViewer, ownerIdOf: (sender: WebContents) => string | null, exporter: Pick<DocumentExport, 'write'>) {
    super()
    this.viewer = viewer
    this.ownerIdOf = ownerIdOf
    this.exporter = exporter
  }

  initialize(): void {
    this.register('fileViewer:copy-path', (caller, documentId) => this.copyPath(caller, documentId))
    this.register('fileViewer:export', (caller, documentId, format, html) => this.exportDocument(caller, documentId, format, html))
    this.register('fileViewer:start-image-drag', (caller, documentId) => this.startImageDrag(caller, documentId))
    this.register('fileViewer:open-external', (caller, url) => {
      this.ownerId(caller)
      return this.openExternal(url)
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

  private ownerId(caller: ServiceCaller): string {
    const ownerId = this.ownerIdOf(this.sender(caller))
    if (ownerId === null) throw new Error('File viewer request came from an unknown workspace')
    return ownerId
  }
}
