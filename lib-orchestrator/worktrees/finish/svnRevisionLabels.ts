import type { SvnBounds, SvnLoggedRow, SvnResult, SvnRoot, SvnRootBounds } from '../../svn/svn.types'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { posix } from 'node:path'
import { PathCompare } from '../../shared/pathCompare'
import type { SessionRecord, SvnActionRoot } from '../../sessionManager/worktreeSessionRecords'
import type { SessionStepProgress, SvnLabelledRevision, SvnRevisionLabel } from '../../sessionManager/sessionManagerApi.types'
import type { SessionStepFacts } from '../../sessionManager/worktreeSessionRuntime'
import type { WorktreeExecution } from '../worktreeExecution'

/** The svn reads the labels make, named so a test can hand them a scripted set. */
export type SvnLabelsPort = Pick<SvnWorktreeManager, 'roots' | 'lowerBounds' | 'ownCommits' | 'reviewed' | 'proven' | 'changedSince'>

/**
 * The read `ownCommits` is about to make, so a caller can say what it reads: a root's own state, one
 * candidate's `svn log -v` with its index and count, or the `svn log -v` that confirms a receipt.
 */
export type SvnLabelsRead =
  | { kind: 'status'; root: SvnRoot }
  | { kind: 'own-commit'; root: SvnRoot; revision: number; index: number; count: number }
  | { kind: 'receipt'; root: SvnRoot; revision: number }

/**
 * Which revisions an SVN action committed, and how each is known. A receipt the commit dialog wrote
 * and `svn log -v` confirms outranks the worktree's own BASE, which outranks the log of the paths the
 * action saw changed. The labels say how sure a result is; they never decide a removal, which only a
 * clean worktree allows.
 */
export class SvnRevisionLabels {
  private static readonly rankConst: Readonly<Record<SvnRevisionLabel, number>> = { 'receipt': 3, 'base-proof': 2, 'inferred': 1 }
  private readonly svn: SvnLabelsPort

  constructor(svn: SvnLabelsPort) {
    this.svn = svn
  }

  /**
   * Before any update erases it: what each root committed from here since its checkout, read off
   * its BASE (`base-proof`), and the receipts of commits from the session's split since `since`
   * that the log confirms (`receipt`).
   */
  async ownCommits(worktreePath: string, receipts: SessionRecord['commitReceipts'], since: number,
    onRead?: (read: SvnLabelsRead) => void): Promise<SvnResult<SvnLabelledRevision[]>> {
    const roots = await this.svn.roots(worktreePath)
    if (!roots.ok) return roots
    const labelled: SvnLabelledRevision[] = []
    for (const root of roots.value) {
      onRead?.({ kind: 'status', root })
      const own = await this.svn.ownCommits(root, onRead === undefined ? undefined
        : (revision, index, count) => onRead({ kind: 'own-commit', root, revision, index, count }))
      if (!own.ok) return own
      labelled.push(...SvnRevisionLabels.labelledOf(own.value.repository, own.value.rows, 'base-proof'))
      const revisions = SvnRevisionLabels.receiptsOf(receipts, root.path, since)
      if (revisions.length === 0) continue
      const bounds = await this.svn.lowerBounds([root])
      if (!bounds.ok) return bounds
      // Any commit after the checkout may be the split's; the log decides whether it lies below this root.
      const bound: SvnRootBounds = { ...bounds.value[root.own], since: 0 }
      labelled.push(...await this.confirmed(root, bound, revisions, onRead))
    }
    return { ok: true, value: SvnRevisionLabels.merged(labelled) }
  }

