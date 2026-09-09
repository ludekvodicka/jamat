import { randomUUID } from 'node:crypto'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'

import { PathCompare } from '../../shared/pathCompare'
import type { FileViewerDirectoryEntry } from '../fileViewerApi.types'
import { ErrorText } from '../../shared/errorText'
import { FileViewerLimits } from '../fileViewerLimits'
import type { StoredFileViewerEntry } from '../access/fileViewerGrantStore'

export interface FileDirectoryRead {
  entries: ReadonlyMap<string, StoredFileViewerEntry>
  publicEntries: readonly FileViewerDirectoryEntry[]
  truncated: boolean
}

export class FileDirectoryReader {
  async read(rootPath: string, path: string): Promise<FileDirectoryRead> {
    const names = await readdir(path)
    // Sorted BEFORE it is cut. Cutting the raw `readdir` order meant a directory of a hundred
    // thousand entries showed an arbitrary five thousand of them - `src/` simply absent because the
    // filesystem happened to return it late, and a different five thousand next time. The banner
    // says the list was cut; it cannot also mean the list is a random sample.
    const ordered = [...names].sort(FileDirectoryReader.compareNames)
    const entries: StoredFileViewerEntry[] = []
    for (const name of ordered.slice(0, FileViewerLimits.directoryEntries))
      entries.push(await this.entry(rootPath, path, name))
    entries.sort(FileDirectoryReader.compare)
    const byId = new Map(entries.map((entry) => [entry.public.entryId, entry]))
    return {
      entries: byId,
      publicEntries: entries.map((entry) => entry.public),
      truncated: names.length > entries.length,
    }
  }

  /** Only to make the cut deterministic; the real order is `compare`, applied to what survives. */
  private static compareNames(left: string, right: string): number {
    return left.localeCompare(right)
  }

  private async entry(rootPath: string, directory: string, name: string): Promise<StoredFileViewerEntry> {
    const path = `${directory.replace(/[\\/]$/, '')}/${name}`
    try {
      const linkInfo = await lstat(path)
      if (linkInfo.isSymbolicLink()) return await this.symbolicEntry(rootPath, path, name, linkInfo.mtimeMs)
      const nodeKind = linkInfo.isDirectory() ? 'directory' : linkInfo.isFile() ? 'file' : 'other'
      return {
        path,
        targetKind: nodeKind === 'directory' || nodeKind === 'file' ? nodeKind : null,
        public: {
          entryId: randomUUID(),
          name,
          path,
          nodeKind,
          targetKind: nodeKind === 'directory' || nodeKind === 'file' ? nodeKind : null,
          size: linkInfo.isFile() ? linkInfo.size : null,
          modifiedAt: linkInfo.mtimeMs,
          openable: linkInfo.isFile() || linkInfo.isDirectory(),
          detail: nodeKind === 'other' ? 'Unsupported filesystem node' : null,
        },
      }
    }
    catch (error) {
      return {
        path,
        targetKind: null,
        public: {
          entryId: randomUUID(),
          name,
          path,
          nodeKind: 'other',
          targetKind: null,
          size: null,
          modifiedAt: null,
          openable: false,
          detail: ErrorText.of(error),
        },
      }
    }
  }

  private async symbolicEntry(
    rootPath: string,
    path: string,
    name: string,
    modifiedAt: number,
  ): Promise<StoredFileViewerEntry> {
    try {
      const resolved = await realpath(path)
      if (!PathCompare.isInside(rootPath, resolved))
        return FileDirectoryReader.disabledSymbolic(path, name, modifiedAt, 'Link target is outside the explorer root')
      const target = await stat(resolved)
      const targetKind = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : null
      return {
        path,
        targetKind,
        public: {
          entryId: randomUUID(),
          name,
          path,
          nodeKind: 'symlink',
          targetKind,
          size: target.isFile() ? target.size : null,
          modifiedAt,
          openable: targetKind !== null,
          detail: targetKind === null ? 'Unsupported link target' : null,
        },
      }
    }
    catch (error) {
      return FileDirectoryReader.disabledSymbolic(
        path,
        name,
        modifiedAt,
        ErrorText.of(error),
      )
    }
  }

  private static disabledSymbolic(
    path: string,
    name: string,
    modifiedAt: number,
    detail: string,
  ): StoredFileViewerEntry {
    return {
      path,
      targetKind: null,
      public: {
        entryId: randomUUID(),
        name,
        path,
        nodeKind: 'symlink',
        targetKind: null,
        size: null,
        modifiedAt,
        openable: false,
        detail,
      },
    }
  }

  private static compare(left: StoredFileViewerEntry, right: StoredFileViewerEntry): number {
    const leftGroup = left.targetKind === 'directory' ? 0 : 1
    const rightGroup = right.targetKind === 'directory' ? 0 : 1
    if (leftGroup !== rightGroup) return leftGroup - rightGroup
    const insensitive = left.public.name.localeCompare(right.public.name, undefined, { sensitivity: 'base' })
    return insensitive !== 0 ? insensitive : left.public.name.localeCompare(right.public.name)
  }
}
