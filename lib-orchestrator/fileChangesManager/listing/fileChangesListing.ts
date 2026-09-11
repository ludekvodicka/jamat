import { stat } from 'node:fs/promises'
import { dirname, relative } from 'node:path'

import { BoundedMap } from '../../shared/boundedMap'
import { PathCompare } from '../../shared/pathCompare'
import { FileChangesLimits } from '../fileChangesLimits'
import type {
  FileChangeEntry,
  FileChangeStatus,
} from '../fileChangesManagerApi.types'
import type { FileChangesLogGroup, FileChangesLogMutation } from '../logs/fileChangesLogSource.types'
import type { FileChangesVcsEntry } from '../vcs/fileChangesVcs.types'

export interface FileChangesListingItem {
  absolutePath: string
  repositoryPath: string | null
  previousRepositoryPath: string | null
  entry: Omit<FileChangeEntry, 'fileId'>
}

interface MutableListingItem extends FileChangesListingItem {
  entry: Omit<FileChangeEntry, 'fileId'> & { sources: ('vcs' | 'chat')[] }
}

export class FileChangesListing {
  /**
   * `warnings` is filled rather than returned separately, because a truncated list must SAY it was
   * truncated: `status` asks git for every untracked file on purpose, so an unignored `out/` or
   * `node_modules` puts each of its files here, and a list silently cut at a ceiling reads as a
   * complete answer about the working copy.
   */
  async build(input: {
    cwd: string
    /**
     * Whether a VCS was detected at all. It decides what happens to a workspace mutation the
     * transcript recorded and the status did not: with a VCS, the status is the authority and the
     * mutation is dropped, because a file the agent wrote and then reverted is not a change. With
     * NO VCS there is no authority, and dropping them left the top list saying `0 changed` while
     * the chat groups underneath it listed the three files the agent had just written and offered
     * diffs for them.
     */
    hasVcs: boolean
    vcsEntries: readonly FileChangesVcsEntry[]
    logGroups: readonly FileChangesLogGroup[]
    warnings?: string[]
    includeDirectories?: boolean
  }): Promise<readonly FileChangesListingItem[]> {
    const byPath = new Map<string, MutableListingItem>()
    for (const vcs of input.vcsEntries) {
      const item = FileChangesListing.fromVcs(input.cwd, vcs)
      byPath.set(PathCompare.comparable(item.absolutePath), item)
    }
    const lastMutations = FileChangesListing.lastMutations(input.logGroups)
    for (const mutation of lastMutations.values()) {
      const key = PathCompare.comparable(mutation.path)
      const existing = byPath.get(key)
      if (existing) {
        if (!existing.entry.sources.includes('chat')) existing.entry.sources.push('chat')
        continue
      }
      if (mutation.location !== 'external' && input.hasVcs) continue
      const exists = await FileChangesListing.exists(mutation.path)
      byPath.set(key, {
        absolutePath: mutation.path,
        repositoryPath: null,
        previousRepositoryPath: null,
        entry: {
          path: mutation.path,
          displayPath: FileChangesListing.displayPath(input.cwd, mutation.path),
          nodeKind: 'file',
          location: mutation.location,
          status: mutation.kind === 'delete' ? 'deleted' : exists ? mutation.status : 'missing',
          previousPath: mutation.previousPath,
          previousDisplayPath: FileChangesListing.previousDisplay(input.cwd, mutation.previousPath),
          modifiedAt: null,
          sources: ['chat'],
          gitState: null,
        },
      })
    }
    if (input.includeDirectories !== false) FileChangesListing.addDirectories(input.cwd, byPath)
    if (byPath.size > FileChangesLimits.listingEntriesMax) {
      const dropped = byPath.size - FileChangesLimits.listingEntriesMax
      for (const key of [...byPath.keys()].slice(FileChangesLimits.listingEntriesMax))
        byPath.delete(key)
      input.warnings?.push(
        `the list was cut at ${FileChangesLimits.listingEntriesMax} entries (${dropped} more)`,
      )
    }
    await FileChangesListing.readModifiedAt(byPath)
    return [...byPath.values()].sort(FileChangesListing.compare)
  }

