import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * A product group of `Q:/Projects`: a directory holding an empty file of this name holds the
 * product's projects, one per child directory
 * (`Q:/Tooling/agent_extensions/docs/architecture/applications-product-layout.md`).
 *
 * The checkpoint store refuses to put a store over all of the group's projects, and an SVN worktree
 * of any directory inside a group checks out the whole group (`WorktreeOwner`). The project manager
 * does not read it: which directory the launcher unfolds is the category's Subfolders setting
 * (`flattenFolders`), so a group the setting does not name is listed as one project.
 */
export class ProductGroup {
  static readonly markerConst = '.appgroup'

  /** The nearest product group root at or above `dir`. */
  static rootOf(dir: string): string | null {
    for (let current = resolve(dir); ; current = dirname(current)) {
      if (existsSync(join(current, ProductGroup.markerConst))) return current
      if (dirname(current) === current) return null
    }
  }
}
