import { PathCompare } from '../../shared/pathCompare'

/**
 * One operation at a time over a project directory, held by everything that changes one.
 *
 * Relocating and deleting reach the same directories from two entry points, and each IPC call is its
 * own task: with a guard per subsystem they interleave, and a delete removes the project while a
 * rename is still carrying its history after it. One instance is built by `ProjectManager` and handed
 * to both, which is what makes the two exclusive of each other and not merely of themselves.
 */
export class ProjectOperationGuard {
  private readonly held = new Set<string>()

  /**
   * The category belongs to the identity: two of them may name the same directory. Encoded as JSON
   * rather than joined by a separator, because a category id is whatever the config file says.
   */
  static keyOf(categoryId: string, path: string): string {
    return JSON.stringify([categoryId, PathCompare.comparable(path)])
  }

  /** False when another operation already holds one of these paths, and then nothing is claimed. */
  claim(keys: readonly string[]): boolean {
    if (keys.some((key) => this.held.has(key))) return false
    for (const key of keys) this.held.add(key)
    return true
  }

  release(keys: readonly string[]): void {
    for (const key of keys) this.held.delete(key)
  }
}
