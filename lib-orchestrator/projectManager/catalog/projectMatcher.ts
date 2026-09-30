import { join } from 'node:path'

import type { ProjectBinding } from '../projectManagerApi.types'
import { PathCompare } from '../../shared/pathCompare'
import type { RuntimeCategory } from './catalog.types'
import { ProjectContainers } from './projectContainers'

export type MatcherCategory = Pick<RuntimeCategory, 'id' | 'path' | 'flattenFolders'>

/**
 * Maps a working directory back onto the catalog. Longest prefix wins, so a category nested inside
 * another still claims its own projects instead of being swallowed by the outer root.
 */
export class ProjectMatcher {
  private readonly categories: readonly MatcherCategory[]

  constructor(categories: readonly MatcherCategory[]) {
    this.categories = categories
  }

  /**
   * A worktree's repository root takes precedence over the cwd: a session running inside
   * `<project>/.worktrees/<slug>` belongs to `<project>`, not to a project called `.worktrees`.
   *
   * The project is the directory the scanner lists: below a container that is one segment deeper,
   * `AutomationBots/SrvTaskBot`, and a cwd that is the container itself binds to the container.
   */
  bind(cwd: string, worktreeRepositoryRoot?: string): ProjectBinding {
    const target = worktreeRepositoryRoot ?? cwd
    if (!target) return { kind: 'none' }
    const normalized = PathCompare.normalized(target)
    const comparable = PathCompare.comparable(target)

    let match: { category: MatcherCategory; rootLength: number } | null = null
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
    const segments = relative.split('/')
    const project = segments.slice(0, ProjectContainers.projectLengthOf(match.category, segments))
    return {
      kind: 'project',
      categoryId: match.category.id,
      projectName: project.join('/'),
      projectPath: join(match.category.path, ...project),
    }
  }
}
