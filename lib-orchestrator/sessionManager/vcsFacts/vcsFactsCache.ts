import { PathCompare } from '../../shared/pathCompare'
import type {
  FileChangesVcsDetection,
  FileChangesVcsId,
} from '../../fileChangesManager/fileChangesManagerApi.types'
import type { VcsStatusView } from '../../fileChangesManager/vcsStatusView'
import type { SessionVcsInfo } from '../sessionManagerApi.types'

export interface VcsFactsCacheDeps {
  view: VcsStatusView
  /** Read per pass rather than captured, so a settings change reaches the next probe. */
  preferredVcsOf: () => FileChangesVcsId
  nowOf?: () => number
}

interface RootEntry {
  /**
   * The directory as it was handed in, which is what a probe is spawned against. The MAP is keyed by
   * the comparable form: `resolve()` unifies separators and nothing else, so `q:\proj` and `Q:\Proj`
   * bought two probes of one directory and a `markStale` on one did not reach the other.
   */
  path: string
  /** Null is a measurement too: this directory is governed by no VCS. */
  detection: FileChangesVcsDetection | null
  detectedAt: number
  fact: SessionVcsInfo | null
  measuredAt: number
  stale: boolean
  /** Probes that failed in a row. Past a ceiling the kept fact is dropped rather than drawn stale. */
  failures: number
}

/**
 * What every working copy behind a session looks like, remembered per DIRECTORY rather than per
 * session. Sessions of one project share a cwd, so ten of them cost one probe, and that dedup is
 * the whole reason this is cheap: a probe is a child process, and a child process is ~85 ms.
 *
 * It owns memory and no clock. There is one cadence in this library and it lives in
 * `SessionManager`, so this class is handed the set of directories to care about and decides only
 * WHICH of them are old enough to ask about again. The work-state monitor beside it is shaped the
 * same way and for the same reason.
 */
export class VcsFactsCache {
  /** Per VCS, because svn is not git's equal: it stats the whole working copy where git reads an index. */
  private static readonly gitStalenessMillisecondsConst = 30_000
  private static readonly svnStalenessMillisecondsConst = 60_000
  /** Detection is the expensive half and almost never changes; a repository that appears or is deleted is rare. */
  private static readonly redetectMillisecondsConst = 600_000
  /**
   * How many probes in a row may fail before the last known fact is dropped. Three windows is long
   * enough for a share that blinks and short enough that nobody acts on a mark measured minutes ago.
   */
  private static readonly failuresKeptConst = 3

  private readonly roots = new Map<string, RootEntry>()
  private inFlight = false

  constructor(private readonly deps: VcsFactsCacheDeps) {}

  /** Synchronous, because composing a snapshot cannot wait on a process. */
  factOf(cwd: string): SessionVcsInfo | null {
    return this.roots.get(PathCompare.comparable(cwd))?.fact ?? null
  }

  /**
   * The settle nudge. A turn that just finished is exactly when the mark is wrong, so the caller
   * says so and the next pass re-probes that one directory instead of waiting out its window.
   */
  markStale(cwd: string): void {
    const entry = this.roots.get(PathCompare.comparable(cwd))
    if (entry !== undefined) entry.stale = true
  }

  /**
   * True when a fact appeared, flipped or disappeared - the caller publishes only then, so a pass
   * that measured the same thing again wakes no window.
   *
   * Sequential on purpose: a burst of child processes is the failure mode this whole design exists
   * to avoid, and nothing here is waiting on the result.
   */
  async refresh(cwds: ReadonlySet<string>): Promise<boolean> {
    if (this.inFlight) return false
    this.inFlight = true
    try {
      let moved = false
      const wanted = new Set([...cwds].map((cwd) => PathCompare.comparable(cwd)))
      for (const cwd of cwds) {
        const entry = this.roots.get(PathCompare.comparable(cwd))
        if (entry !== undefined && !this.due(entry)) continue
        moved = await this.probe(cwd, entry) || moved
      }
      // A directory nobody stands in any more is not probed forever.
      for (const key of [...this.roots.keys()])
        if (!wanted.has(key)) {
          this.roots.delete(key)
          moved = true
        }
      return moved
    }
    finally { this.inFlight = false }
  }

