import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import type { FileMediaSource } from './fileMediaSource'

export class FileViewerExport {
  private readonly source: FileMediaSource

  constructor(source: FileMediaSource) { this.source = source }

  async save(token: string, destination: string, signal: AbortSignal): Promise<void> {
    const metadata = await this.source.metadata(token)
    if (metadata.kind !== 'ready') throw new Error('Source file is unavailable or changed')
    const temporary = `${destination}.${randomUUID()}.partial`
    const file = await open(temporary, 'wx')
    let closed = false
    try {
      for (let offset = 0; offset < metadata.size;) {
        signal.throwIfAborted()
        const length = Math.min(65536, metadata.size - offset)
        const bytes = await this.source.read(token, metadata.version, offset, length, signal)
        if (bytes.length !== length) throw new Error('Source returned an incomplete export range')
        let written = 0
        while (written < bytes.length) {
          const answer = await file.write(bytes, written, bytes.length - written, offset + written)
          if (answer.bytesWritten === 0) throw new Error('Export write made no progress')
          written += answer.bytesWritten
        }
        offset += bytes.length
      }
      const final = await this.source.metadata(token)
      if (final.kind !== 'ready' || final.version !== metadata.version || final.size !== metadata.size) throw new Error('Source changed during export')
      signal.throwIfAborted()
      await file.close(); closed = true
      await rename(temporary, destination)
    } finally {
      if (!closed) await file.close()
      await rm(temporary, { force: true })
    }
  }
}
