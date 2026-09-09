import { Slug } from '../shared/slug'

/**
 * How a worktree is named: the folder it lives in, the branch prefix it gets, and what a session
 * title becomes on disk. The one place all three are written.
 *
 * **Deliberately web-safe, and the sixth VALUE import the renderer takes out of this library**
 * (`CLAUDE.md` rule 1). It has no imports of its own for the same reason `fileViewerLimits` and
 * `sessionLimits` have none: the launcher draws the branch and the directory a session WOULD land
 * on before anything is created, and a preview of a transformation the other side performs has to
 * be the same transformation.
 *
 * It replaced a copy that said it was safe because it was "display only". It was not: the preview
 * feeds `worktreeRefusal`, which decides whether isolation may be turned on at all, so a divergence
 * changed what got created rather than what got drawn.
 *
 * `folderNameConst` sits under the REPOSITORY ROOT, which is not always the project path - see
 * `.aidocs/review-todos/084`.
 */
export class WorktreeNaming {
  static readonly folderNameConst = '.worktrees'
  static readonly branchPrefixConst = 'jamat/'

  /** The rule itself is `Slug`'s, which the projects settings reads too; empty means unnameable. */
  static slugOf(value: string): string {
    return Slug.of(value)
  }

  static branchOf(slug: string): string {
    return `${WorktreeNaming.branchPrefixConst}${slug}`
  }
}
