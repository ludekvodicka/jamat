import { relative, sep } from 'node:path'

import { PathCompare } from '../../shared/pathCompare'
import type { SvnResult } from '../../svn/svn.types'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionsOpErrorCode } from '../sessionManagerApi.types'

/** What the owner rule reads about the disk, the catalog and svn. */
export interface WorktreeOwnerDeps {
  /** The nearest product group root at or above the directory (`ProductGroup.rootOf`). */
  groupRootOf(dir: string): string | null
  /** The catalog project the directory lies in, at or below its root, or null. */
  catalogProjectOf(dir: string): string | null
  /** Whether a catalog category lies at or below the directory, so it holds catalog projects. */
  holdsCatalogProject(dir: string): boolean
  workingCopyRootOf(dir: string): Promise<SvnResult<string>>
}

export type WorktreeOwnerAnswer =
  | { ok: true; ownerDir: string; cwdSubpath: string; catalogProject: string | null }
  | { ok: false; code: SessionsOpErrorCode; detail: string }

/**
 * Which directory an SVN worktree of a session's directory checks out: the nearest product group
 * at or above it, else the catalog project that holds it, else the directory itself, so the owner is
 * never wider than a group and never wider than the chosen directory outside the catalog.
 * `cwdSubpath` is where the session starts below the owner, '/'-separated, `''` at the owner.
 */
export class WorktreeOwner {
  static async of(dir: string, deps: WorktreeOwnerDeps): Promise<WorktreeOwnerAnswer> {
    if (PathCompare.normalized(dir).split('/').includes(SvnWorktreeManager.worktreesDirConst))
      return { ok: false, code: 'invalid-spec', detail: `${dir} lies inside a worktree; cut worktrees from the main copy` }
    const wcRoot = await deps.workingCopyRootOf(dir)
    if (!wcRoot.ok) return WorktreeOwner.unversioned(dir, wcRoot)
    const catalogProject = deps.catalogProjectOf(dir)
    const ownerDir = deps.groupRootOf(dir) ?? catalogProject ?? dir
    if (catalogProject === null && PathCompare.comparable(ownerDir) === PathCompare.comparable(wcRoot.value)
      && deps.holdsCatalogProject(ownerDir))
      return { ok: false, code: 'invalid-spec', detail: `${ownerDir} is a working-copy root that holds other projects, not a project` }
    return { ok: true, ownerDir, cwdSubpath: relative(ownerDir, dir).split(sep).join('/'), catalogProject }
  }

  private static unversioned(dir: string, failure: Extract<SvnResult<string>, { ok: false }>): WorktreeOwnerAnswer {
    const code = failure.code
    switch (code) {
      case 'not-a-working-copy':
        return { ok: false, code: 'invalid-spec', detail: `checkpoints mode makes SVN worktrees and ${dir} is in no SVN working copy` }
      case 'svn-missing': return { ok: false, code: 'svn-failed', detail: `svn is not installed: ${failure.detail}` }
      case 'locked': return { ok: false, code: 'locked', detail: `svn cannot read ${dir} now: ${failure.detail}` }
      case 'refused': case 'svn-failed': case 'out-of-date': case 'external-target': case 'io-failed':
        return { ok: false, code: 'invalid-spec', detail: `${dir} is not a versioned SVN directory: ${failure.detail}` }
      default: throw new Error(`Unknown svn failure ${JSON.stringify(code satisfies never)}`)
    }
  }
}
