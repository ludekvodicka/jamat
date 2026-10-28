import type { SvnConflictKind } from '../../svn/svn.types'
import type { SvnActionConflictSet } from '../../sessionManager/worktreeSessionRecords'

/** What names one conflict: its path, and its kind where one path holds a text and a property conflict. */
export interface SvnConflictKey { path: string; kind?: SvnConflictKind }

/**
 * Which entry of a set a fact, a memory or a request means. A path svn marks with a text and a property
 * conflict holds two entries, one per kind, and svn resolves every kind of a path at once; so the one
 * settled first keeps svn's mark until the other is settled too (`held`). A key without a kind is text,
 * as records written before the split were.
 */
export class SvnConflictIdentity {
  static keyOf(conflict: SvnConflictKey): string {
    return `${conflict.kind ?? 'text'}\n${conflict.path}`
  }

  static same(left: SvnConflictKey, right: SvnConflictKey): boolean {
    return SvnConflictIdentity.keyOf(left) === SvnConflictIdentity.keyOf(right)
  }

  /** The other kind on the same path is still open, so svn must keep its mark for it. */
  static openBeside(set: SvnActionConflictSet | undefined, conflict: SvnConflictKey): boolean {
    const beside = SvnConflictIdentity.besideOf(conflict.kind ?? 'text')
    return beside !== null && set !== undefined
      && set.entries.some((entry) => entry.path === conflict.path && entry.kind === beside && entry.state !== 'settled')
  }

  /** Settled, while svn still marks its path for the other kind beside it. */
  static held(set: SvnActionConflictSet | undefined, conflict: SvnConflictKey): boolean {
    return set !== undefined && set.entries.some((entry) => SvnConflictIdentity.same(entry, conflict) && entry.state === 'settled')
      && SvnConflictIdentity.openBeside(set, conflict)
  }

  private static besideOf(kind: SvnConflictKind): SvnConflictKind | null {
    switch (kind) {
      case 'text': return 'property'
      case 'property': return 'text'
      case 'tree': case 'diverged': return null
      default: throw new Error(`Unknown conflict kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }
}
