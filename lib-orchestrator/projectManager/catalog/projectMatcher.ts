import { join } from 'node:path'

import type { ProjectBinding } from '../projectManagerApi.types'
import { PathCompare } from '../../shared/pathCompare'
import type { CategorySummary } from './catalog.types'

/**
 * Maps a working directory back onto the catalog. Longest prefix wins, so a category nested inside
 * another still claims its own projects instead of being swallowed by the outer root.
 */
export class ProjectMatcher {
  constructor(private readonly categories: readonly CategorySummary[]) {}

  /**
   * A worktree's repository root takes precedence over the cwd: a session running inside
   * `<project>/.worktrees/<slug>` belongs to `<project>`, not to a project called `.worktrees`.
   */
  bind(cwd: string, worktreeRepositoryRoot?: string): ProjectBinding {
    const target = worktreeRepositoryRoot ?? cwd
    if (!target) return { kind: 'none' }
    const normalized = PathCompare.normalized(target)
    const comparable = PathCompare.comparable(target)

    let match: { category: CategorySummary; rootLength: number } | null = null
    for (const category of this.categories) {
      const root = PathCompare.comparable(category.path)
      if (comparable !== root && !comparable.startsWith(`${root}/`)) continue
      if (!match || root.length > match.rootLength)
        match = { category, rootLength: root.length }
    }
    if (!match) return { kind: 'adHoc', path: normalized }

    // Case is taken from the normalized path, never from the comparable one: on Windows the latter
    // is lowercased, and a project name is shown to a human.
    const relative = normalized.slice(match.rootLength).replace(/^\//, '')
    if (!relative) return { kind: 'adHoc', path: normalized }
    const projectName = relative.split('/')[0]
    return {
      kind: 'project',
      categoryId: match.category.id,
      projectName,
      projectPath: join(match.category.path, projectName),
    }
  }
}
