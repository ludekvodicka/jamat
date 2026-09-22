import { basename, extname } from 'node:path'
import { TextDecoder } from 'node:util'

import type { FileViewerDocumentKind, FileViewerViewMode } from '../fileViewerApi.types'
import { FileViewerLanguages } from '../fileViewerLanguages'
import { FileViewerLimits } from '../fileViewerLimits'

export interface FileFormatProbe {
  path: string
  exists: boolean
  sample: Uint8Array
}

export class FileFormatRegistry {
  /**
   * A lookup that cannot answer with something the object never held.
   *
   * These maps are plain object literals and the key is an extension off a filename, so
   * `x.constructor` used to answer with a function, which passed the truthiness test and became a
   * `mimeType` typed as `string` - and then failed to cross IPC at all, because structured cloning
   * refuses a function. The panel showed "An object could not be cloned" instead of the file.
   */
  private static own(map: Record<string, string>, key: string): string | undefined {
    return Object.hasOwn(map, key) ? map[key] : undefined
  }

  private static readonly imageMimeByExtensionConst: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
  }

  private static readonly videoMimeByExtensionConst: Readonly<Record<string, string>> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    ogg: 'video/ogg',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
  }

  /**
   * Which control bytes text itself uses: tab, newline, form feed, carriage return, and the escape
   * that starts an ANSI sequence in a captured log.
   */
  private static readonly textControlBytesConst: ReadonlySet<number> = new Set([
    0x09, 0x0a, 0x0c, 0x0d, 0x1b,
  ])

  static classify(probe: FileFormatProbe): FileViewerDocumentKind {
    if (!probe.exists) return { kind: 'missing' }
    const name = basename(probe.path).toLowerCase()
    const extension = extname(name).slice(1)
    const imageMime = FileFormatRegistry.own(FileFormatRegistry.imageMimeByExtensionConst, extension)
    if (imageMime)
      return { kind: 'image', mimeType: imageMime, animated: extension === 'gif' }
    const videoMime = FileFormatRegistry.own(FileFormatRegistry.videoMimeByExtensionConst, extension)
    if (videoMime) return { kind: 'video', mimeType: videoMime }
    if (extension === 'svg')
      return FileFormatRegistry.looksTextual(probe.sample)
        ? { kind: 'svg', mimeType: 'image/svg+xml' }
        : { kind: 'hex' }
    // Before the language table, which knows `html` as one: a page is read as a page here, and the
    // highlighted source it would otherwise have opened as is what `raw` shows instead.
    if (extension === 'html' || extension === 'htm')
      return FileFormatRegistry.looksTextual(probe.sample) ? { kind: 'html' } : { kind: 'hex' }
    if (extension === 'mdext')
      return FileFormatRegistry.looksTextual(probe.sample)
        ? { kind: 'markdown', flavor: 'mdext' }
        : { kind: 'hex' }
    if (extension === 'md' || extension === 'markdown')
      return FileFormatRegistry.looksTextual(probe.sample)
        ? { kind: 'markdown', flavor: 'markdown' }
        : { kind: 'hex' }
    const language = FileFormatRegistry.own(FileViewerLanguages.byName, name)
      ?? FileFormatRegistry.own(FileViewerLanguages.byExtension, extension)
    if (language)
      return FileFormatRegistry.looksTextual(probe.sample)
        ? { kind: 'code', language }
        : { kind: 'hex' }
    // Everything the tables above did not name is decided by its CONTENT, not by its extension.
    // The leftover used to be a second list - `txt`, `log`, `csv`, `env` and six more - and a list
    // of text extensions can only ever hold the ones somebody remembered: `.pri` is a qmake include
    // and opened as a hex dump, and so did every `.gradle`, `.qrc`, `.rc`, `.tex` and `.cmake`
    // beside it. `modes` refuses a file too large to be READ as text, so the size ceiling stays in
    // the one place that owns it and this decides only the kind.
    return FileFormatRegistry.bytesReadAsText(probe.sample) ? { kind: 'text' } : { kind: 'hex' }
  }

  static modes(
    kind: FileViewerDocumentKind,
    supportsDiff: boolean,
    size: number | null = null,
  ): readonly FileViewerViewMode[] {
    if ((kind.kind === 'markdown' || kind.kind === 'code' || kind.kind === 'svg'
      || kind.kind === 'html' || kind.kind === 'text')
      && size !== null && size > FileViewerLimits.fullTextBytes)
      return supportsDiff ? ['hex', 'diff'] : ['hex']
    // `hex` sits at the end of every text kind, because the kind is decided from a 64 KiB sample
    // and the read refuses the WHOLE file for a NUL byte anywhere in it. A 300 KiB log with one NUL
    // in its second half opened as text, both modes said "The file contains NUL bytes", and there
    // was no mode left that could show it at all.
    if (kind.kind === 'markdown' || kind.kind === 'code' || kind.kind === 'svg'
      || kind.kind === 'html')
      return supportsDiff ? ['rendered', 'raw', 'diff', 'hex'] : ['rendered', 'raw', 'hex']
    else if (kind.kind === 'text')
      return supportsDiff ? ['raw', 'diff', 'hex'] : ['raw', 'hex']
    else if (kind.kind === 'image' || kind.kind === 'video')
      return ['preview', 'hex']
    else if (kind.kind === 'hex')
      return ['hex']
    else if (kind.kind === 'missing')
      return supportsDiff ? ['diff'] : []
    else
      throw new Error(`Unknown file viewer document kind: ${JSON.stringify(kind)}`)
  }

  /**
   * Whether the bytes alone say text, for a file whose NAME says nothing.
   *
   * Stricter than `looksTextual` on purpose. There an extension is the evidence and the bytes only
   * have to not contradict it; here they ARE the evidence, and "no NUL, decodes as UTF-8" is far too
   * weak to carry that on its own: 70 KiB of `0x07` passes both halves of it, so a payload of bells
   * would have opened as an empty-looking text document with no hex mode left to show it.
   */
  private static bytesReadAsText(sample: Uint8Array): boolean {
    for (const byte of sample)
      if (byte === 0x7f || (byte < 0x20 && !FileFormatRegistry.textControlBytesConst.has(byte)))
        return false
    return FileFormatRegistry.looksTextual(sample)
  }

  private static looksTextual(sample: Uint8Array): boolean {
    if (sample.includes(0)) return false
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
      return true
    }
    catch { return false }
  }
}