  fromHistoryEntry(cwd: string, vcs: FileChangesVcsEntry): FileChangesListingItem {
    return FileChangesListing.fromVcs(cwd, vcs)
  }

  fromLogMutation(cwd: string, mutation: FileChangesLogMutation): FileChangesListingItem {
    return {
      absolutePath: mutation.path,
      repositoryPath: null,
      previousRepositoryPath: null,
      entry: {
        path: mutation.path,
        displayPath: FileChangesListing.displayPath(cwd, mutation.path),
        nodeKind: 'file',
        location: mutation.location,
        status: mutation.status,
        previousPath: mutation.previousPath,
        previousDisplayPath: FileChangesListing.previousDisplay(cwd, mutation.previousPath),
        modifiedAt: null,
        sources: ['chat'],
        gitState: null,
      },
    }
  }

  /**
   * The old path of a rename, spelled the way `displayPath` is.
   *
   * The row draws `previous -> current`, and it used to draw an absolute path against a relative
   * one: a plain `git mv src/old.ts src/new.ts` in `Q:/proj` read as
   * `Q:/proj/src/old.ts -> src/new.ts`.
   */
  private static previousDisplay(cwd: string, previousPath: string | null): string | null {
    return previousPath === null ? null : FileChangesListing.displayPath(cwd, previousPath)
  }

  private static fromVcs(cwd: string, vcs: FileChangesVcsEntry): MutableListingItem {
    return {
      absolutePath: vcs.absolutePath,
      repositoryPath: vcs.repositoryPath,
      previousRepositoryPath: vcs.previousRepositoryPath,
      entry: {
        path: vcs.absolutePath,
        displayPath: FileChangesListing.displayPath(cwd, vcs.absolutePath),
        nodeKind: vcs.nodeKind,
        location: 'workspace',
        status: vcs.status,
        previousPath: vcs.previousAbsolutePath,
        previousDisplayPath: FileChangesListing.previousDisplay(cwd, vcs.previousAbsolutePath),
        modifiedAt: null,
        sources: ['vcs'],
        gitState: vcs.gitState,
      },
    }
  }

  private static lastMutations(
    groups: readonly FileChangesLogGroup[],
  ): Map<string, FileChangesLogMutation> {
    const found = new Map<string, FileChangesLogMutation>()
    for (const group of groups)
      for (const mutation of group.mutations) {
        if (mutation.kind === 'move' && mutation.previousPath !== null)
          found.delete(PathCompare.comparable(mutation.previousPath))
        found.set(PathCompare.comparable(mutation.path), mutation)
      }
    return found
  }

  /** A directory carries its newest changed descendant, so a folder row ages with what is inside it. */
  private static async readModifiedAt(byPath: Map<string, MutableListingItem>): Promise<void> {
    const items = [...byPath.values()]
    // Bounded: `status` asks git for every untracked file on purpose, so an unignored build
    // directory puts each of its files in here, and one `stat` per entry all at once is how a
    // listing reaches the open-file ceiling on Windows.
    await BoundedMap.run(items, FileChangesLimits.listingConcurrency, async (item) => {
      if (item.entry.nodeKind !== 'file') return
      item.entry.modifiedAt = await FileChangesListing.modifiedAt(item.absolutePath)
    })
    const newest = new Map<string, number>()
    for (const item of items) {
      const stamp = item.entry.modifiedAt
      if (item.entry.nodeKind !== 'file' || stamp === null) continue
      let parent = dirname(item.absolutePath)
      let child = item.absolutePath
      while (parent !== child) {
        const key = PathCompare.comparable(parent)
        const known = newest.get(key)
        if (known === undefined || known < stamp) newest.set(key, stamp)
        child = parent
        parent = dirname(parent)
      }
    }
    for (const item of items)
      if (item.entry.nodeKind === 'directory')
        item.entry.modifiedAt = newest.get(PathCompare.comparable(item.absolutePath)) ?? null
  }

