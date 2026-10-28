import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { PathCompare } from '../../shared/pathCompare'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import type { SvnBehindRoot, SvnLandingLocal } from '../../svn/svn.types'
import type { SessionLandingInfo, SessionWorkflowInfo, SvnActionStage, SvnLabelledRevision } from '../../sessionManager/sessionManagerApi.types'
import { SvnRevisionLabels } from '../finish/svnRevisionLabels'
import { WorktreePublication } from '../worktreePublication'

/** The svn reads of a landed row, named so a test can hand them a scripted set. */
export type LandedRowsPort = Pick<SvnWorktreeManager, 'landingProof' | 'landingStamp' | 'behind'>

export interface LandedRowsDeps {
  svn: LandedRowsPort
  now: () => number
}

export class LandedRows {
  static readonly behindRefreshMillisecondsConst = 10 * 60_000
  /** A `stat` per working copy while nothing writes, a proof after a write: a poll every 2 s asks no more often than this. */
  static readonly holdsRefreshMillisecondsConst = 10_000
  private readonly svn: LandedRowsPort
  private readonly now: () => number
  private readonly behindByMainCopy = new Map<string, { value: SvnBehindRoot[] | null; at: number }>()
  private readonly holdsAt = new Map<string, number>()
  private readonly reasons = new Map<string, { reason: string; local?: SvnLandingLocal }>()
  /** The last answer per proof key with the stamp of the working copies it was proven under; null proves again. */
  private readonly proofs = new Map<string, { holds: boolean | null; stamp: string | null }>()
  private readonly proving = new Map<string, Promise<boolean | null>>()

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
    const state = record.worktreeLifecycle
    const published = state === undefined ? undefined : WorktreePublication.retain(state).publication
    if ((published?.revisions.length ?? 0) > 0) {
      const mainCopy = record.worktree?.repositoryRoot ?? record.retiredWorktree?.ownerDir
      if (mainCopy !== undefined) return { mainCopy, landed: published!.revisions }
    }
    if (record.worktree?.kind === 'svn' && (state?.verified?.length ?? 0) > 0) {
      const landed = (state!.execution?.evidence ?? []).filter((entry) => state!.verified!.some((proof) => proof.revision === entry.revision
        && state!.execution?.roots?.some((root) => PathCompare.comparable(root.path) === PathCompare.comparable(proof.root) && root.bounds?.repository === entry.repository)))
      if (landed.length > 0) return { mainCopy: record.worktree.repositoryRoot, landed }
    }
    const retired = record.retiredWorktree
    if (retired?.ownerDir === undefined || (retired.landed?.length ?? 0) === 0 && record.svnAction?.stage !== 'main-update'
      && record.svnAction?.kind !== 'update-main') return null
    return { mainCopy: retired.ownerDir, landed: retired.landed ?? [] }
  }

  /** Where an UPDATE saved the local changes that overlap what lands, before its svn update; null when it saved none. */
  static savedOf(protection: { overlaps: readonly string[]; saved: readonly string[] } | undefined): string | null {
    if (protection === undefined || protection.saved.length === 0) return null
    const count = protection.overlaps.length
    return `${count} of your changes overlap${count === 1 ? 's' : ''} what lands; saved before the update in ${protection.saved.join(', ')}`
  }

  /** The newest revision of each repository for display; proof retains every receipt and path. */
  static newestOf(landed: readonly SvnLabelledRevision[]): SvnLabelledRevision[] {
    const newest = new Map<string, SvnLabelledRevision>()
    for (const entry of landed) {
      const known = newest.get(entry.repository)
      if (known === undefined || entry.revision > known.revision) newest.set(entry.repository, entry)
    }
    return SvnRevisionLabels.merged([...newest.values()])
  }

  /**
   * Whether the main copy holds the landing. Proven again only after an svn write moved the stamp of
   * its working copies; callers asking while a proof runs share it.
   */
  async holds(mainCopy: string, landed: readonly SvnLabelledRevision[]): Promise<boolean | null> {
    const key = LandedRows.proofKey(mainCopy, landed)
    if (landed.length === 0) { this.reasons.delete(key); return true }
    const running = this.proving.get(key)
    if (running !== undefined) return running
    const proof = this.prove(key, mainCopy, landed).finally(() => this.proving.delete(key))
    this.proving.set(key, proof)
    return proof
  }

  private async prove(key: string, mainCopy: string, landed: readonly SvnLabelledRevision[]): Promise<boolean | null> {
    const before = await this.svn.landingStamp(mainCopy)
    const known = this.proofs.get(key)
    if (known !== undefined && before !== null && known.stamp === before) return known.holds
    const proof = await this.svn.landingProof(mainCopy, landed)
    if (!proof.ok) {
      this.reasons.set(key, { reason: proof.detail })
      this.proofs.delete(key)
      return null
    }
    if (proof.value.reason === undefined) this.reasons.delete(key)
    else this.reasons.set(key, { reason: proof.value.reason, ...proof.value.local === undefined ? {} : { local: proof.value.local } })
    // A write while the proof read leaves the two stamps apart, and the next ask proves again.
    const after = await this.svn.landingStamp(mainCopy)
    this.proofs.set(key, { holds: proof.value.holds, stamp: before !== null && before === after ? after : null })
    return proof.value.holds
  }

  static proofKey(mainCopy: string, landed: readonly SvnLabelledRevision[]): string {
    return `${PathCompare.comparable(mainCopy)}\t${JSON.stringify(SvnRevisionLabels.merged(landed))}`
  }

  /** The landing a row shows; `behind` is null until the server was read, and while it cannot be. */
  infoOf(mainCopy: string, landed: readonly SvnLabelledRevision[]): SessionLandingInfo {
    const roots = this.behindByMainCopy.get(PathCompare.comparable(mainCopy))?.value ?? null
    const behindRoots = (roots ?? []).filter((root) => root.behind > 0).map((root) => ({ root: root.own === '' ? '.' : root.own, behind: root.behind }))
    const known = this.reasons.get(LandedRows.proofKey(mainCopy, landed))
    const local = known?.local
    return {
      mainCopy,
      ...known === undefined ? {} : { reason: known.reason },
      ...local === undefined ? {} : { local: { ...local, summary: LandedRows.localSummaryOf(local) } },
      behind: roots === null ? null : roots.reduce((sum, root) => sum + root.behind, 0),
      ...behindRoots.length > 0 ? { behindRoots } : {},
      newest: LandedRows.newestOf(landed).map(SvnRevisionLabels.textOf),
    }
  }

  /** Which path, what local state and what the person can do; an update never changes such a state. */
  static localSummaryOf(local: SvnLandingLocal): string {
    const item = local.item
    let state: string
    let advice: string
    switch (item) {
      case 'added': state = 'is locally added'; advice = 'Revert or commit the local add in an SVN client.'; break
      case 'deleted': state = 'is locally deleted'; advice = 'Revert or commit the local delete in an SVN client.'; break
      case 'replaced': state = 'is locally replaced'; advice = 'Revert or commit the local replace in an SVN client.'; break
      case 'merged': state = 'is locally merged'; advice = 'Revert or commit the local merge in an SVN client.'; break
      case 'conflicted': state = 'is in conflict'; advice = 'Resolve the conflict in an SVN client.'; break
      case 'obstructed': state = 'is obstructed'; advice = 'Move what is in its place away, then revert the path in an SVN client.'; break
      case 'unversioned': state = 'is unversioned'; advice = 'Move the unversioned node away, then update the main copy.'; break
      case 'ignored': state = 'is unversioned and ignored'; advice = 'Move the unversioned node away, then update the main copy.'; break
      case 'external': state = 'is an external definition'; advice = 'Check the svn:externals of its parent in an SVN client.'; break
      default: throw new Error(`Unknown local item: ${JSON.stringify(item satisfies never)}`)
    }
    return `${local.path} ${state} in the main copy, and an update does not change that, so the landing cannot be proven. `
      + `${advice} To accept it, Remove this row; the worktree result stays.`
  }

  /** The waiting UPDATE offer of a landed row says what of the main copy keeps its landing unproven. */
  static offerOf(sections: SessionWorkflowInfo[], landing: SessionLandingInfo | undefined, stage: SvnActionStage | undefined): SessionWorkflowInfo[] {
    const local = landing?.local
    if (local === undefined || stage !== 'main-update') return sections
    return sections.map((section) => section.open && section.kind === 'update-main' ? { ...section, summary: local.summary } : section)
  }

  /** Whether the poll should ask `holds` for this main copy now; a yes holds the next ask off for 10 s. */
  claimHolds(mainCopy: string): boolean {
    const key = PathCompare.comparable(mainCopy)
    const at = this.holdsAt.get(key)
    if (at !== undefined && this.now() - at < LandedRows.holdsRefreshMillisecondsConst) return false
    this.holdsAt.set(key, this.now())
    return true
  }

  /**
   * Whether "N behind" of this main copy is still to read: once per landed main copy and again after
   * an ending moved it, never on a clock; only a read the server refused is tried again after 10 min.
   */
  behindDue(mainCopy: string): boolean {
    const known = this.behindByMainCopy.get(PathCompare.comparable(mainCopy))
    return known === undefined || known.value === null && this.now() - known.at >= LandedRows.behindRefreshMillisecondsConst
  }

  /** Reads "N behind" of the main copy and its mounts from the server; true when the answer moved. Offline leaves it null. */
  async refreshBehind(mainCopy: string): Promise<boolean> {
    const key = PathCompare.comparable(mainCopy)
    const read = await this.svn.behind(mainCopy)
    const value = read.ok ? read.value : null
    const before = this.behindByMainCopy.get(key)
    this.behindByMainCopy.set(key, { value, at: this.now() })
    return before === undefined || JSON.stringify(before.value) !== JSON.stringify(value)
  }

  /** An ending moved the main copy: its next pass reads both again at once. */
  markStale(mainCopy: string): void {
    const key = PathCompare.comparable(mainCopy)
    this.holdsAt.delete(key)
    this.behindByMainCopy.delete(key)
    for (const cache of [this.reasons, this.proofs])
      for (const proof of [...cache.keys()]) if (proof.startsWith(key + '\t')) cache.delete(proof)
  }

  /** Main copies that hold no landed row any more are forgotten. */
  retain(mainCopies: Iterable<string>): void {
    const kept = new Set([...mainCopies].map((mainCopy) => PathCompare.comparable(mainCopy)))
    for (const cache of [this.behindByMainCopy, this.holdsAt])
      for (const key of [...cache.keys()])
        if (!kept.has(key)) cache.delete(key)
    for (const key of this.reasons.keys()) if (!kept.has(key.split('\t')[0])) this.reasons.delete(key)
  }

}
