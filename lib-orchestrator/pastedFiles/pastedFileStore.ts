import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { ErrorText } from '../shared/errorText'

export type PastedFileSaveResult =
  | { ok: true; path: string }
  | { ok: false; detail: string }

/** One piece of a file sent from another computer, in order from offset 0. */
export interface PastedFileChunk {
  fileName: string
  size: number
  offset: number
  bytes: Uint8Array
}

export type PastedFileReceiveResult =
  | { ok: true; kind: 'partial'; received: number }
  | { ok: true; kind: 'complete'; path: string }
  | { ok: false; detail: string }

interface PastedFileUpload {
  sessionId: string
  partialPath: string
  finalPath: string
  size: number
  written: number
  touchedAt: number
}

/**
 * Clipboard content written to disk so an agent can be handed a PATH instead of reading a clipboard.
 *
 * An agent reads the clipboard and the disk of the computer its process runs on. A person pasting
 * into a session on another computer holds the image, or the file a copied path names, on their own
 * computer, so the bytes travel here and the agent is given the saved file: Claude Code and Codex
 * both attach an image whose path arrives as a paste, and read any other file at its path.
 *
 * A clipboard image is kept only as PNG or JPEG, told apart by its signature. A file arrives in
 * chunks, in order, under the name it had there with anything a path could read as structure
 * replaced. Everything expires by age, because the agent reads the file when the path is pasted.
 */
export class PastedFileStore {
  static readonly imageBytesMaxConst = 32 * 1_024 * 1_024
  static readonly keepMillisecondsConst = 14 * 86_400_000
  /** An upload no chunk has reached for this long is dropped with its partial file. */
  static readonly uploadIdleMillisecondsConst = 5 * 60_000
  private static readonly uploadsMaxConst = 16
  private static readonly partialSuffixConst = '.partial'
  private static readonly pngSignatureConst = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  private static readonly jpegSignatureConst = [0xff, 0xd8, 0xff]
  private readonly directory: string
  private readonly now: () => number
  private readonly uploads: Map<string, PastedFileUpload>
  /** One write at a time: a prune must not remove the empty folder another write just made. */
  private queue: Promise<unknown>

  constructor(directory: string, now: () => number = Date.now) {
    this.directory = directory
    this.now = now
    this.uploads = new Map()
    this.queue = Promise.resolve()
  }

  saveImage(sessionId: string, bytes: Uint8Array): Promise<PastedFileSaveResult> {
    return this.serialized(() => this.saveImageNow(sessionId, bytes))
  }

