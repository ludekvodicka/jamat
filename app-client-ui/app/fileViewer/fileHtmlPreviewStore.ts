import { randomUUID } from 'node:crypto'

import { FileViewerLimits } from '../../../lib-orchestrator/fileViewer/fileViewerLimits'

interface StoredHtmlPreview {
  ownerId: string
  bytes: Uint8Array
}

/**
 * Bounded in-memory backing store for opt-in scripted HTML previews.
 *
 * Each preview is served from its own ephemeral `jamat-v3-html://<previewId>/` origin so its CSP
 * stays separate from the shell's and its scripts cannot reach the parent window or another preview.
 */
export class FileHtmlPreviewStore {
  static readonly maxEntriesConst = 32
  static readonly maxBytesConst = FileViewerLimits.htmlBytes + 1024 * 1024
  private readonly entries = new Map<string, StoredHtmlPreview>()

  register(ownerId: string, html: string): string {
    if (typeof html !== 'string') throw new Error('HTML preview content must be a string')
    const bytes = Buffer.from(html, 'utf8')
    if (bytes.byteLength > FileHtmlPreviewStore.maxBytesConst)
      throw new Error(`HTML preview exceeds ${FileHtmlPreviewStore.maxBytesConst} bytes`)
    while (this.entries.size >= FileHtmlPreviewStore.maxEntriesConst) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    const previewId = randomUUID()
    this.entries.set(previewId, { ownerId, bytes })
    return previewId
  }

  read(previewId: string): Uint8Array | null {
    return this.entries.get(previewId)?.bytes ?? null
  }

  release(ownerId: string, previewId: string): void {
    const entry = this.entries.get(previewId)
    if (entry?.ownerId === ownerId) this.entries.delete(previewId)
  }

  revokeOwner(ownerId: string): void {
    for (const [previewId, entry] of this.entries)
      if (entry.ownerId === ownerId) this.entries.delete(previewId)
  }

  clear(): void {
    this.entries.clear()
  }
}
