import { PathCompare } from '../shared/pathCompare'

/**
 * The paths a commit review that named its targets can show (`VersioningCommitManager.allows`):
 * a target, everything below it and every ancestor, where SVN may need a new parent. Empty names
 * the whole scope. A read applies it before it inspects an entry, so the size of the rest of the
 * working copy never counts: one working copy held 6,821 status entries of other sessions'
 * work, and a review of 31 named files failed at `listingEntriesMax`.
 */
export class FileChangesReach {
  static of(targets: readonly string[]): (path: string) => boolean {
    return (path) => targets.length === 0
      || targets.some((target) => PathCompare.isInside(target, path) || PathCompare.isInside(path, target))
  }
}
