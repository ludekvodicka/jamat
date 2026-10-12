import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { PathCompare } from '../../shared/pathCompare'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionLandingInfo, SvnLabelledRevision } from '../sessionManagerApi.types'
import { SvnRevisionLabels } from './svnRevisionLabels'

/** The svn reads of a landed row, named so a test can hand them a scripted set. */
export type LandedRowsPort = Pick<SvnWorktreeManager, 'rootRevisionOf' | 'mountRootsOf' | 'behind'>

export interface LandedRowsDeps {
  svn: LandedRowsPort
  now: () => number
}

/**
 * A committed Finish leaves its session as a landed row: the worktree is gone, and the main copy
 * it was cut from does not hold the committed revisions until somebody updates it. Nothing here
 * updates a main copy; UPDATE is an action of its own (`SvnActionFlow`), and an update from any
 * other client counts the same.
 *
 * `holds` reads only local state (`svn info` of the owner root and of each mount that holds a landed
 * repository), so the manager asks it on its poll. "N behind" is a server read, held per main copy
 * in memory and refreshed every 10 minutes or after an ending that moved the main copy.
 */
export class LandedRows {
  static readonly behindRefreshMillisecondsConst = 10 * 60_000
  /** Local reads, but one per landed row and mount: a poll every 2 s asks no more often than this. */
  static readonly holdsRefreshMillisecondsConst = 10_000
  /** Which directories of a main copy are mounts changes only with its externals. */
  private static readonly mountsRefreshMillisecondsConst = 10 * 60_000
  private readonly svn: LandedRowsPort
  private readonly now: () => number
  private readonly behindByMainCopy = new Map<string, { value: number | null; at: number }>()
  private readonly holdsAt = new Map<string, number>()
  private readonly mountsByMainCopy = new Map<string, { paths: string[]; at: number }>()

  constructor(deps: LandedRowsDeps) {
    this.svn = deps.svn
    this.now = deps.now
  }

  /** The recording of a committed ending: the worktree is gone, the session stays and is not completed. */
  static retiredOf(current: SessionRecord, ownerDir: string, landed: readonly SvnLabelledRevision[]): SessionRecord {
    const retired = current.retiredWorktree
    if (retired === undefined) throw new Error(`Session ${current.sessionId} has no removed worktree to mark landed`)
    const next: SessionRecord = { ...current, retiredWorktree: { ...retired, ownerDir, landed: SvnRevisionLabels.merged(landed) } }
    delete next.completed
    return next
  }

  /** The main copy and the revisions of a landed row, or null for any other record. */
  static landingOf(record: SessionRecord): { mainCopy: string; landed: readonly SvnLabelledRevision[] } | null {
    const retired = record.retiredWorktree
    if (retired?.ownerDir === undefined || retired.landed === undefined || retired.landed.length === 0) return null
    return { mainCopy: retired.ownerDir, landed: retired.landed }
  }

  /** The newest revision of each repository: the main copy holds the rest once it holds these. */
  static newestOf(landed: readonly SvnLabelledRevision[]): SvnLabelledRevision[] {
    const newest = new Map<string, SvnLabelledRevision>()
    for (const entry of landed) {
      const known = newest.get(entry.repository)
      if (known === undefined || entry.revision > known.revision) newest.set(entry.repository, entry)
    }
    return SvnRevisionLabels.merged([...newest.values()])
  }

  /**
   * Whether the main copy holds the newest landed revision of each repository: the owner root for
   * its own repository, every mount of another repository for that one. A main copy that holds no
   * working copy of a landed repository does not hold it. Null: svn cannot answer now.
   */
  async holds(mainCopy: string, landed: readonly SvnLabelledRevision[]): Promise<boolean | null> {
    const newest = LandedRows.newestOf(landed)
    if (newest.length === 0) return true
    const owner = await this.svn.rootRevisionOf(mainCopy)
    if (!owner.ok) return null
    let mounts: { repository: string; revision: number }[] | null = null
    for (const entry of newest) {
      if (entry.repository === owner.value.repository) {
        if (owner.value.revision < entry.revision) return false
        continue
      }
      mounts ??= await this.mountRevisionsOf(mainCopy)
      if (mounts === null) return null
      const holders = mounts.filter((mount) => mount.repository === entry.repository)
      if (holders.length === 0 || holders.some((mount) => mount.revision < entry.revision)) return false
    }
    return true
  }

  /** The landing a row shows; `behind` is null until the server was read, and while it cannot be. */
  infoOf(mainCopy: string, landed: readonly SvnLabelledRevision[]): SessionLandingInfo {
    return {
      mainCopy,
      behind: this.behindByMainCopy.get(PathCompare.comparable(mainCopy))?.value ?? null,
      newest: LandedRows.newestOf(landed).map(SvnRevisionLabels.textOf),
    }
  }

  /** Whether the poll should ask `holds` for this main copy now; a yes holds the next ask off for 10 s. */
  claimHolds(mainCopy: string): boolean {
    const key = PathCompare.comparable(mainCopy)
    const at = this.holdsAt.get(key)
    if (at !== undefined && this.now() - at < LandedRows.holdsRefreshMillisecondsConst) return false
    this.holdsAt.set(key, this.now())
    return true
  }

  /** Whether "N behind" of this main copy is older than its refresh. */
  behindDue(mainCopy: string): boolean {
    const known = this.behindByMainCopy.get(PathCompare.comparable(mainCopy))
    return known === undefined || this.now() - known.at >= LandedRows.behindRefreshMillisecondsConst
  }

  /** Reads "N behind" from the server; true when the answer moved. Offline leaves it null. */
  async refreshBehind(mainCopy: string): Promise<boolean> {
    const key = PathCompare.comparable(mainCopy)
    const read = await this.svn.behind(mainCopy)
    const value = read.ok ? read.value : null
    const before = this.behindByMainCopy.get(key)
    this.behindByMainCopy.set(key, { value, at: this.now() })
    return before?.value !== value
  }

  /** An ending moved the main copy: its next pass reads both again at once. */
  markStale(mainCopy: string): void {
    const key = PathCompare.comparable(mainCopy)
    this.holdsAt.delete(key)
    this.behindByMainCopy.delete(key)
    this.mountsByMainCopy.delete(key)
  }

  /** Main copies that hold no landed row any more are forgotten. */
  retain(mainCopies: Iterable<string>): void {
    const kept = new Set([...mainCopies].map((mainCopy) => PathCompare.comparable(mainCopy)))
    for (const cache of [this.behindByMainCopy, this.holdsAt, this.mountsByMainCopy])
      for (const key of [...cache.keys()])
        if (!kept.has(key)) cache.delete(key)
  }

  private async mountRevisionsOf(mainCopy: string): Promise<{ repository: string; revision: number }[] | null> {
    const key = PathCompare.comparable(mainCopy)
    let known = this.mountsByMainCopy.get(key)
    if (known === undefined || this.now() - known.at >= LandedRows.mountsRefreshMillisecondsConst) {
      const paths = await this.svn.mountRootsOf(mainCopy)
      if (!paths.ok) return null
      known = { paths: paths.value, at: this.now() }
      this.mountsByMainCopy.set(key, known)
    }
    const revisions: { repository: string; revision: number }[] = []
    for (const path of known.paths) {
      const root = await this.svn.rootRevisionOf(path)
      if (!root.ok) return null
      revisions.push(root.value)
    }
    return revisions
  }
}
