import type { SvnItemRow } from '../../svn/svn.types'
import type { SvnActionConflictEntry, SvnActionConflictSet } from '../records/sessionRecord.types'

/**
 * What a guard found. The first three are on a settled entry and reopen it for the person; the last
 * two are on the worktree after a merger and make the person look before anything goes on.
 */
export type SvnGuardFinding =
  /** svn still marks the path as conflicted. */
  | { kind: 'still-marked'; path: string }
  /** A text file still holds a conflict marker line. */
  | { kind: 'markers'; path: string }
  /** The commit would delete what the other commit brought in below the path. */
  | { kind: 'drops-incoming'; path: string; dropped: string[]; revision: number | null }
  /** Paths outside the set whose content changed while the merger ran. */
  | { kind: 'outside-set'; paths: string[] }
  /** An item's BASE is past the update's revision: a commit was made from the worktree. */
  | { kind: 'committed'; revision: number }

/** After a merger: the content hashes at its start and now, and the highest BASE past the update. */
export interface SvnMergerGuardInput {
  set: SvnActionConflictSet
  /** null: no handover was written; then every changed path outside the set counts. */
  before: ReadonlyMap<string, string> | null
  /** Each path changed at the start or now, hashed now. */
  now: ReadonlyMap<string, string>
  baseAbove: number | null
}

export interface SvnGuardInput {
  set: SvnActionConflictSet
  /** `svn status --xml` of the working copy now, with each row's item state. */
  rows: readonly SvnItemRow[]
  /** The settled text paths whose file still holds a marker line. */
  marked: readonly string[]
}

/**
 * The guards after every settlement, by a rule, the merger or the person, also one made outside
 * Jamat (a TortoiseSVN `--accept working`): no settled path is still marked, no settled text file
 * holds a marker, and nothing another commit added, edited or replaced is scheduled for deletion or
 * missing below a settled path, unless the person confirmed that loss in the window. Pure: the
 * caller reads svn and the files, and reopens what this finds.
 */
export class SvnConflictGuard {
  static check(input: SvnGuardInput): SvnGuardFinding[] {
    const findings: SvnGuardFinding[] = []
    for (const entry of input.set.entries) {
      if (entry.state !== 'settled') continue
      if (input.rows.some((row) => row.conflict && row.path === entry.path)) findings.push({ kind: 'still-marked', path: entry.path })
      if (input.marked.includes(entry.path)) findings.push({ kind: 'markers', path: entry.path })
      const dropped = SvnConflictGuard.droppedBelow(entry, input.rows)
      if (dropped.length > 0 && entry.confirmedLoss !== true)
        findings.push({ kind: 'drops-incoming', path: entry.path, dropped, revision: entry.facts.incomingRevision ?? null })
    }
    return findings
  }

  /**
   * Guards 3 and 4, once after a merger: a path outside the set and below none of its entries (the
   * diverged files are entries) whose content hash moved since the merger started, or that was not
   * changed then; and a BASE past the update's revision, which only a commit from the worktree makes.
   */
  static afterMerger(input: SvnMergerGuardInput): SvnGuardFinding[] {
    const inside = (path: string): boolean => input.set.entries.some((entry) => path === entry.path || path.startsWith(`${entry.path}/`)
      || SvnConflictGuard.sidecarOf(entry.path, path))
    const moved = [...input.now].filter(([path, hash]) => !inside(path) && input.before?.get(path) !== hash).map(([path]) => path).sort()
    return [
      ...moved.length === 0 ? [] : [{ kind: 'outside-set' as const, paths: moved }],
      ...input.baseAbove === null ? [] : [{ kind: 'committed' as const, revision: input.baseAbove }],
    ]
  }

  /**
   * One of the files svn writes beside a conflicted path and removes when it is resolved: `.mine`,
   * `.r<N>`, `.working`, `.merge-left.r<N>`, `.merge-right.r<N>`, `.prej`, a folder's
   * `dir_conflicts.prej`, each maybe numbered when the name was taken.
   */
  private static sidecarOf(victim: string, path: string): boolean {
    const folder = victim === '.' ? '' : `${victim}/`
    if (path.startsWith(folder) && /^dir_conflicts(?:\.\d+)?\.prej$/.test(path.slice(folder.length))) return true
    return path.startsWith(`${victim}.`)
      && /^(?:\d+\.)?(?:mine|working|prej|r\d+|merge-left\.r\d+|merge-right\.r\d+)$/.test(path.slice(victim.length + 1))
  }

  /** The entry a finding reopens, or null for a finding on the worktree. */
  static pathOf(finding: SvnGuardFinding): string | null {
    const kind = finding.kind
    switch (kind) {
      case 'still-marked': case 'markers': case 'drops-incoming': return finding.path
      case 'outside-set': case 'committed': return null
      default: throw new Error(`Unknown guard finding: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /** `deleted` or `missing` rows at or below a tree victim whose incoming side added, edited or replaced it. */
  private static droppedBelow(entry: SvnActionConflictEntry, rows: readonly SvnItemRow[]): string[] {
    const action = entry.facts.action
    if (entry.kind !== 'tree' || (action !== 'added' && action !== 'edited' && action !== 'replaced')) return []
    return rows
      .filter((row) => (row.item === 'deleted' || row.item === 'missing') && (row.path === entry.path || row.path.startsWith(`${entry.path}/`)))
      .map((row) => row.path)
  }
}
