import type { NativeImage, WebContents } from 'electron'
import type { FileViewerResourceResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { FileViewerDragExport } from '../fileViewer/fileViewerDragExport'
import type { RemoteFileMediaSource } from '../fileViewer/remoteFileMediaSource'
import type { RemoteContentClient } from './remoteContentClient'

export class RemoteNativeActions {
  private readonly content: Pick<RemoteContentClient, 'read'>
  private readonly media: Pick<RemoteFileMediaSource, 'issue' | 'releaseToken' | 'metadata'>
  private readonly drag: Pick<FileViewerDragExport, 'copy'>
  private readonly icon: (path: string) => Promise<NativeImage>
  private readonly selectFile: (defaultPath: string) => Promise<{ canceled: boolean; filePath?: string }>
  private readonly save: (resourceId: string, path: string, signal: AbortSignal) => Promise<void>
  private readonly accepts: (sender: WebContents) => boolean

  constructor(deps: { content: RemoteNativeActions['content']; media: RemoteNativeActions['media']; drag: RemoteNativeActions['drag'];
    icon: RemoteNativeActions['icon']; selectFile: RemoteNativeActions['selectFile']; save: RemoteNativeActions['save']; accepts: RemoteNativeActions['accepts'] }) {
    this.content = deps.content
    this.media = deps.media
    this.drag = deps.drag
    this.icon = deps.icon
    this.selectFile = deps.selectFile
    this.save = deps.save
    this.accepts = deps.accepts
  }

  async startImageDrag(sender: WebContents, endpointId: string, view: RemoteSessionView, documentId: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.content.read<FileViewerResourceResult>(endpointId, view, { kind: 'media', documentId }, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new Error(result.detail)
    const resource = this.media.issue(endpointId, view, documentId, result.value)
    const release = (): void => this.media.releaseToken(resource.resourceId)
    signal.addEventListener('abort', release, { once: true })
    try {
      const path = await this.drag.copy(resource.resourceId, signal)
      const icon = await this.icon(path)
      signal.throwIfAborted()
      if (sender.isDestroyed() || !this.accepts(sender) || icon.isEmpty()
        || (await this.media.metadata(resource.resourceId)).kind !== 'ready') return false
      signal.throwIfAborted()
      sender.startDrag({ file: path, icon })
      return true
    } finally { signal.removeEventListener('abort', release); release() }
  }

  async exportFile(sender: WebContents, endpointId: string, view: RemoteSessionView, documentId: string, name: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.content.read<FileViewerResourceResult>(endpointId, view, { kind: 'export', documentId }, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new Error(result.detail)
    const resource = this.media.issue(endpointId, view, documentId, result.value)
    const release = (): void => this.media.releaseToken(resource.resourceId)
    signal.addEventListener('abort', release, { once: true })
    try {
      const selected = await this.selectFile(name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 255))
      signal.throwIfAborted()
      if (selected.canceled || !selected.filePath || sender.isDestroyed() || !this.accepts(sender)) return false
      await this.save(resource.resourceId, selected.filePath, signal)
      return true
    } finally { signal.removeEventListener('abort', release); release() }
  }

  async mediaResource(endpointId: string, view: RemoteSessionView, documentId: string, reference: string | null, signal: AbortSignal): Promise<FileViewerResourceResult> {
    const result = await this.content.read<FileViewerResourceResult>(endpointId, view, reference === null
      ? { kind: 'media', documentId } : { kind: 'relative', documentId, reference }, signal)
    signal.throwIfAborted()
    return result.ok ? { ok: true, value: this.media.issue(endpointId, view, documentId, result.value) } : result
  }
}
