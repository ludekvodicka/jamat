import type { RemoteContentPage } from '../../lib-orchestrator/remoteControl/remoteContentApi.types'

export class RemoteContentRead {
  static decode(base64: string): Uint8Array {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Invalid remote base64')
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  }

  static async collect(first: RemoteContentPage, next: (cursor: Pick<RemoteContentPage, 'transferId' | 'version' | 'offset'>) => Promise<RemoteContentPage>): Promise<Uint8Array> {
    if (!Number.isSafeInteger(first.totalBytes) || first.totalBytes < 0 || first.totalBytes > 16 * 1024 * 1024) throw new Error('Invalid remote content size')
    const bytes = new Uint8Array(first.totalBytes)
    let offset = 0
    let page = first
    while (true) {
      const part = RemoteContentRead.decode(page.base64)
      if (page.transferId !== first.transferId || page.version !== first.version || page.totalBytes !== first.totalBytes || page.offset !== offset
        || part.length > 64 * 1024 || offset + part.length > bytes.length || part.length === 0 && bytes.length !== 0)
        throw new Error('Invalid remote content page')
      bytes.set(part, offset)
      offset += part.length
      if (offset === bytes.length) return bytes
      page = await next({ transferId: first.transferId, version: first.version, offset })
    }
  }
}
