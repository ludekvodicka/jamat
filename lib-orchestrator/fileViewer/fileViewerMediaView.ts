import type { FileViewer } from './fileViewer'
import type { FileViewerChunkResult } from './fileViewerApi.types'
import { FileViewerLimits } from './fileViewerLimits'

export interface FileViewerMediaRequest {
  requestId: string
  resourceId: string
  version: string
  offset: number
  length: number
}

export type FileViewerMediaMetadata =
  | { kind: 'ready'; mimeType: string; size: number; version: string }
  | { kind: 'missing' | 'changed' }

export class FileViewerMediaView {
  private readonly viewer: Pick<FileViewer, 'resourceMetadata' | 'readResourceBytes'>
  private readonly requests: Map<string, AbortController>
  private stopped: boolean

  constructor(viewer: Pick<FileViewer, 'resourceMetadata' | 'readResourceBytes'>) {
    this.viewer = viewer
    this.requests = new Map()
    this.stopped = false
  }

  async metadata(resourceId: string): Promise<FileViewerMediaMetadata> {
    if (this.stopped) return { kind: 'missing' }
    const found = await this.viewer.resourceMetadata(resourceId)
    if (found.kind === 'missing' || found.kind === 'changed') return found
    else if (found.kind === 'ready')
      return { kind: 'ready', mimeType: found.resource.mimeType, size: found.resource.size, version: found.resource.contentVersion }
    else throw new Error(`Unknown media metadata: ${JSON.stringify(found)}`)
  }

  async open(request: FileViewerMediaRequest): Promise<FileViewerChunkResult> {
    if (this.stopped) throw new Error('File media is stopping')
    if (this.requests.has(request.requestId)) throw new Error('Media request is already active')
    if (!Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.length)
      || request.length < 1 || request.length > FileViewerLimits.chunkBytes)
      return { ok: false, code: 'invalid-range', detail: 'Byte reads require a non-negative offset and 1 through 65536 bytes' }
    const controller = new AbortController()
    this.requests.set(request.requestId, controller)
    try {
      const answer = await this.viewer.readResourceBytes(request.resourceId, request.version, request.offset, request.length, controller.signal)
      controller.signal.throwIfAborted()
      return answer
    } finally { this.requests.delete(request.requestId) }
  }

  cancel(requestId: string): void { this.requests.get(requestId)?.abort() }

  stop(): void {
    this.stopped = true
    for (const controller of this.requests.values()) controller.abort()
  }
}
