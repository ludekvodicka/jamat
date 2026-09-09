import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { WorktreeNaming } from '../../git/worktreeNaming'
import { type JsonDocumentReading, JsonDocumentStore } from '../../shared/jsonDocumentStore'
import type { SessionRecord } from './sessionRecord.types'
import { SessionTitle } from './sessionTitle'

export interface SessionNumbersDocument {
  schemaVersion: 1
  savedAt: number
  /** The project's directory to the highest number handed out inside it. */
  counters: Record<string, number>
}

/**
 * Where a project's worktrees are, asked of whoever knows. The store cannot work this out: the
 * directory sits under the repository ROOT, and finding that means asking git.
 */
export interface SessionNumberWorktreesPort {
  worktreesDirectoryOf(projectPath: string): Promise<string | null>
}

export interface SessionNumberStoreOptions {
  report?: (message: string) => void
  /** Without it the store looks under the project itself, which is right only for a repository root. */
  worktrees?: SessionNumberWorktreesPort
}

/**
 * The number a session is named after, one running count per project.
 *
 * It exists because a session needs a short handle that is unique inside its project and stays
 * unique afterwards: the same token is the title's prefix, the worktree directory's name and the
 * branch's, so two sessions that shared one would collide on disk rather than merely read alike.
 *
 * **A number is never reused.** Deleting a session does not free it, and neither does losing this
 * file: every read sits on `max(what was stored, what is on disk, what the records are titled)`, so
 * the count is recoverable from the very things the number was spent on. That is why there is no
 * snapshot ring here, unlike `SessionRecordsStore` - the seed IS the recovery, and a snapshot would
 * only hold an older, smaller number.
 *
 * **A project is its directory here, never its catalog name.** All three seeds then agree on what
 * they are counting, which is what a repeated number would actually collide in: one `.worktrees/`
 * folder and one branch namespace. Keying the counter by category and name instead would orphan it
 * on every rename, and would hand two catalog entries over one directory the same number.
 *
 * The latch is the same one every store in this library carries: a file that could not be READ is
 * never written over (incident 2026-06-11).
 */
export class SessionNumberStore extends JsonDocumentStore<Map<string, number>> {
  private static readonly widthConst = 3
  /** `014-feature-name`, the shape `allocate` hands out and `GitWorktreeManager` keeps. */
  private static readonly directoryPrefixConst = /^(\d{3,})(?:-|$)/
  private counters = new Map<string, number>()
  /** One answer per project for the life of the store: a repository root does not move under it. */
  private readonly worktreeDirectories = new Map<string, string | null>()

  private constructor(
    file: string,
    report: (message: string) => void,
    private readonly worktrees: SessionNumberWorktreesPort | null,
  ) {
    super(file, report)
  }

  protected get subject(): string {
    return 'Session numbers'
  }

  protected get refusalConsequence(): string {
    return 'sessions are created without a number for the rest of this session'
  }

  protected get readFailureConsequence(): string {
    return 'new sessions get no number until it is repaired or removed'
  }

  protected emptyDocument(): Map<string, number> {
    return new Map()
  }

  protected writeFailureMessage(detail: string): string {
    return `Session numbers at ${this.file} could not be written (${detail}); `
      + 'this session gets no number'
  }

  static async load(
    file: string,
    options: SessionNumberStoreOptions = {},
  ): Promise<SessionNumberStore> {
    const store = new SessionNumberStore(
      file,
      options.report ?? ((message) => console.warn(message)),
      options.worktrees ?? null,
    )
    await store.read()
    return store
  }

  /** What the next session would be called. Reads three places and writes none of them. */
  async next(projectPath: string, records: readonly SessionRecord[]): Promise<string | null> {
    // A question rather than a write, and it still refuses: the number it would answer is one this
    // store cannot record, so handing it out would name a session after a number nothing spent.
    if (!this.mayWrite()) return null
    return SessionNumberStore.tokenOf(await this.seedOf(projectPath, records) + 1)
  }

  /** Every allocation, in the order it was asked for. Held per store, like the counters. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Takes the next number and writes the new high-water mark BEFORE answering: a crash between this
   * and the session that was going to carry the token leaves a hole, which is the safe direction. A
   * write that does not land answers `null` rather than a number nothing recorded.
   *
   * **One at a time, whatever calls it.** The body reads the seed off the disk and only then writes,
   * with an `await` in between, so two allocations in flight over one project both read the same
   * seed and both hand back the same token - which becomes a worktree directory name and a branch
   * name. Nothing outside serialises them: `SessionManager.number()` is deliberately off the
   * operation queue, and `promotePlain` takes a number from ON it, so the two can meet.
   */
  async allocate(projectPath: string, records: readonly SessionRecord[]): Promise<string | null> {
    const run = this.queue.then(() => this.allocateNext(projectPath, records))
    // Swallowed on the CHAIN only: a rejection kept here would be re-thrown into every allocation
    // that queued behind it, while `run` itself still rejects for the caller that asked.
    this.queue = run.catch(() => undefined)
    return run
  }

