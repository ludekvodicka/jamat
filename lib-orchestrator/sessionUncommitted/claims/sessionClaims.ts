import { lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  FileChangesShellRuns,
  type FileChangesShellRun,
} from '../../fileChangesManager/sessionMutationsView'
import { PathCompare } from '../../shared/pathCompare'
import type { SvnPathFacts } from '../../svn/svnPathStates'
import { ShellPathNames } from './shellPathNames'

export type ClaimSource = 'tool' | 'shell' | 'status'

/**
 * One path a session wrote. `lastWriteAt` is its newest write: the transcript time of a tool edit,
 * the file time for a shell or status claim. `settledAt` is the `lastWriteAt` the claim had when it
 * was seen committed or clean after it; the claim is open while `lastWriteAt` is newer.
 */
export interface PathClaim {
  path: string
  source: ClaimSource
  lastWriteAt: number
  settledAt: number | null
}

/**
 * The paths one session claims and when each claim ends (D6, D7). A claim never leaves the set: a
 * settled claim keeps the write it settled, so the same edit read again (a transcript read from its
 * start) does not open it, and a later edit of the session does.
 */
export class SessionClaims {
  /** The newest runs are kept; the cache bounds them the same way. */
  static readonly maxShellRunsConst = 2_000
  /** `changed_date` is the server's clock, `lastWriteAt` this PC's: a commit must clear the write by this much. */
  static readonly commitSlackMillisecondsConst = FileChangesShellRuns.slackMillisecondsConst

  private readonly cwd: string
  private readonly root: string
  private readonly claims = new Map<string, PathClaim>()
  private runs: FileChangesShellRun[] = []

  constructor(options: { cwd: string; root: string; claims?: readonly PathClaim[]; shellRuns?: readonly FileChangesShellRun[] }) {
    this.cwd = options.cwd
    this.root = options.root
    for (const claim of options.claims ?? []) this.claims.set(PathCompare.comparable(claim.path), { ...claim })
    this.runs = [...(options.shellRuns ?? [])]
  }

  all(): readonly PathClaim[] {
    return [...this.claims.values()]
  }

  shellRuns(): readonly FileChangesShellRun[] {
    return this.runs
  }

  open(): readonly PathClaim[] {
    return this.all().filter(SessionClaims.isOpen)
  }

  /** Confirmed tool edits; the old path of a move counts too. Relative paths are the session directory's. */
  addMutations(mutations: readonly { path: string; previousPath: string | null; createdAt: number }[]): void {
    for (const mutation of mutations) {
      this.claim(resolve(this.cwd, mutation.path), 'tool', mutation.createdAt)
      if (mutation.previousPath !== null) this.claim(resolve(this.cwd, mutation.previousPath), 'tool', mutation.createdAt)
    }
  }

  /**
   * A path a run names counts only while its current write time lies within that run, so a `cat`
   * or `svn diff` of a file somebody else changed later adds nothing. The runs are kept for status
   * observations, which see paths no command named.
   */
  addShellRuns(runs: readonly FileChangesShellRun[]): void {
    const known = new Set(this.runs.map(SessionClaims.runKey))
    const added = runs.filter((run) => !known.has(SessionClaims.runKey(run)))
    if (added.length === 0) return
    for (const run of added)
      for (const path of ShellPathNames.of(run.command, [this.cwd, this.root])) {
        const modifiedAt = SessionClaims.modifiedAt(path)
        if (modifiedAt !== null && FileChangesShellRuns.ranAt([run], modifiedAt)) this.claim(path, 'shell', modifiedAt)
      }
    this.runs = [...this.runs, ...added]
      .sort((left, right) => left.endedAt - right.endedAt)
      .slice(-SessionClaims.maxShellRunsConst)
  }

  /**
   * A status Jamat computed for `root` anyway: an entry counts when it was written while a run of
   * this session ran that names it (a directory also through a path inside it), or names one of its
   * directories below the session directory (`node build.mjs gen/` writing `gen/out.ts`).
   */
  observeStatus(
    root: string,
    entries: readonly { absolutePath: string; nodeKind: 'file' | 'directory' }[],
    mtimes: ReadonlyMap<string, number>,
  ): void {
    if (this.runs.length === 0) return
    const shells = new FileChangesShellRuns(this.runs)
    const bases = [this.cwd, root]
    for (const entry of entries) {
      const modifiedAt = mtimes.get(entry.absolutePath)
      if (modifiedAt === undefined) continue
      const named = [...shells.named(entry.absolutePath, bases, entry.nodeKind === 'directory')]
      for (let directory = dirname(entry.absolutePath);
        PathCompare.isInside(this.cwd, directory) && PathCompare.comparable(directory) !== PathCompare.comparable(this.cwd);
        directory = dirname(directory))
        named.push(...shells.named(directory, bases, true))
      if (FileChangesShellRuns.ranAt(named, modifiedAt)) this.claim(entry.absolutePath, 'status', modifiedAt)
    }
  }

  /**
   * Applies D7 to every open claim that `facts` decide and returns the open claims that are dirty
   * now. A claim ends when its node was committed after the last write (`changedAtMs`), or when the
   * path is seen clean after it. An unknown or missing fact changes nothing and is not returned.
   */
  settle(facts: ReadonlyMap<string, SvnPathFacts>, now: number): readonly PathClaim[] {
    const dirty: PathClaim[] = []
    for (const claim of this.claims.values()) {
      if (!SessionClaims.isOpen(claim)) continue
      const fact = facts.get(claim.path)
      if (fact === undefined) continue
      if (fact.changedAtMs !== null && fact.changedAtMs > claim.lastWriteAt + SessionClaims.commitSlackMillisecondsConst) {
        claim.settledAt = claim.lastWriteAt
        continue
      }
      switch (fact.state.kind) {
        case 'clean':
          if (now >= claim.lastWriteAt) claim.settledAt = claim.lastWriteAt
          break
        case 'dirty':
          dirty.push(claim)
          break
        case 'unknown':
        case 'outside':
          break
        default:
          throw new Error(`Unknown path state: ${JSON.stringify(fact.state satisfies never)}`)
      }
    }
    return dirty
  }

  static isOpen(claim: PathClaim): boolean {
    return claim.settledAt === null || claim.lastWriteAt > claim.settledAt
  }

  /** A claim keeps its newest write; the source follows that write. */
  private claim(path: string, source: ClaimSource, writtenAt: number): void {
    const key = PathCompare.comparable(path)
    const found = this.claims.get(key)
    if (found === undefined) this.claims.set(key, { path, source, lastWriteAt: writtenAt, settledAt: null })
    else if (writtenAt > found.lastWriteAt) {
      found.lastWriteAt = writtenAt
      found.source = source
    }
  }

  private static runKey(run: FileChangesShellRun): string {
    return `${run.startedAt}\0${run.endedAt}\0${run.command}`
  }

  private static modifiedAt(path: string): number | null {
    try { return lstatSync(path, { throwIfNoEntry: false })?.mtimeMs ?? null }
    catch { return null }
  }
}
