import type { FileHandle } from 'node:fs/promises'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ErrorText } from '../../../shared/errorText'
import { PathCompare } from '../../../shared/pathCompare'
import type { CodexRolloutCwdMemo, RolloutStamp } from './codexRolloutCwdMemo'

export interface CodexRolloutRef {
  file: string
  sessionId: string
  /** Parsed from the file name, so it costs nothing and never disagrees with where the file sits. */
  createdAt: number
}

/**
 * A survivor of the exact-window walk: the ref plus the one header field the capture passes read.
 *
 * It rides on this walk alone. The listing path serves headers out of the cwd memo, which holds only
 * `cwd`, so carrying the parent there would mean a memo schema bump and a cold rebuild for a field
 * only a capture reads.
 */
export interface CodexRolloutWindowRef extends CodexRolloutRef {
  /** `forked_from_id` of the `session_meta` header; null when the field is null or absent. */
  forkedFromId: string | null
}

/** How much of the store a walk covers, and therefore whether its absences may be believed. */
type RolloutScope =
  | { kind: 'window'; cutoff: number }
  | { kind: 'whole' }
  /** Only what was written inside one launch window, including both edge moments. */
  | { kind: 'between'; from: number; until: number }

/** A header this walk resolved, and the stamp that answer is only true for. */
interface ReadCwd {
  cwd: string
  /** Absent when the file could not be stat'd, which is the one case nothing may be remembered. */
  stamp: RolloutStamp | null
}

/** Everything one header read answers. The memo remembers only the first of them. */
interface ReadHeader {
  cwd: string
  forkedFromId: string | null
}

/**
 * Which rollouts belong to which project directory.
 *
 * Codex files a session under the DATE it started, `<codexHome>/sessions/YYYY/MM/DD/rollout-<ISO
 * timestamp>-<uuid>.jsonl`, and records the project directory inside the file, in the `session_meta`
 * header's `cwd`. The project is therefore not in the path, and unlike Claude there is nothing to
 * derive: the question "which sessions belong to this project" can only be answered by an index
 * built over the store.
 *
 * That layout and that header are observed behaviour of a local CLI, not a published API. Every file
 * that does not look the way this class expects is skipped and reported, and the rest of the index
 * is still built.
 */
