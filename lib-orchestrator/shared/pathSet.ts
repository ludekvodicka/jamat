import { PathCompare } from './pathCompare'

/**
 * `PathCompare.isInside` against many paths at once, at a cost of one lookup per directory level of
 * the asked path. Calling `isInside` once per member made a commit review of 2,550 named files spend
 * 13 s per pass and 44 s reading the list (2026-11-25).
 */
export class PathSet {
  private readonly members: Set<string>
  private readonly ancestors: Set<string>

  constructor(paths: Iterable<string>) {
    this.members = new Set()
    this.ancestors = new Set()
    for (const path of paths) {
      const member = PathCompare.comparable(path)
      this.members.add(member)
      for (let up = PathSet.parentOf(member); up !== null && !this.ancestors.has(up); up = PathSet.parentOf(up)) this.ancestors.add(up)
    }
  }

  has(path: string): boolean {
    return this.members.has(PathCompare.comparable(path))
  }

  /** Whether a member is `path` or a directory above it: `isInside(member, path)`. */
  hasAncestorOrSelf(path: string): boolean {
    for (let at: string | null = PathCompare.comparable(path); at !== null; at = PathSet.parentOf(at))
      if (this.members.has(at)) return true
    return false
  }

  /** Whether `path` is a member or a directory above one: `isInside(path, member)`. */
  hasDescendantOrSelf(path: string): boolean {
    const at = PathCompare.comparable(path)
    return this.members.has(at) || this.ancestors.has(at)
  }

  /** Every prefix ending before a `/` is a containing path under `isInside`, down to the empty POSIX root. */
  private static parentOf(comparable: string): string | null {
    const at = comparable.lastIndexOf('/')
    return at < 0 ? null : comparable.slice(0, at)
  }
}
