import { PathCompare } from '../shared/pathCompare'
import { SvnRevisionLabels } from './finish/svnRevisionLabels'
import type { WorktreeLifecycle } from './worktreeState'
import type { SvnLabelledRevision } from './worktreeContracts'
import { posix, relative } from 'node:path'

export interface WorktreePublicationFacts {
  revisions: SvnLabelledRevision[]
  verified: SvnLabelledRevision[]
  proofs: NonNullable<WorktreeLifecycle['verified']>
  savedActions: string[]
  remaining?: string[]
  /** Read old approval history without treating it as an outstanding publication. */
  selected?: { repository: string; since: number; paths: string[] }[]
}

/** Publication belongs to the directory lifetime; replacing an action cannot retract it. */
export class WorktreePublication {
  static retain(state: WorktreeLifecycle, previous?: WorktreeLifecycle): WorktreeLifecycle {
    if (state.unreadable !== undefined) return state
    const sources = [previous, state].filter((value): value is WorktreeLifecycle => value !== undefined)
    const proofs = [...new Map(sources.flatMap((value) => [...value.publication?.proofs ?? [], ...value.verified ?? []])
      .map((proof) => [JSON.stringify([PathCompare.comparable(proof.root), proof.repository, proof.base, proof.revision]), proof])).values()]
    const revisions = SvnRevisionLabels.merged(...sources.flatMap((value) => [value.publication?.revisions ?? [], value.execution?.evidence ?? []]))
    const verified = SvnRevisionLabels.merged(...sources.flatMap((value) => [value.publication?.verified ?? [],
      (value.execution?.evidence ?? []).flatMap((revision) => proofs.flatMap((proof) => {
        const root = value.execution?.roots?.find((root) => PathCompare.comparable(root.path) === PathCompare.comparable(proof.root)
          && root.bounds?.repository === revision.repository)
        if (proof.revision !== revision.revision) return []
        const base = proof.repository === undefined && value.publication === undefined ? root?.bounds?.base
          : proof.repository === revision.repository ? proof.base : undefined
        if (base === undefined) return []
        const paths = proof.paths.map((path) => posix.join('/', base, path))
          .filter((path) => revision.paths === undefined || revision.paths.includes(path))
        return paths.length === 0 ? [] : [{ ...revision, paths }]
      }))]))
    const savedActions = [...new Set(sources.flatMap((value) => [...value.publication?.savedActions ?? [],
      ...value.actionId === null ? [] : [value.actionId]]))]
    if (revisions.length === 0 && proofs.length === 0 && savedActions.length === 0) return state
    return { ...state, verified: proofs.length === 0 ? undefined : proofs,
      publication: { revisions, verified, proofs, savedActions,
        selected: state.publication?.selected ?? previous?.publication?.selected,
        remaining: state.publication?.remaining ?? (previous?.actionId === state.actionId ? previous?.publication?.remaining : undefined) } }
  }

  /**
   * `j09ea r9, r10`: the revisions an interrupted commit may have landed as, per repository, while
   * recovery could prove none of them ours. Empty once recovery proved a revision or no publication.
   */
  static uncertain(state: WorktreeLifecycle): string[] {
    return state.journal.flatMap((entry) => entry.kind !== 'commit' || entry.uncertain === undefined || entry.uncertain.revisions.length === 0 ? []
      : [`${SvnRevisionLabels.repositoryNameOf(entry.uncertain.repository)} ${entry.uncertain.revisions.map((revision) => `r${revision}`).join(', ')}`])
  }

  /**
   * The mount each repository is named with where another repository of the worktree has its name:
   * the mounts read with the review, the action's roots, and the mounts an earlier action's proofs bind.
   */
  static mountsOf(state: WorktreeLifecycle): Map<string, string> {
    const top = state.execution?.root
    const proven = (WorktreePublication.retain(state).publication?.proofs ?? []).flatMap((proof) => proof.repository === undefined ? []
      : [{ repository: proof.repository, own: top === undefined ? proof.root : relative(top, proof.root).replace(/\\/g, '/') }])
    return SvnRevisionLabels.mountsOfAction(state.execution ?? {}, proven)
  }

  static complete(state: WorktreeLifecycle): boolean {
    const facts = WorktreePublication.retain(state).publication
    return facts !== undefined && facts.revisions.length > 0 && facts.remaining?.length === 0
      && facts.revisions.every((revision) => revision.paths !== undefined && revision.paths.every((path) => facts.verified.some((proof) =>
        proof.repository === revision.repository && proof.revision >= revision.revision && proof.paths?.includes(path))))
  }
}