  private async probe(cwd: string, entry: RootEntry | undefined): Promise<boolean> {
    const now = this.now()
    // Answered at the START of the probe, not at the end. Reading it afterwards read the entry this
    // probe has not replaced yet, so the flag that made the probe run set itself again and `due()`
    // answered true on every 2 s pass for the rest of the process - one child every two seconds for
    // a directory nobody had touched since. Cleared here, the read after the await sees only a
    // settle raised WHILE this probe was in flight, which is what it was written for.
    if (entry !== undefined) entry.stale = false
    const redetect = entry === undefined || now - entry.detectedAt >= VcsFactsCache.redetectMillisecondsConst
    const detection = redetect
      ? await this.deps.view.detect(cwd, this.deps.preferredVcsOf())
      : entry.detection
    const detectedAt = redetect ? now : entry.detectedAt
    if (detection === null)
      return this.write(cwd, {
        path: cwd,
        detection: null,
        detectedAt,
        fact: null,
        measuredAt: now,
        stale: false,
        failures: 0,
      })
    const dirty = await this.deps.view.dirty(detection)
    if (!dirty.ok) {
      // A failed probe keeps the last known fact for a while and waits out its own window rather
      // than retrying at once: a working copy on a share that dropped, or an svn that is not on
      // PATH, fails every single time, and retrying immediately is the burst of child processes
      // this whole design exists to avoid.
      //
      // "For a while" is the point. Kept indefinitely, a directory measured CLEAN before the probes
      // started failing keeps a clean mark while somebody works in it - and that mark is what the
      // Finish affordance reads before throwing a worktree away. Past the ceiling the fact goes,
      // and no mark is drawn at all.
      const failures = (entry?.failures ?? 0) + 1
      const kept = failures <= VcsFactsCache.failuresKeptConst ? entry?.fact ?? null : null
      return this.write(cwd, {
        path: cwd,
        detection,
        detectedAt,
        fact: kept,
        measuredAt: now,
        stale: false,
        failures,
      })
    }
    // Re-read AFTER the await, and it is only ever true when a settle was raised while this probe
    // was in flight: that settle is about a turn this answer predates, so the next pass runs again.
    const stale = this.roots.get(PathCompare.comparable(cwd))?.stale ?? false
    return this.write(cwd, {
      path: cwd,
      detection,
      detectedAt,
      fact: { vcsId: detection.id, dirty: dirty.value },
      measuredAt: now,
      stale,
      failures: 0,
    })
  }

  private write(cwd: string, next: RootEntry): boolean {
    const key = PathCompare.comparable(cwd)
    const before = this.roots.get(key)?.fact ?? null
    this.roots.set(key, next)
    return !VcsFactsCache.sameFact(before, next.fact)
  }

  private due(entry: RootEntry): boolean {
    if (entry.stale) return true
    const now = this.now()
    if (entry.detection === null)
      return now - entry.detectedAt >= VcsFactsCache.redetectMillisecondsConst
    return now - entry.measuredAt >= VcsFactsCache.stalenessOf(entry.detection.id)
  }

  private static stalenessOf(id: FileChangesVcsId): number {
    if (id === 'git') return VcsFactsCache.gitStalenessMillisecondsConst
    else if (id === 'svn') return VcsFactsCache.svnStalenessMillisecondsConst
    else
      throw new Error(`Unknown VCS id: ${JSON.stringify(id)}`)
  }

  private static sameFact(before: SessionVcsInfo | null, after: SessionVcsInfo | null): boolean {
    if (before === null || after === null) return before === after
    return before.vcsId === after.vcsId && before.dirty === after.dirty
  }

  private now(): number {
    return this.deps.nowOf?.() ?? Date.now()
  }
}