export class CodexRolloutIndex {
  /**
   * A heavy history holds tens of thousands of rollouts, and a cold build over all of them takes
   * long enough to stall the first project listing. Older sessions stay on disk, they just do not
   * appear in the picker - and `allFilesForProject` deliberately ignores this window.
   */
  private static readonly scanWindowDaysConst = 90
  private static readonly dayMillisecondsConst = 86_400_000
  /**
   * `cwd` sits at the front of the header line, ahead of the several kilobytes of base instructions,
   * so a bounded prefix answers the only question the index asks of a rollout's content.
   */
  private static readonly headerReadBytesConst = 16 * 1024
  private static readonly cacheTtlMillisecondsConst = 30_000
  /**
   * How many rollout headers are read at once.
   *
   * Measured over this machine's real store of 25 371 rollouts, cold, with the memo removed before
   * each run: one at a time 8 758 ms, then 8 at a time 2 157/2 310/2 402 ms, 16 at a time
   * 2 883/2 228/2 037 ms, 32 at a time 2 387/2 129/2 072 ms. **The pool size makes no difference
   * past 8** - the three sets overlap completely, and what changed was the disk, not the waiting.
   * 16 is the middle of the flat part; anything from 8 to 32 would measure the same.
   */
  private static readonly headerReadConcurrencyConst = 16
  private static readonly sessionsDirectoryNameConst = 'sessions'
  private static readonly rolloutPatternConst =
    /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  private static readonly cwdPatternConst = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/
  /**
   * The conversation this one was cut from. Same escape-aware quoted shape as the cwd, plus the
   * literal `null` Codex writes for a session that was not forked; an absent field means the same.
   */
  private static readonly forkedFromPatternConst =
    /"forked_from_id"\s*:\s*(?:null|"((?:[^"\\]|\\.)*)")/
  private static readonly yearPatternConst = /^\d{4}$/
  private static readonly monthDayPatternConst = /^\d{2}$/

  private byCwd: Map<string, CodexRolloutRef[]> | null = null
  private builtAt = 0
  private generation = 0
  private building: Promise<Map<string, CodexRolloutRef[]>> | null = null

  constructor(
    private readonly codexHome: string,
    private readonly report: (message: string) => void = (message) => console.warn(message),
    /**
     * Absent means every walk reads every header, which is what this class did before the memo
     * existed and is still the right answer for a caller that has nowhere to keep one.
     */
    private readonly memo: CodexRolloutCwdMemo | null = null,
  ) {}

  /**
   * Where this class reads the store, spelled for whoever has to name the same root - the memo is
   * built before the index that owns the layout exists, and a second `join(codexHome, 'sessions')`
   * in the composition root would silently rebuild the whole memo the day the layout moved.
   */
  static sessionsRootOf(codexHome: string): string {
    return join(codexHome, CodexRolloutIndex.sessionsDirectoryNameConst)
  }

  /** The listing path: only the window, cached, asked again for every keystroke of a picker. */
  async filesForProject(projectDir: string): Promise<CodexRolloutRef[]> {
    const index = await this.ensureBuilt()
    return [...(index.get(CodexRolloutIndex.normalizedCwd(projectDir)) ?? [])]
  }

  /**
   * Every rollout of this project, however old, walked fresh and not cached.
   *
   * A rename or a delete happens once and must name the whole history: a rollout older than the
   * window would otherwise keep a path that no longer exists, with nothing reported and nothing left
   * to find it by. The window is right where the cost is paid over and over; it is wrong here.
   */
  async allFilesForProject(projectDir: string): Promise<CodexRolloutRef[]> {
    const index = await this.build({ kind: 'whole' })
    return index.get(CodexRolloutIndex.normalizedCwd(projectDir)) ?? []
  }

  /**
   * The rollouts this project recorded inside one launch window, walked fresh and cached nowhere.
   *
   * The listing paths above are the wrong tool for a question asked while a session is starting:
   * `filesForProject` answers out of a map up to thirty seconds old, so it cannot see a file written
   * a second ago, and building that map without a memo reads the header of every rollout in ninety
   * days - measured at 2.2 s over 25 371 of them. This reads the day directories the launch window
   * touches, rejects candidates outside either edge by their own NAME, and opens only what is left.
   * A launch window therefore costs a handful of directory listings and a header or two regardless
   * of how old its session record is.
   *
   * Nothing is remembered from here and nothing is recalled here either, by construction: no
   * in-memory map, no memo write and no memo read, so a slice of the store can never be mistaken for
   * the store, the memo keeps its single writer, and the header this walk needs whole is read whole.
   */
  async rolloutsBetween(
    projectDir: string,
    from: number,
    until: number,
  ): Promise<CodexRolloutWindowRef[]> {
    const root = CodexRolloutIndex.sessionsRootOf(this.codexHome)
    const candidates = (await this.candidates(root, { kind: 'between', from, until }))
      .filter((candidate) => candidate.createdAt >= from && candidate.createdAt <= until)
    const reads = await this.pooled(candidates, (file) => this.headerFields(file))
    const wanted = CodexRolloutIndex.normalizedCwd(projectDir)
    const found: CodexRolloutWindowRef[] = []
    candidates.forEach((candidate, index) => {
      const read = reads[index]
      if (read !== null && CodexRolloutIndex.normalizedCwd(read.cwd) === wanted)
        found.push({ ...candidate, forkedFromId: read.forkedFromId })
    })
    return found.sort((left, right) => right.createdAt - left.createdAt)
  }

  invalidate(): void {
    this.generation += 1
    this.byCwd = null
    this.builtAt = 0
  }

  /**
   * The rollouts of a project whose recorded `cwd` was just rewritten, so the memo stops answering
   * with the path the move replaced.
   *
   * The migrator is not the only thing that rewrites a header - the startup sweep retries whatever a
   * relocation left locked, at a later start and one file at a time - so this is a shortcut and not
   * the mechanism: a memo entry carries the file's stamp and a rewrite by anyone at all is a miss.
   * What the shortcut buys is the walk it saves, and the generation bump, which is what stops a walk
   * that read these headers BEFORE the rewrite from writing them back after it.
   */
  forgetProject(projectDir: string): void {
    const target = CodexRolloutIndex.normalizedCwd(projectDir)
    this.generation += 1
    this.memo?.forget((cwd) => CodexRolloutIndex.normalizedCwd(cwd) === target)
    this.memo?.save()
  }

  /** The same, for the sweep: it rewrites one recorded file at a time and knows exactly which. */
  forgetFile(file: string): void {
    this.generation += 1
    this.memo?.forgetFile(file)
    this.memo?.save()
  }

  /**
   * A bounded prefix of a rollout, shared with the session source: nothing on the listing path ever
   * parses a whole rollout, which after a long session is tens of megabytes.
   */
  static async readPrefix(file: string, byteLimit: number): Promise<string> {
    const handle: FileHandle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(byteLimit)
      const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  /**
   * Lowercased on every platform, unlike `PathCompare.comparable`: this compares a path another
   * process wrote down against one of ours, and Codex records whatever casing the shell handed it.
   */
  private static normalizedCwd(value: string): string {
    return PathCompare.normalized(value).toLowerCase()
  }

  private async ensureBuilt(): Promise<Map<string, CodexRolloutRef[]>> {
    if (this.byCwd && Date.now() - this.builtAt < CodexRolloutIndex.cacheTtlMillisecondsConst)
      return this.byCwd
    if (!this.building) this.building = this.buildUntilCurrent()
    return this.building
  }

  private async buildUntilCurrent(): Promise<Map<string, CodexRolloutRef[]>> {
    try {
      while (true) {
        const generation = this.generation
        const built = await this.build({
          kind: 'window',
          cutoff: Date.now()
            - CodexRolloutIndex.scanWindowDaysConst * CodexRolloutIndex.dayMillisecondsConst,
        })
        // An invalidate() during the walk means this result already describes a store that moved,
        // and caching it would serve pre-invalidation data for a whole TTL.
        if (this.generation !== generation) continue
        this.byCwd = built
        this.builtAt = Date.now()
        return built
      }
    } finally {
      this.building = null
    }
  }

  /**
   * Two steps, and the split is the whole point: naming the rollouts is a handful of directory
   * listings, reading their headers is tens of thousands of file opens. Done in one loop with an
   * await per file, the second cost was paid one round trip at a time.
   */
  private async build(scope: RolloutScope): Promise<Map<string, CodexRolloutRef[]>> {
    const generation = this.generation
    const root = CodexRolloutIndex.sessionsRootOf(this.codexHome)
    const candidates = await this.candidates(root, scope)
    const reads = await this.cwdsOf(candidates)
    const byCwd = new Map<string, CodexRolloutRef[]>()
    // Folded back in walk order, so the map is built exactly as the sequential loop built it and
    // the concurrency cannot reach the result.
    candidates.forEach((candidate, index) => {
      const read = reads[index]
      // A rollout whose header could not be read is not remembered: the next walk tries again,
      // because the reason may have been a lock rather than the file's shape.
      if (read === null) return
      const key = CodexRolloutIndex.normalizedCwd(read.cwd)
      const refs = byCwd.get(key)
      if (refs) refs.push(candidate)
      else byCwd.set(key, [candidate])
    })
    this.remember(candidates, reads, scope, generation)
    for (const refs of byCwd.values())
      refs.sort((left, right) => right.createdAt - left.createdAt)
    return byCwd
  }

  /**
   * What this walk learned, persisted only if it still describes the store the caller asked about.
   *
   * The generation is the same guard `buildUntilCurrent` puts on the in-memory map, and it is needed
   * here for a sharper reason: the headers were read before a `forgetProject` that landed mid-walk,
   * so writing them back would re-insert exactly the entries it just dropped, and persist them.
   */
  private remember(
    candidates: readonly CodexRolloutRef[],
    reads: readonly (ReadCwd | null)[],
    scope: RolloutScope,
    generation: number,
  ): void {
    const memo = this.memo
    if (!memo || this.generation !== generation) return
    candidates.forEach((candidate, index) => {
      const read = reads[index]
      if (read?.stamp) memo.set(candidate.file, read.cwd, read.stamp)
    })
    // An empty walk is not an empty store: `namesIn` answers [] for a sessions directory it could not
    // read, and pruning from that would throw the whole memo away over a momentary permission error.
    if (CodexRolloutIndex.mayPrune(scope) && candidates.length > 0)
      memo.prune(candidates.map((candidate) => candidate.file))
    memo.save()
  }

  /** Only a walk that saw the whole store may say what is gone; the window saw ninety days of it. */
  private static mayPrune(scope: RolloutScope): boolean {
    if (scope.kind === 'whole') return true
    else if (scope.kind === 'window') return false
    else if (scope.kind === 'between') return false
    else
      throw new Error(`Unknown rollout scope: ${JSON.stringify(scope)}`)
  }

  private static inScope(day: { starts: number; ends: number }, scope: RolloutScope): boolean {
    if (scope.kind === 'whole') return true
    else if (scope.kind === 'window') return day.starts >= scope.cutoff
    // The day HOLDING the moment counts, so the test is on the day's end rather than its start: a
    // session started at noon is written into a directory stamped midnight.
    else if (scope.kind === 'between')
      return day.ends > scope.from && day.starts <= scope.until
    else
      throw new Error(`Unknown rollout scope: ${JSON.stringify(scope)}`)
  }

  /**
   * A day starts and ends at LOCAL midnight, and the two are not always 24 hours apart: the day the
   * clock goes back is 25 hours long. The end used to be the start plus a constant day, so on that
   * one day it fell an hour early, the directory was skipped, and a Codex session started between
   * 23:00 and midnight could not find its own rollout at reconcile or at startup recovery.
   *
   * `setDate` is what knows this: it moves the calendar day and keeps the local time of day, which
   * is exactly "the next midnight" whichever way the clock moved.
   */
  private static dayBounds(year: string, month: string, day: string): { starts: number; ends: number } | null {
    const starts = new Date(Number(year), Number(month) - 1, Number(day))
    if (Number.isNaN(starts.getTime())) return null
    const ends = new Date(starts)
    ends.setDate(ends.getDate() + 1)
    return { starts: starts.getTime(), ends: ends.getTime() }
  }

  /** Every rollout in range, named and dated from its own file name, without opening one. */
  private async candidates(root: string, scope: RolloutScope): Promise<CodexRolloutRef[]> {
    const found: CodexRolloutRef[] = []
    for (const dayDirectory of await this.dayDirectories(root, scope)) {
      for (const name of await this.namesIn(dayDirectory)) {
        const match = name.match(CodexRolloutIndex.rolloutPatternConst)
        if (!match) continue
        const file = join(dayDirectory, name)
        const createdAt = Date.parse(
          `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`,
        )
        if (Number.isNaN(createdAt)) {
          this.report(`Codex rollout ${file} carries an unparsable timestamp; skipping it`)
          continue
        }
        found.push({ file, sessionId: match[7], createdAt })
      }
    }
    return found
  }

  /**
   * The recorded directory of each candidate, in the same order, read through a bounded pool.
   *
   * A remembered header costs a stat instead of a 16 KB open-and-read, and still passes through
   * here, because a walk over a store this process has already read is then a pool of stats rather
   * than a pool doing nothing. The cap is what keeps a store of 25 000 rollouts from asking the
   * filesystem for 25 000 open handles at once.
   */
  private async cwdsOf(candidates: readonly CodexRolloutRef[]): Promise<(ReadCwd | null)[]> {
    return this.pooled(candidates, (file) => this.cwdOf(file))
  }

  /** The same bounded pool for either read, results in the candidates' own order. */
  private async pooled<T>(
    candidates: readonly CodexRolloutRef[],
    read: (file: string) => Promise<T | null>,
  ): Promise<(T | null)[]> {
    const reads = new Array<T | null>(candidates.length).fill(null)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next
        next += 1
        if (index >= candidates.length) return
        reads[index] = await read(candidates[index].file)
      }
    }
    const workers = Math.min(CodexRolloutIndex.headerReadConcurrencyConst, candidates.length)
    await Promise.all(Array.from({ length: workers }, worker))
    return reads
  }

  /**
   * Stamped before the header is read, never after: a rewrite that lands between the two then leaves
   * a stamp older than the bytes, which the next walk reads as a miss. The other order would remember
   * an answer under a stamp taken from content nobody looked at.
   */
  private async cwdOf(file: string): Promise<ReadCwd | null> {
    const memo = this.memo
    const stamp = memo ? await CodexRolloutIndex.stampOf(file) : null
    const remembered = memo && stamp ? memo.get(file, stamp) : null
    if (remembered !== null) return { cwd: remembered, stamp }
    const cwd = await this.headerCwd(file)
    return cwd === null ? null : { cwd, stamp }
  }

  /** A file nothing can stat is a file nothing may remember; the header read then reports it. */
  private static async stampOf(file: string): Promise<RolloutStamp | null> {
    try {
      const stats = await stat(file)
      return { mtimeMs: stats.mtimeMs, size: stats.size }
    }
    catch { return null }
  }

  /** The `YYYY/MM/DD` directories inside the scope; anything not shaped like a date is not one. */
  private async dayDirectories(root: string, scope: RolloutScope): Promise<string[]> {
    const directories: string[] = []
    for (const year of await this.namesIn(root)) {
      if (!CodexRolloutIndex.yearPatternConst.test(year)) continue
      const yearDirectory = join(root, year)
      for (const month of await this.namesIn(yearDirectory)) {
        if (!CodexRolloutIndex.monthDayPatternConst.test(month)) continue
        const monthDirectory = join(yearDirectory, month)
        for (const day of await this.namesIn(monthDirectory)) {
          if (!CodexRolloutIndex.monthDayPatternConst.test(day)) continue
          const bounds = CodexRolloutIndex.dayBounds(year, month, day)
          if (bounds === null) continue
          if (!CodexRolloutIndex.inScope(bounds, scope)) continue
          directories.push(join(monthDirectory, day))
        }
      }
    }
    return directories
  }

  /** A missing or unreadable directory is empty, not an error: the store belongs to another app. */
  private async namesIn(directory: string): Promise<string[]> {
    try { return await readdir(directory) }
    catch { return [] }
  }

  /** What the listing path asks of a header. The parent link is read and dropped. */
  private async headerCwd(file: string): Promise<string | null> {
    return (await this.headerFields(file))?.cwd ?? null
  }

  /**
   * One prefix read, both answers. The cwd decides whether the file counts at all, so a missing one
   * is reported and the file skipped, exactly as before.
   *
   * The parent is taken from the `session_meta` LINE alone rather than the whole prefix: a later
   * `response_item` may quote the words of the header back, and a rollout that names a parent it was
   * not cut from is the one mistake this field exists to prevent.
   */
  private async headerFields(file: string): Promise<ReadHeader | null> {
    let head: string
    try {
      head = await CodexRolloutIndex.readPrefix(file, CodexRolloutIndex.headerReadBytesConst)
    } catch (error) {
      this.report(`Codex rollout ${file} could not be read (${ErrorText.of(error)}); skipping it`)
      return null
    }
    const match = head.match(CodexRolloutIndex.cwdPatternConst)
    if (!match) {
      this.report(
        `Codex rollout ${file} has no session_meta cwd in its first `
        + `${CodexRolloutIndex.headerReadBytesConst} bytes; skipping it`,
      )
      return null
    }
    let cwd: string
    try { cwd = JSON.parse(`"${match[1]}"`) as string }
    catch (error) {
      this.report(`Codex rollout ${file} has an unreadable cwd (${ErrorText.of(error)}); skipping it`)
      return null
    }
    return { cwd, forkedFromId: CodexRolloutIndex.forkedFromOf(head) }
  }

  /**
   * The parent named in the header line, or null for `null`, an absent field, and a value this
   * process cannot read back. A parent nobody could parse is a parent nobody may claim by, and the
   * cwd already decided the file is usable, so this stays silent rather than skipping the rollout.
   */
  private static forkedFromOf(head: string): string | null {
    const newline = head.indexOf('\n')
    const header = newline === -1 ? head : head.slice(0, newline)
    const match = header.match(CodexRolloutIndex.forkedFromPatternConst)
    if (!match || match[1] === undefined) return null
    try { return JSON.parse(`"${match[1]}"`) as string }
    catch { return null }
  }
}
