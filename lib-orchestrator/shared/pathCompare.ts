import { resolve } from 'node:path'

/**
 * Path comparison, kept apart from the paths themselves: a category root is stored exactly as the
 * user typed it, and only the comparison is normalized. Writing the normalized form back would
 * rewrite the user's config file every time something matched a cwd against it.
 */
export class PathCompare {
  private static readonly caseInsensitiveConst = process.platform === 'win32'

  /** Absolute, forward-slashed, no trailing separator - and still spelled in the original case. */
  static normalized(value: string): string {
    return resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
  }

  static comparable(value: string): string {
    const normalized = PathCompare.normalized(value)
    return PathCompare.caseInsensitiveConst ? normalized.toLowerCase() : normalized
  }

  /** True when `candidate` is the root itself or sits beneath it; a prefix sibling is not inside. */
  static isInside(root: string, candidate: string): boolean {
    const rootPath = PathCompare.comparable(root)
    const candidatePath = PathCompare.comparable(candidate)
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`)
  }
}
