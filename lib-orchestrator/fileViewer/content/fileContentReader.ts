import { open, readFile, stat } from 'node:fs/promises'
import { TextDecoder } from 'node:util'

import type { FileViewerChunk, FileViewerDocumentKind } from '../fileViewerApi.types'
import { FileViewerLimits } from '../fileViewerLimits'
import { FileFormatRegistry } from './fileFormatRegistry'

export interface FileContentInspection {
  size: number | null
  modifiedAt: number | null
  contentVersion: string | null
  kind: FileViewerDocumentKind
}

export type FileContentTextRead =
  | { kind: 'text'; text: string; contentVersion: string }
  | { kind: 'too-large'; size: number; limit: number }
  | { kind: 'binary'; detail: string }
  | { kind: 'missing' }
  | { kind: 'changed' }

export type FileContentVersionRead =
  | { kind: 'version'; contentVersion: string }
  | { kind: 'missing' }

export type FileContentChunkRead =
  | { kind: 'chunk'; value: FileViewerChunk }
  | { kind: 'missing' }
  | { kind: 'changed' }
  | { kind: 'invalid-range'; detail: string }

/**
 * A path that exists and is not a file.
 *
 * Thrown rather than described, because the facade used to recognise it by
 * `detail.includes('not a file')` - so rewording the sentence below would have turned every "you
 * opened a directory" into `invalid-source`, with nothing failing anywhere.
 */
export class FileContentNotAFileError extends Error {
  constructor(path: string) {
    super(`The path is not a file: ${path}`)
    this.name = 'FileContentNotAFileError'
  }
}

export class FileContentReader {
  async inspect(path: string, allowMissing: boolean): Promise<FileContentInspection> {
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new FileContentNotAFileError(path)
      const handle = await open(path, 'r')
      try {
        const length = Math.min(info.size, FileViewerLimits.sampleBytes)
        const sample = Buffer.alloc(length)
        if (length > 0) await handle.read(sample, 0, length, 0)
        return {
          size: info.size,
          modifiedAt: info.mtimeMs,
          contentVersion: FileContentReader.versionOf(info.size, info.mtimeMs),
          kind: FileFormatRegistry.classify({ path, exists: true, sample }),
        }
      }
      finally { await handle.close() }
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (allowMissing && (code === 'ENOENT' || code === 'ENOTDIR'))
        return {
          size: null,
          modifiedAt: null,
          contentVersion: null,
          kind: { kind: 'missing' },
        }
      throw error
    }
  }

  /**
   * What the file is now, in one `stat` and no bytes: the question a viewer asks on a timer.
   *
   * A path that is no longer a FILE answers `missing` rather than a version, because the version of
   * a directory is a number a caller would then try to read text out of.
   */
  async version(path: string): Promise<FileContentVersionRead> {
    let info
    try { info = await stat(path) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
      throw error
    }
    if (!info.isFile()) return { kind: 'missing' }
    return {
      kind: 'version',
      contentVersion: FileContentReader.versionOf(info.size, info.mtimeMs),
    }
  }

  async text(path: string, expectedVersion: string | null): Promise<FileContentTextRead> {
    let info
    try { info = await stat(path) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
      throw error
    }
    const version = FileContentReader.versionOf(info.size, info.mtimeMs)
    if (expectedVersion !== version) return { kind: 'changed' }
    if (info.size > FileViewerLimits.fullTextBytes)
      return { kind: 'too-large', size: info.size, limit: FileViewerLimits.fullTextBytes }
    const bytes = await readFile(path)
    if (bytes.includes(0)) return { kind: 'binary', detail: 'The file contains NUL bytes' }
    try {
      return {
        kind: 'text',
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        contentVersion: version,
      }
    }
    catch { return { kind: 'binary', detail: 'The file is not valid UTF-8 text' } }
  }

  async chunk(
    path: string,
    expectedVersion: string | null,
    offset: number,
  ): Promise<FileContentChunkRead> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      return { kind: 'invalid-range', detail: 'Chunk offset must be a non-negative integer' }
    let info
    try { info = await stat(path) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
      throw error
    }
    const version = FileContentReader.versionOf(info.size, info.mtimeMs)
    if (expectedVersion !== version) return { kind: 'changed' }
    if (offset > info.size)
      return { kind: 'invalid-range', detail: `Chunk offset ${offset} exceeds file size ${info.size}` }
    const length = Math.min(FileViewerLimits.chunkBytes, info.size - offset)
    const bytes = Buffer.alloc(length)
    const handle = await open(path, 'r')
    try {
      if (length > 0) await handle.read(bytes, 0, length, offset)
    }
    finally { await handle.close() }
    return {
      kind: 'chunk',
      value: {
        bytes,
        offset,
        length,
        totalSize: info.size,
        eof: offset + length >= info.size,
        contentVersion: version,
      },
    }
  }

  /**
   * What "the same file" means to a grant, in one place.
   *
   * The protocol in the client package re-derived this format by hand to decide whether a granted
   * resource still matches the file on disk. Both sides are `string`, so adding an inode or a hash
   * here would have made every `jamat-file://resource/...` answer 409 for a file nobody touched -
   * images and video silently stopping, with typecheck green.
   */
  static versionOf(size: number, modifiedAt: number): string {
    return `${size}:${modifiedAt}`
  }
}
