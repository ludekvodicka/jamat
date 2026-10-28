import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileMediaSource } from './fileMediaSource'
import { FileViewerExport } from './fileViewerExport'

export class FileViewerDragExport {
  private readonly directory: string
  private readonly source: FileMediaSource
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private static readonly extensions: Readonly<Record<string, string>> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/x-icon': '.ico',
  }

  constructor(directory: string, source: FileMediaSource) {
    this.directory = directory
    this.source = source
  }

  copy(token: string, signal: AbortSignal): Promise<string> {
    const pending = this.queue.then(async () => {
      if (this.closed) throw new Error('Image export is closing')
      const metadata = await this.source.metadata(token)
      if (metadata.kind !== 'ready') throw new Error('Source image is unavailable or changed')
      const extension = FileViewerDragExport.extensions[metadata.mimeType]
      if (!extension) throw new Error('Only source images can be dragged')
      if (metadata.size > 32 * 1024 * 1024) throw new Error('Drag supports images up to 32 MiB; use Save copy for larger files')
      await mkdir(this.directory, { recursive: true })
      await this.prune(false)
      const path = join(this.directory, `${randomUUID()}${extension}`)
      await new FileViewerExport(this.source).save(token, path, signal)
      return path
    })
    this.queue = pending.catch(() => {})
    return pending
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.queue
    await this.prune(true)
  }

  private async prune(all: boolean): Promise<void> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const files = await Promise.all(names.filter((name) => /^[0-9a-f-]{36}\.(png|jpg|gif|webp|bmp|svg|avif|ico)(\.[0-9a-f-]{36}\.partial)?$/.test(name))
      .map(async (name) => ({ path: join(this.directory, name), info: await stat(join(this.directory, name)) })))
    files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    let bytes = 0
    for (const [index, file] of files.entries()) {
      bytes += file.info.size
      if (all || index >= 15 || bytes > 96 * 1024 * 1024 || file.info.mtimeMs < Date.now() - 20 * 60_000)
        await rm(file.path, { force: true })
    }
  }
}
