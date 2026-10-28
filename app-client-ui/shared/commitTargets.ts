import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

export class CommitTargets {
  static blocked(entry: FileChangeEntry): boolean {
    return entry.status === 'conflicted' || entry.status === 'obstructed'
  }

  static eligible(snapshot: FileChangesWorkingTreeSnapshot): readonly FileChangeEntry[] {
    return snapshot.entries.filter((entry) => !CommitTargets.blocked(entry)
      && CommitTargets.carrier(entry, snapshot.entries) === null
      && CommitTargets.removedBy(entry, snapshot.entries) === null)
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
    const path = entry.path.replace(/\\/g, '/')
    return entries.filter((candidate) => candidate.nodeKind === 'directory' && candidate.status === 'deleted'
      && path.startsWith(`${candidate.path.replace(/\\/g, '/').replace(/\/$/, '')}/`))
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null
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
    const path = entry.path.replace(/\\/g, '/')
    return entries.filter((candidate) => candidate.nodeKind === 'directory' && candidate.status === 'added'
      && path.startsWith(`${candidate.path.replace(/\\/g, '/').replace(/\/$/, '')}/`))
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null
  }

  static requiredParent(entry: FileChangeEntry, entries: readonly FileChangeEntry[], checked: ReadonlySet<string>): boolean {
    const prefix = `${entry.path.replace(/\\/g, '/').replace(/\/$/, '')}/`
    return entry.nodeKind === 'directory' && (entry.status === 'added' || entry.status === 'untracked')
      && entries.some((child) => checked.has(child.fileId) && child.path.replace(/\\/g, '/').startsWith(prefix))
  }

  static selected(entries: readonly FileChangeEntry[], checked: ReadonlySet<string>): readonly FileChangeEntry[] {
    return entries.filter((entry) => checked.has(entry.fileId) || CommitTargets.requiredParent(entry, entries, checked))
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
}