  private async allocateNext(
    projectPath: string,
    records: readonly SessionRecord[],
  ): Promise<string | null> {
    if (!this.mayWrite()) return null
    const taken = await this.seedOf(projectPath, records) + 1
    const next = new Map(this.counters)
    next.set(SessionNumberStore.keyOf(projectPath), taken)
    const document: SessionNumbersDocument = {
      schemaVersion: 1,
      savedAt: Date.now(),
      counters: Object.fromEntries(next),
    }
    if (!await this.writeDocument(document)) return null
    this.counters = next
    return SessionNumberStore.tokenOf(taken)
  }

  /**
   * Moving a project's directory orphans its counter, and the other two seeds are what makes that
   * survivable: `.worktrees/` travels with the directory, and the records still carry the titles the
   * numbers went into.
   */
  private async seedOf(projectPath: string, records: readonly SessionRecord[]): Promise<number> {
    return Math.max(
      this.counters.get(SessionNumberStore.keyOf(projectPath)) ?? 0,
      await this.worktreeSeedOf(projectPath),
      SessionNumberStore.recordSeedOf(projectPath, records),
    )
  }

  private async worktreeSeedOf(projectPath: string): Promise<number> {
    let names: string[]
    try {
      names = await readdir(await this.worktreesDirectoryOf(projectPath))
    } catch {
      // A project that has never had a worktree, or a path this machine cannot read. Neither is
      // evidence of a spent number, and neither should stop a session from being numbered.
      return 0
    }
    return SessionNumberStore.highestOf(names, SessionNumberStore.directoryPrefixConst)
  }

  /**
   * The directory `GitWorktreeManager.create` writes into, not `<projectPath>/.worktrees`. Those are
   * the same folder for a project that IS a repository root and different for one that is a package
   * inside a monorepo - where this store used to look in a directory nothing ever wrote to, and the
   * seed it is asking for silently contributed nothing.
   *
   * With no port wired, the project's own directory is the answer: that is what a store built
   * without git can honestly say, and it is what every test that does not care about this asks for.
   */
  private async worktreesDirectoryOf(projectPath: string): Promise<string> {
    const key = SessionNumberStore.keyOf(projectPath)
    const fallback = join(projectPath, WorktreeNaming.folderNameConst)
    if (!this.worktrees) return fallback
    if (!this.worktreeDirectories.has(key))
      this.worktreeDirectories.set(key, await this.worktrees.worktreesDirectoryOf(projectPath))
    return this.worktreeDirectories.get(key) ?? fallback
  }

  private static recordSeedOf(projectPath: string, records: readonly SessionRecord[]): number {
    const wanted = SessionNumberStore.keyOf(projectPath)
    const titles = records
      .filter((record) =>
        record.directory.mode === 'project'
        && SessionNumberStore.keyOf(record.directory.projectPath) === wanted)
      .map((record) => record.title)
    let highest = 0
    for (const title of titles) {
      const number = SessionTitle.allocatedNumberOf(title)
      if (number !== null && number > highest) highest = number
    }
    return highest
  }

  private static highestOf(values: readonly string[], pattern: RegExp): number {
    let highest = 0
    for (const value of values) {
      const matched = pattern.exec(value)
      if (!matched) continue
      const number = Number(matched[1])
      if (Number.isFinite(number) && number > highest) highest = number
    }
    return highest
  }

  /** Padded to three, and wider once a project passes 999 rather than truncated back into a collision. */
  private static tokenOf(value: number): string {
    return String(value).padStart(SessionNumberStore.widthConst, '0')
  }

  private async read(): Promise<void> {
    this.counters = await this.readDocument()
  }

  /** A file this store cannot parse at all throws, which the base reads as damage. */
  protected coerce(parsed: unknown): JsonDocumentReading<Map<string, number>> {
    return { document: SessionNumberStore.countersOf(parsed), damaged: false }
  }

  private static countersOf(parsed: unknown): Map<string, number> {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected an object')
    const document = parsed as Partial<SessionNumbersDocument>
    if (document.schemaVersion !== 1)
      throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
    if (document.counters === undefined) return new Map()
    if (typeof document.counters !== 'object' || Array.isArray(document.counters))
      throw new Error('counters must be an object')
    const counters = new Map<string, number>()
    for (const [key, value] of Object.entries(document.counters)) {
      // A single unusable counter is dropped rather than latching the file: the seed rebuilds it
      // from the worktrees and the titles, so the project keeps counting where it left off.
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
      // Keyed the same way it will be looked up, so a file written before the key was normalized
      // keeps counting where it left off instead of starting again from the disk.
      const normalized = SessionNumberStore.keyOf(key)
      counters.set(normalized, Math.max(counters.get(normalized) ?? 0, Math.floor(value)))
    }
    return counters
  }

  /**
   * One spelling of a directory, because the thing a repeated number actually collides in is one
   * `.worktrees/` folder and one branch namespace, and Windows hands the same folder out under
   * several spellings: a drive letter in either case, either slash, a trailing one or not.
   *
   * Lower-casing is deliberate and it is the safe direction. Two genuinely different directories
   * merged on a case-sensitive filesystem only share a counter, so numbers are skipped; one
   * directory split in two hands the SAME number to two sessions, and with it the same worktree
   * folder and the same branch. `SessionsTreeModel.normalizePath` reads this data the same way.
   */
  private static keyOf(projectPath: string): string {
    return projectPath.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  }
}
