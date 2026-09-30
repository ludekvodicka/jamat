import type { RuntimeCategory } from './catalog.types'

export type ContainerCategory = Pick<RuntimeCategory, 'flattenFolders'>

/**
 * Which directories below a category root hold projects instead of being one: the one rule the
 * scanner, the matcher and the name rules share. A container is a directory the category names in
 * `flattenFolders`, which the settings call Subfolders, and exists only directly below the root.
 * Until 2026-09-29 the scanner unfolded a container while the matcher bound every cwd to the first
 * segment, so `Plugins/foo` was a project in the launcher and `Plugins` in the sessions tree.
 *
 * A `.appgroup` marker does not make a container. It describes the repository layout, and which
 * directory Jamat unfolds is a choice of the person using it; only the checkpoint store reads it.
 *
 * A container itself is never a project in the listing, but a session may still run in it: the
 * matcher binds its own directory to it, which is how a change across its projects gets a place in
 * the tree.
 */
export class ProjectContainers {
  /** A product group's shared code, not a project. */
  static readonly sharedFolderConst = 'components'

  /** `relative` is the directory's path below the root, one segment per entry. */
  static isContainer(category: ContainerCategory, relative: readonly string[]): boolean {
    return relative.length === 1 && category.flattenFolders.has(relative[0])
  }

  /**
   * Whether `name` is a directory a container keeps for itself rather than a project inside it: a
   * dot directory, which the scanner never lists (a group's `.private`), and the shared code.
   */
  static isOwnedBy(name: string): boolean {
    return name.startsWith('.') || name === ProjectContainers.sharedFolderConst
  }

  /**
   * How many leading segments of `relative` name the project it is inside. A path that ends on a
   * container, or inside what a container keeps for itself, belongs to that container.
   */
  static projectLengthOf(category: ContainerCategory, relative: readonly string[]): number {
    if (relative.length < 2 || !ProjectContainers.isContainer(category, relative.slice(0, 1))) return 1
    return ProjectContainers.isOwnedBy(relative[1]) ? 1 : 2
  }
}
