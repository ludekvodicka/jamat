import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { FileMediaMetadata, FileMediaSource } from './fileMediaSource'

export class LocalFileMediaSource implements FileMediaSource {
  private readonly viewer: FileViewer

  constructor(viewer: FileViewer) { this.viewer = viewer }

  async metadata(token: string): Promise<FileMediaMetadata> {
    const found = await this.viewer.resourceMetadata(token)
    if (found.kind === 'missing' || found.kind === 'changed') return found
    else if (found.kind === 'ready') return { kind: 'ready', mimeType: found.resource.mimeType, size: found.resource.size, version: found.resource.contentVersion }
    else throw new Error(`Unknown media metadata: ${JSON.stringify(found)}`)
  }

  async read(token: string, version: string, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const answer = await this.viewer.readResourceBytes(token, version, offset, length, signal)
    if (!answer.ok) throw new Error(answer.detail)
    return answer.value.bytes
  }
}