  /** The step a caller shows for one read of `ownCommits`; a mount names itself. */
  static stepOf(read: SvnLabelsRead): { facts: SessionStepFacts; progress: SessionStepProgress | null } {
    const kind = read.kind
    const mount = read.root.own
    switch (kind) {
      case 'status': return { facts: { kind: 'read', read: 'own-commits', mount }, progress: null }
      case 'own-commit':
        return { facts: { kind: 'read', read: 'own-commits', revision: read.revision, mount }, progress: { done: read.index, total: read.count } }
      case 'receipt': return { facts: { kind: 'read', read: 'receipts', revision: read.revision, mount }, progress: null }
      default: throw new Error(`Unknown labels read: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /**
   * After one review: the receipts of that root written since the action's press, confirmed by
   * `svn log -v`, else the BASE proof of the root. An unreadable proof proves nothing.
   */
  async afterReview(parent: SessionRecord, startedAt: number, root: SvnActionRoot): Promise<SvnLabelledRevision[]> {
    const bound = root.bounds
    if (bound === undefined) return []
    const svnRoot = SvnRevisionLabels.svnRootOf(root)
    const receipts = await this.confirmed(svnRoot, bound, SvnRevisionLabels.receiptsOf(parent.commitReceipts, root.path, startedAt))
    if (receipts.length > 0) return receipts
    const proven = await this.svn.proven(svnRoot, { [root.own]: bound })
    return proven.ok ? SvnRevisionLabels.labelledOf(bound.repository, proven.value, 'base-proof') : []
  }

  /** The last resort for a root that ended clean with nothing proven: the log of its changed paths since its review began. */
  async inferred(root: SvnActionRoot): Promise<SvnLabelledRevision[]> {
    const bound = root.bounds
    if (bound === undefined) return []
    const logged = await this.svn.changedSince(SvnRevisionLabels.svnRootOf(root), bound)
    if (!logged.ok) return []
    const inside = logged.value.filter((row) => root.changed.some((path) =>
      row.path === path || row.path.startsWith(`${path}/`) || path.startsWith(`${row.path}/`)))
    return SvnRevisionLabels.labelledOf(bound.repository, inside, 'inferred')
  }

  /** One entry per repository and revision, the strongest label kept, ordered by repository and revision. */
  static merged(...lists: readonly (readonly SvnLabelledRevision[])[]): SvnLabelledRevision[] {
    const best = new Map<string, SvnLabelledRevision>()
    for (const entry of lists.flat()) {
      const key = `${entry.repository}\t${entry.revision}`
      const known = best.get(key)
      if (known === undefined) best.set(key, entry)
      else {
        const chosen = SvnRevisionLabels.rankConst[entry.label] > SvnRevisionLabels.rankConst[known.label] ? entry : known
        const paths = known.paths === undefined || entry.paths === undefined ? undefined : [...new Set([...known.paths, ...entry.paths])].sort()
        best.set(key, { ...chosen, paths })
      }
    }
    return [...best.values()].sort((a, b) =>
      a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : a.revision - b.revision)
  }

  /** `<repository URL>:r<N>`, the spelling of an outcome's revisions. */
  static textOf(entry: SvnLabelledRevision): string {
    return `${entry.repository}:r${entry.revision}`
  }

  /**
   * `j07ea r4`, the spelling people read: the repository by its name, then the revision. A repository
   * in `mounts` also names its mount, `j12 (lib/ea) r2`, because another repository has its name.
   */
  static nameOf(entry: Pick<SvnLabelledRevision, 'repository' | 'revision'>, mounts?: ReadonlyMap<string, string>): string {
    return `${SvnRevisionLabels.labelOf(entry.repository, mounts)} r${entry.revision}`
  }

  /** `j12`, or `j12 (lib/ea)` for a repository in `mounts`. */
  static labelOf(repository: string, mounts?: ReadonlyMap<string, string>): string {
    const mount = mounts?.get(repository)
    return `${SvnRevisionLabels.repositoryNameOf(repository)}${mount === undefined ? '' : ` (${mount})`}`
  }

  /**
   * The mount (`.` for the worktree itself) of each repository whose name another repository of the
   * same worktree has too: two repositories called `j12` read alike by name alone (UA1-J12-7).
   */
  static mountsOf(roots: readonly { repository: string; own: string }[]): Map<string, string> {
    const named = new Map<string, Set<string>>()
    for (const root of roots) {
      const name = SvnRevisionLabels.repositoryNameOf(root.repository)
      named.set(name, (named.get(name) ?? new Set()).add(root.repository))
    }
    const mounts = new Map<string, string>()
    for (const root of roots)
      if (named.get(SvnRevisionLabels.repositoryNameOf(root.repository))!.size > 1 && !mounts.has(root.repository)) mounts.set(root.repository, root.own || '.')
    return mounts
  }

  /**
   * `mountsOf` over every root an action knows: the mounts of the whole worktree read with its review,
   * and the roots it reviewed. An action holds both after it ended, so a finished step keeps its mount.
   */
  static mountsOfAction(action: Pick<WorktreeExecution, 'roots' | 'mounts'>,
    more: readonly { repository: string; own: string }[] = []): Map<string, string> {
    return SvnRevisionLabels.mountsOf([...action.mounts ?? [],
      ...(action.roots ?? []).flatMap((root) => root.bounds === undefined ? [] : [{ repository: root.bounds.repository, own: root.own }]), ...more])
  }

  /** The last segment of a repository root URL, decoded. */
  static repositoryNameOf(repository: string): string {
    return decodeURIComponent(posix.basename(repository.replace(/\/$/, '')))
  }

  private async confirmed(root: SvnRoot, bound: SvnRootBounds, revisions: readonly number[],
    onRead?: (read: SvnLabelsRead) => void): Promise<SvnLabelledRevision[]> {
    const bounds: SvnBounds = { [root.own]: bound }
    const labelled: SvnLabelledRevision[] = []
    for (const revision of revisions) {
      onRead?.({ kind: 'receipt', root, revision })
      const rows = await this.svn.reviewed(root, bounds, revision)
      if (rows.ok) labelled.push(...SvnRevisionLabels.labelledOf(bound.repository, rows.value, 'receipt'))
    }
    return labelled
  }

  /** Numbered receipts of a scope, newer than `since`; TortoiseSVN's receipt names no revision and proves nothing. */
  private static receiptsOf(receipts: SessionRecord['commitReceipts'], scopeRoot: string, since: number): number[] {
    const scope = PathCompare.comparable(scopeRoot)
    return [...new Set((receipts ?? [])
      .filter((receipt) => receipt.at >= since && receipt.revision !== null && PathCompare.comparable(receipt.scopeRoot) === scope)
      .map((receipt) => receipt.revision as number))]
  }

  private static labelledOf(repository: string, rows: readonly SvnLoggedRow[], label: SvnRevisionLabel): SvnLabelledRevision[] {
    return [...new Set(rows.map((row) => row.revision))].map((revision) => ({ repository, revision, label }))
  }

  private static svnRootOf(root: SvnActionRoot): SvnRoot {
    return { path: root.path, own: root.own, changed: root.changed.map((path) => ({ kind: 'item', conflict: false, path })) }
  }
}
