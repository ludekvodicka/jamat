import { basename, posix, relative } from 'node:path'
import { PathCompare } from '../../shared/pathCompare'
import { ProductGroup } from '../../shared/productGroup'

export interface CommitPrefixOfRoot { repositoryName: string; expectedPrefix: string }

/**
 * The `[Name]` a worktree root publishes under, as the history and the commit helper name it: an
 * external, a product group (a coordinated commit) and a checkout of a whole repository use the
 * repository name; a project inside a larger repository uses its folder, so a Jamat worktree in
 * `applications` expects [Jamat] (Finish 072).
 */
export class CommitPrefix {
  /** `own` is the root's place below the worktree ('' at the worktree itself), `base` its path in the repository. */
  static of(own: string, base: string, ownerDir: string, repositoryName: string): string {
    if (own !== '' || /^\/?(trunk\/?)?$/.test(base)) return `[${repositoryName}]`
    const group = ProductGroup.readAt(ownerDir)
    return `[${group.ok && group.kind === 'product' ? repositoryName : basename(ownerDir)}]`
  }

  /**
   * The prefix of a working-copy root of a worktree, read from the root's URL and relative URL as
   * `svn info` gives them, before a Finish has built its review rows. Null for a root outside the
   * worktree, or a URL that does not end in its relative URL.
   */
  static ofRoot(worktree: { worktreePath: string; repositoryRoot: string }, root: string,
    location: { url: string; relativeUrl: string }): CommitPrefixOfRoot | null {
    if (!PathCompare.isInside(worktree.worktreePath, root)) return null
    const url = location.url.replace(/\/$/, '')
    const relativeUrl = location.relativeUrl.replace(/^\^/, '').replace(/\/$/, '')
    if (relativeUrl !== '' && !url.endsWith(relativeUrl)) return null
    const repository = url.slice(0, url.length - relativeUrl.length)
    const repositoryName = decodeURIComponent(posix.basename(repository))
    const own = PathCompare.comparable(worktree.worktreePath) === PathCompare.comparable(root) ? ''
      : relative(worktree.worktreePath, root).replace(/\\/g, '/')
    return { repositoryName, expectedPrefix: CommitPrefix.of(own, decodeURIComponent(relativeUrl), worktree.repositoryRoot, repositoryName) }
  }
}
