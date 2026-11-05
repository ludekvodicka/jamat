import type { WebContents } from 'electron'
import type { FileViewerResourceResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { ElectronServiceIpcBase } from '../shell/electronServiceIpcBase'

export interface ServiceRemoteControlIpcDeps {
  authorizeView(sender: WebContents, endpointId: string, viewId: string): Promise<{ view: RemoteSessionView; signal: AbortSignal } | null>
  startImageDrag(sender: WebContents, endpointId: string, view: RemoteSessionView, documentId: string, signal: AbortSignal): Promise<boolean>
  exportFile(sender: WebContents, endpointId: string, view: RemoteSessionView, documentId: string, name: string, signal: AbortSignal): Promise<boolean>
  mediaResource(endpointId: string, view: RemoteSessionView, documentId: string, reference: string | null, signal: AbortSignal): Promise<FileViewerResourceResult>
  acceptsRenderer(sender: WebContents): boolean
}

export class ServiceRemoteControlIpc extends ElectronServiceIpcBase<typeof ServiceRemoteControlIpc.channelsConst> {
  static readonly channelsConst = {
    'remote:start-image-drag': true,
    'remote:export-file': true,
    'remote:media-resource': true,
  } as const
  private readonly deps: ServiceRemoteControlIpcDeps

  constructor(deps: ServiceRemoteControlIpcDeps) { super(); this.deps = deps }

  initialize(): void {
    this.register('remote:start-image-drag', async (event, endpointId, viewId, documentId) => {
      const held = await this.view(this.sender(event), endpointId, viewId)
      return this.deps.startImageDrag(this.sender(event), endpointId, held.view, documentId, held.signal)
    })
    this.register('remote:export-file', async (event, endpointId, viewId, documentId, name) => {
      const held = await this.view(this.sender(event), endpointId, viewId)
      return this.deps.exportFile(this.sender(event), endpointId, held.view, documentId, name, held.signal)
    })
    this.register('remote:media-resource', async (event, endpointId, viewId, documentId, reference) => {
      const held = await this.view(this.sender(event), endpointId, viewId)
      return this.deps.mediaResource(endpointId, held.view, documentId, reference, held.signal)
    })
    this.assertComplete(ServiceRemoteControlIpc.channelsConst)
  }

  private async view(sender: WebContents, endpointId: string, viewId: string): Promise<{ view: RemoteSessionView; signal: AbortSignal }> {
    if (!this.deps.acceptsRenderer(sender)) throw new Error('The workspace window is closing')
    const view = await this.deps.authorizeView(sender, endpointId, viewId)
    if (!view || view.signal.aborted || sender.isDestroyed() || !this.deps.acceptsRenderer(sender)) throw new Error('Session view is not owned by this renderer')
    return view
  }
}
