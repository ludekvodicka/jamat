import type { FileChangeEntry } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

export type FileChangesSortKey = 'recent' | 'name'

export class FileChangesSort {
  /**
   * `name` is the order the library already returned, not a second copy of its rule: the library
   * orders the current list and every group's entries by shown path, and re-deciding it here meant
   * two comparators that could disagree about a tie-break.
   */
  static apply(
    entries: readonly FileChangeEntry[],
    key: FileChangesSortKey,
  ): readonly FileChangeEntry[] {
    if (key === 'recent') return [...entries].sort(FileChangesSort.byRecency)
    else if (key === 'name') return entries
    else
      throw new Error(`Unknown file changes sort key: ${JSON.stringify(key)}`)
  }

  /** Short on purpose: the control shares one narrow sidebar row with the VCS picker and Refresh. */
  static labelOf(key: FileChangesSortKey): string {
    if (key === 'recent') return 'Recent'
    else if (key === 'name') return 'Name'
    else
      throw new Error(`Unknown file changes sort key: ${JSON.stringify(key)}`)
  }

  /**
   * A directory carries its newest descendant, so an equal stamp keeps a folder above its files -
   * which is the order the entries arrive in, and `sort` is stable, so ties keep it without a
   * tie-break of their own.
   */
  private static byRecency(left: FileChangeEntry, right: FileChangeEntry): number {
    if (left.modifiedAt === right.modifiedAt) return 0
    if (left.modifiedAt === null) return 1
    if (right.modifiedAt === null) return -1
    return right.modifiedAt - left.modifiedAt
  }
}
