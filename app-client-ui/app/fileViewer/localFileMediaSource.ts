import { randomUUID } from 'node:crypto'
import type { OrchestratorApi } from '../shared/orchestratorApi.types'
import type { FileMediaMetadata, FileMediaSource } from './fileMediaSource'

export class LocalFileMediaSource implements FileMediaSource {
  private readonly media: Pick<OrchestratorApi, 'mediaMetadata' | 'mediaOpen' | 'mediaCancel'>

  constructor(media: Pick<OrchestratorApi, 'mediaMetadata' | 'mediaOpen' | 'mediaCancel'>) { this.media = media }

  async metadata(token: string): Promise<FileMediaMetadata> {
    return this.media.mediaMetadata(token)
  }

  async read(token: string, version: string, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    const requestId = randomUUID()
    const cancel = (): void => this.media.mediaCancel(requestId)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const answer = await this.media.mediaOpen({ requestId, resourceId: token, version, offset, length })
      signal.throwIfAborted()
      if (!answer.ok) throw new Error(answer.detail)
      return answer.value.bytes
    } finally { signal.removeEventListener('abort', cancel) }
  }
}
