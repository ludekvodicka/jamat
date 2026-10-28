import { randomUUID } from 'node:crypto'
import type { RemoteFileRequest } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteSessionView, RemoteSessionViewRequest, RemoteSessionViewResponse } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { RemoteFileResults } from '../../shared/remoteFileResults'

export class RemoteContentClient {
  private readonly send: (endpointId: string, request: RemoteSessionViewRequest) => Promise<RemoteSessionViewResponse['result']>

  constructor(send: RemoteContentClient['send']) { this.send = send }

  async read<T>(endpointId: string, view: RemoteSessionView, body: RemoteFileRequest, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    let answer = await this.send(endpointId, { ...view, requestId: randomUUID(), operation: 'files.request', body })
    let offset = 0
    let version: string | null = null
    let transferId: string | null = null
    let bytes: Buffer | null = null
    while (true) {
      signal?.throwIfAborted()
      if (!answer.ok) throw new Error(answer.error.detail)
      const page = answer.value
      if (!page || !('transferId' in page)) throw new Error('Invalid content page')
      if (!bytes) {
        if (!Number.isSafeInteger(page.totalBytes) || page.totalBytes < 0 || page.totalBytes > 16 * 1024 * 1024) throw new Error('Invalid content size')
        bytes = Buffer.alloc(page.totalBytes); version = page.version; transferId = page.transferId
      }
      const part = Buffer.from(page.base64, 'base64')
      if (page.offset !== offset || page.totalBytes !== bytes.length || page.version !== version || page.transferId !== transferId
        || part.length === 0 || part.length > 65536 || offset + part.length > bytes.length || part.toString('base64') !== page.base64)
        throw new Error('Invalid content page continuity')
      part.copy(bytes, offset); offset += part.length
      if (offset === bytes.length) break
      answer = await this.send(endpointId, { ...view, requestId: randomUUID(), operation: 'files.page', body: { transferId, version: version!, offset } })
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!RemoteFileResults.valid(body, value)) throw new Error('Malformed remote file response')
    return value as T
  }
}