  /**
   * One chunk of a file. `key` names the upload and is the caller's to make unique per sender;
   * offset 0 starts it over. The answer is the path once the last byte has arrived.
   */
  receive(key: string, sessionId: string, chunk: PastedFileChunk): Promise<PastedFileReceiveResult> {
    return this.serialized(() => this.receiveNow(key, sessionId, chunk))
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work)
    this.queue = done.catch(() => undefined)
    return done
  }

  private async saveImageNow(sessionId: string, bytes: Uint8Array): Promise<PastedFileSaveResult> {
    const extension = PastedFileStore.extensionOf(bytes)
    if (extension === null) return { ok: false, detail: 'The clipboard image is not a PNG or JPEG' }
    if (bytes.length > PastedFileStore.imageBytesMaxConst)
      return { ok: false, detail: `The clipboard image exceeds ${PastedFileStore.imageBytesMaxConst} bytes` }
    try {
      await this.prune()
      const path = await this.newPath(sessionId, `clipboard.${extension}`)
      await writeFile(path, bytes, { flag: 'wx' })
      return { ok: true, path }
    } catch (error) {
      return { ok: false, detail: `The clipboard image was not saved: ${ErrorText.of(error)}` }
    }
  }

  private async receiveNow(key: string, sessionId: string, chunk: PastedFileChunk): Promise<PastedFileReceiveResult> {
    try {
      await this.dropIdle()
      if (chunk.offset === 0) {
        await this.drop(key)
        if (this.uploads.size >= PastedFileStore.uploadsMaxConst)
          return { ok: false, detail: 'Too many files are being received at once' }
        await this.prune()
        const finalPath = await this.newPath(sessionId, chunk.fileName)
        const partialPath = `${finalPath}${PastedFileStore.partialSuffixConst}`
        await writeFile(partialPath, new Uint8Array(0), { flag: 'wx' })
        this.uploads.set(key, { sessionId, partialPath, finalPath, size: chunk.size, written: 0, touchedAt: this.now() })
      }
      const upload = this.uploads.get(key)
      if (upload === undefined) return { ok: false, detail: 'The file upload is unknown or expired; paste again' }
      if (upload.sessionId !== sessionId || upload.size !== chunk.size || upload.written !== chunk.offset) {
        await this.drop(key)
        return { ok: false, detail: 'The file upload arrived out of order; paste again' }
      }
      if (upload.written + chunk.bytes.length > upload.size) {
        await this.drop(key)
        return { ok: false, detail: 'The file upload is larger than it said' }
      }
      await appendFile(upload.partialPath, chunk.bytes)
      upload.written += chunk.bytes.length
      upload.touchedAt = this.now()
      if (upload.written < upload.size) return { ok: true, kind: 'partial', received: upload.written }
      this.uploads.delete(key)
      await rename(upload.partialPath, upload.finalPath)
      return { ok: true, kind: 'complete', path: upload.finalPath }
    } catch (error) {
      await this.drop(key).catch(() => undefined)
      return { ok: false, detail: `The file was not saved: ${ErrorText.of(error)}` }
    }
  }

  private async newPath(sessionId: string, fileName: string): Promise<string> {
    const folder = join(this.directory, PastedFileStore.folderOf(sessionId))
    await mkdir(folder, { recursive: true })
    const stamp = PastedFileStore.stampOf(this.now())
    return join(folder, `${stamp}-${randomBytes(3).toString('hex')}-${PastedFileStore.fileNameOf(fileName)}`)
  }

  private async drop(key: string): Promise<void> {
    const upload = this.uploads.get(key)
    if (upload === undefined) return
    this.uploads.delete(key)
    await rm(upload.partialPath, { force: true })
  }

  private async dropIdle(): Promise<void> {
    const cutoff = this.now() - PastedFileStore.uploadIdleMillisecondsConst
    for (const [key, upload] of [...this.uploads])
      if (upload.touchedAt < cutoff) await this.drop(key)
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - PastedFileStore.keepMillisecondsConst
    const folders = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    for (const folder of folders) {
      if (!folder.isDirectory()) continue
      const path = join(this.directory, folder.name)
      const files = await readdir(path, { withFileTypes: true })
      let kept = 0
      for (const file of files) {
        const filePath = join(path, file.name)
        if (file.isFile() && (await stat(filePath)).mtimeMs < cutoff) await rm(filePath, { force: true })
        else kept += 1
      }
      if (kept === 0) await rm(path, { recursive: true, force: true })
    }
  }

  private static extensionOf(bytes: Uint8Array): 'png' | 'jpg' | null {
    if (PastedFileStore.startsWith(bytes, PastedFileStore.pngSignatureConst)) return 'png'
    else if (PastedFileStore.startsWith(bytes, PastedFileStore.jpegSignatureConst)) return 'jpg'
    else return null
  }

  private static startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
    return bytes.length > signature.length && signature.every((byte, index) => bytes[index] === byte)
  }

  /** A session id is a folder name here, so anything a path could read as structure is replaced. */
  private static folderOf(sessionId: string): string {
    return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || '_'
  }

  /** The sender's name without its folders, in characters every agent pastes without quoting. */
  private static fileNameOf(fileName: string): string {
    const name = basename(fileName.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
    return name.slice(-120) || 'file'
  }

  private static stampOf(milliseconds: number): string {
    return new Date(milliseconds).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  }
}
