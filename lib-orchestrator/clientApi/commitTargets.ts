import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../fileChangesManager/fileChangesManagerApi.types'

export interface CommitTargetsIndex {
  removedBy(entry: FileChangeEntry): FileChangeEntry | null
  carrier(entry: FileChangeEntry): FileChangeEntry | null
  requiredParents(checked: ReadonlySet<string>): ReadonlySet<string>
}

export class CommitTargets {
  static blocked(entry: FileChangeEntry): boolean {
    return entry.status === 'conflicted' || entry.status === 'obstructed'
  }

  static index(entries: readonly FileChangeEntry[]): CommitTargetsIndex {
    const deletedDirs = new Map<string, FileChangeEntry>()
    const addedDirs = new Map<string, FileChangeEntry>()
    const normalizedPathById = new Map<string, string>()
    const requiredCandidates: Array<{ fileId: string; normalizedPath: string }> = []
    for (const entry of entries) {
      const normalized = CommitTargets.normalize(entry.path)
      normalizedPathById.set(entry.fileId, normalized)
      if (entry.nodeKind === 'directory') {
        if (entry.status === 'deleted') deletedDirs.set(normalized, entry)
        else if (entry.status === 'added') addedDirs.set(normalized, entry)
        if (entry.status === 'added' || entry.status === 'untracked')
          requiredCandidates.push({ fileId: entry.fileId, normalizedPath: normalized })
      }
    }
    return {
      removedBy: (entry) => entry.status === 'untracked' && deletedDirs.size > 0
        ? CommitTargets.deepestAncestor(entry.path.replace(/\\/g, '/'), deletedDirs)
        : null,
      carrier: (entry) => entry.status === 'copied' && addedDirs.size > 0
        ? CommitTargets.deepestAncestor(entry.path.replace(/\\/g, '/'), addedDirs)
        : null,
      requiredParents: (checked) => {
        const required = new Set<string>()
        if (requiredCandidates.length === 0 || checked.size === 0) return required
        const checkedAncestors = new Set<string>()
        for (const entry of entries) {
          if (!checked.has(entry.fileId)) continue
          CommitTargets.addAncestors(entry.path.replace(/\\/g, '/'), checkedAncestors)
        }
        for (const candidate of requiredCandidates)
          if (checkedAncestors.has(candidate.normalizedPath)) required.add(candidate.fileId)
        return required
      },
    }
  }

  static externalRootMap(
    externalRoots: FileChangesWorkingTreeSnapshot['externalRoots'],
  ): ReadonlyMap<string, FileChangesWorkingTreeSnapshot['externalRoots'][number]> {
    const map = new Map<string, FileChangesWorkingTreeSnapshot['externalRoots'][number]>()
    for (const root of [...externalRoots].sort((left, right) => left.path.length - right.path.length))
      for (const id of root.fileIds) map.set(id, root)
    return map
  }

  static eligible(snapshot: FileChangesWorkingTreeSnapshot): readonly FileChangeEntry[] {
    const indexed = CommitTargets.index(snapshot.entries)
    return snapshot.entries.filter((entry) => !CommitTargets.blocked(entry)
      && indexed.carrier(entry) === null
      && indexed.removedBy(entry) === null)
  }

  /**
   * The deleted directory a row sits inside, or null when this commit removes nothing above it.
   *
   * `svn delete --keep-local` publishes the removal and leaves the files on disk, so every one of
   * them comes back as an untracked row below a `deleted` directory. Checking one is not a second
   * change beside the deletion: staging it runs `svn add --parents`, which REPLACES that directory
   * instead, and the subtree the dialog says it deletes is published again. Every eligible row is
   * checked by default, which puts that reversal one confirmation away, so this row carries no
   * checkbox of its own.
   *
   * SVN only, without asking which VCS: git has no directory node, and a directory row this
   * listing composes is `deleted` only when every descendant it has is, which leaves no untracked
   * row inside it.
   */
  static removedBy(entry: FileChangeEntry, entries: readonly FileChangeEntry[]): FileChangeEntry | null {
    if (entry.status !== 'untracked') return null
    const deletedDirs = new Map<string, FileChangeEntry>()
    for (const candidate of entries)
      if (candidate.nodeKind === 'directory' && candidate.status === 'deleted')
        deletedDirs.set(CommitTargets.normalize(candidate.path), candidate)
    if (deletedDirs.size === 0) return null
    return CommitTargets.deepestAncestor(entry.path.replace(/\\/g, '/'), deletedDirs)
  }

  /**
   * The copied directory a row is published by, or null when the row stands on its own.
   *
   * A copy commits as ONE node: the server takes the whole subtree from the copyfrom source, so a
   * file inside it has no commit of its own to be kept out of. Its checkbox therefore follows the
   * directory's instead of offering a choice SVN would ignore. A file MODIFIED after the copy is
   * not one of these - it reaches the pane with its own status and stays its own target.
   */
  static carrier(entry: FileChangeEntry, entries: readonly FileChangeEntry[]): FileChangeEntry | null {
    if (entry.status !== 'copied') return null
    const addedDirs = new Map<string, FileChangeEntry>()
    for (const candidate of entries)
      if (candidate.nodeKind === 'directory' && candidate.status === 'added')
        addedDirs.set(CommitTargets.normalize(candidate.path), candidate)
    if (addedDirs.size === 0) return null
    return CommitTargets.deepestAncestor(entry.path.replace(/\\/g, '/'), addedDirs)
  }

  static requiredParent(entry: FileChangeEntry, entries: readonly FileChangeEntry[], checked: ReadonlySet<string>): boolean {
    if (entry.nodeKind !== 'directory' || (entry.status !== 'added' && entry.status !== 'untracked')) return false
    const prefix = `${CommitTargets.normalize(entry.path)}/`
    return entries.some((child) => checked.has(child.fileId) && child.path.replace(/\\/g, '/').startsWith(prefix))
  }

  static selected(entries: readonly FileChangeEntry[], checked: ReadonlySet<string>): readonly FileChangeEntry[] {
    if (checked.size === 0) return []
    const required = CommitTargets.index(entries).requiredParents(checked)
    return entries.filter((entry) => checked.has(entry.fileId) || required.has(entry.fileId))
  }

  /**
   * Directories and files in one alphabetical order, compared segment by segment. A whole-path
   * localeCompare puts `.` before `/`, so `foo.ts` would land between `foo/` and `foo/x.ts`.
   */
  static byPath(left: { displayPath: string }, right: { displayPath: string }): number {
    const leftSegments = left.displayPath.split(/[\\/]/)
    const rightSegments = right.displayPath.split(/[\\/]/)
    for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index++) {
      const order = leftSegments[index]!.localeCompare(rightSegments[index]!)
      if (order !== 0) return order
    }
    return leftSegments.length - rightSegments.length
  }

  private static normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/$/, '')
  }

  private static deepestAncestor(
    slashedPath: string,
    directories: ReadonlyMap<string, FileChangeEntry>,
  ): FileChangeEntry | null {
    let slash = slashedPath.lastIndexOf('/')
    while (slash >= 0) {
      const hit = directories.get(slashedPath.slice(0, slash))
      if (hit !== undefined) return hit
      if (slash === 0) break
      slash = slashedPath.lastIndexOf('/', slash - 1)
    }
    return null
  }

  private static addAncestors(slashedPath: string, target: Set<string>): void {
    let slash = slashedPath.lastIndexOf('/')
    while (slash >= 0) {
      target.add(slashedPath.slice(0, slash))
      if (slash === 0) break
      slash = slashedPath.lastIndexOf('/', slash - 1)
    }
  }
}