  private static addDirectories(cwd: string, byPath: Map<string, MutableListingItem>): void {
    const children = new Map<string, MutableListingItem[]>()
    for (const item of [...byPath.values()]) {
      if (item.entry.location !== 'workspace' || item.entry.nodeKind === 'directory') continue
      let parent = dirname(item.absolutePath)
      while (PathCompare.isInside(cwd, parent) && PathCompare.comparable(parent) !== PathCompare.comparable(cwd)) {
        const key = PathCompare.comparable(parent)
        const grouped = children.get(key)
        if (grouped) grouped.push(item)
        else children.set(key, [item])
        parent = dirname(parent)
      }
    }
    for (const [key, descendants] of children) {
      if (byPath.has(key)) continue
      const absolutePath = dirname(descendants[0].absolutePath)
      const actualPath = FileChangesListing.parentMatching(absolutePath, key)
      byPath.set(key, {
        absolutePath: actualPath,
        repositoryPath: null,
        previousRepositoryPath: null,
        entry: {
          path: actualPath,
          displayPath: FileChangesListing.displayPath(cwd, actualPath),
          nodeKind: 'directory',
          location: 'workspace',
          status: FileChangesListing.directoryStatus(descendants.map((item) => item.entry.status)),
          previousPath: null,
          previousDisplayPath: null,
          modifiedAt: null,
          sources: descendants.some((item) => item.entry.sources.includes('chat'))
            ? ['vcs', 'chat']
            : ['vcs'],
          gitState: null,
        },
      })
    }
  }

  private static parentMatching(start: string, comparable: string): string {
    let candidate = start
    while (PathCompare.comparable(candidate) !== comparable) candidate = dirname(candidate)
    return candidate
  }

  private static directoryStatus(statuses: readonly FileChangeStatus[]): FileChangeStatus {
    if (statuses.every((status) => status === statuses[0])) return statuses[0]
    if (statuses.includes('conflicted')) return 'conflicted'
    else if (statuses.includes('obstructed')) return 'obstructed'
    else if (statuses.includes('missing')) return 'missing'
    else return 'modified'
  }

  private static displayPath(cwd: string, absolutePath: string): string {
    return PathCompare.isInside(cwd, absolutePath)
      ? relative(cwd, absolutePath).replace(/\\/g, '/') || '.'
      : absolutePath.replace(/\\/g, '/')
  }

  private static async exists(path: string): Promise<boolean> {
    try { await stat(path); return true }
    catch { return false }
  }

  private static async modifiedAt(path: string): Promise<number | null> {
    try { return Math.round((await stat(path)).mtimeMs) }
    catch { return null }
  }

  /**
   * The one ordering rule in this tree: by shown path, a directory before the file it shares a name
   * with.
   *
   * The renderer used to keep a second copy of it and re-apply it to a list the library had already
   * ordered - so the day one of them changed its tie-break, the list would jump when somebody
   * switched the sort back to Name. It picks a key now; both orders start from this one.
   */
  static byName(entries: readonly FileChangeEntry[]): readonly FileChangeEntry[] {
    return [...entries].sort(
      (left, right) => FileChangesListing.compareEntries(left, right))
  }

  private static compare(left: MutableListingItem, right: MutableListingItem): number {
    return FileChangesListing.compareEntries(left.entry, right.entry)
  }

  private static compareEntries(
    left: Pick<FileChangeEntry, 'displayPath' | 'nodeKind'>,
    right: Pick<FileChangeEntry, 'displayPath' | 'nodeKind'>,
  ): number {
    const path = left.displayPath.localeCompare(right.displayPath)
    if (path !== 0) return path
    if (left.nodeKind === right.nodeKind) return 0
    return left.nodeKind === 'directory' ? -1 : 1
  }
}
