import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { RuntimeCategory } from '../catalog/catalog.types'
import type { ProjectEntry } from '../projectManagerApi.types'

/** The three members of a `Dirent` this walk uses, and all a test has to provide. */
export interface ScanDirectoryEntry {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface ScannerFileSystem {
  readdir(directory: string): Promise<ScanDirectoryEntry[]>
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

export interface ScanResult {
  entries: ProjectEntry[]
  /** The listing is incomplete: the cap, the per-root deadline or an abort stopped the walk. */
  truncated: boolean
  /** False when the root could not be read; the category itself stays listed either way. */
  available: boolean
}

interface CacheEntry {
  result: ScanResult
  builtAt: number
  generation: number
}

interface WalkOutcome {
  entries: ProjectEntry[]
  truncated: boolean
  /** Stopped by time or by the caller, so the result is not the root's contents and is not cached. */
  cutShort: boolean
}

type DeadlineOutcome<T> = { done: true; value: T } | { done: false }

/**
 * The projects of one category root: every directory one level down, plus one extra level inside the
 * containers named in `flattenFolders`.
 *
 * The semantics come from V1 `core/menu-core/projects.ts`; the guards do not. A root here can be a
 * network share with thousands of directories, so the walk is asynchronous, does one `readdir` per
 * directory instead of a `stat` per entry, stops at a cap and at a deadline, and reports what it cut
 * short rather than pretending the root is empty.
 */
export class ProjectScanner {
  private static readonly maxEntriesConst = 2000
  private static readonly timeoutMillisecondsConst = 5_000
  private static readonly cacheTtlMillisecondsConst = 30_000
  private static readonly archivedFolderNameConst = 'Archived'

  private readonly fileSystem: ScannerFileSystem
  private readonly cache = new Map<string, CacheEntry>()
  private readonly generations = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<ScanResult>>()

  constructor(fileSystem?: ScannerFileSystem) {
    this.fileSystem = fileSystem ?? ProjectScanner.nodeFileSystem()
  }

  async scan(category: RuntimeCategory, options?: { signal?: AbortSignal }): Promise<ScanResult> {
    const cached = this.cache.get(category.id)
    if (cached
      && cached.generation === this.generationOf(category.id)
      && Date.now() - cached.builtAt < ProjectScanner.cacheTtlMillisecondsConst)
      return cached.result
    const running = this.inFlight.get(category.id)
    // A caller that joins a walk it did not start does not get to cancel it: its signal would abort
    // the result the first caller is still waiting for.
    if (running) return running
    const run = this.runScan(category, options?.signal)
    this.inFlight.set(category.id, run)
    try { return await run }
    finally { this.inFlight.delete(category.id) }
  }

  /** Called after every lifecycle operation; without an id it invalidates every known category. */
  invalidate(categoryId?: string): void {
    if (categoryId === undefined) {
      for (const [id, generation] of this.generations) this.generations.set(id, generation + 1)
      this.cache.clear()
      return
    }
    this.generations.set(categoryId, this.generationOf(categoryId) + 1)
    this.cache.delete(categoryId)
  }

  private async runScan(category: RuntimeCategory, signal?: AbortSignal): Promise<ScanResult> {
    for (;;) {
      const generation = this.generationOf(category.id)
      const startedAt = Date.now()
      const walked = await this.walkRoot(category, signal)
      // A walk that finished after an invalidation is holding pre-invalidation contents; caching it
      // under a fresh timestamp is how a renamed project stayed listed for another half minute.
      if (this.generationOf(category.id) !== generation) continue
      if (walked.result.available && !walked.cutShort)
        this.cache.set(category.id, { result: walked.result, builtAt: startedAt, generation })
      return walked.result
    }
  }

  private generationOf(categoryId: string): number {
    const generation = this.generations.get(categoryId)
    if (generation !== undefined) return generation
    this.generations.set(categoryId, 0)
    return 0
  }

  private async walkRoot(
    category: RuntimeCategory,
    signal?: AbortSignal,
  ): Promise<{ result: ScanResult; cutShort: boolean }> {
    const deadline = Date.now() + ProjectScanner.timeoutMillisecondsConst
    const root = await ProjectScanner.withinDeadline(this.readDirectory(category.path), deadline)
    if (!root.done)
      return { result: { entries: [], truncated: true, available: true }, cutShort: true }
    // An unreachable root leaves the category listed and unavailable. V1 dropped it from the menu
    // instead, which read as "the category is gone" whenever a share was slow to mount.
    if (root.value === null)
      return { result: { entries: [], truncated: false, available: false }, cutShort: false }
    const walked = await this.walk(category, root.value, deadline, signal)
    return {
      result: { entries: walked.entries, truncated: walked.truncated, available: true },
      cutShort: walked.cutShort,
    }
  }

  private async walk(
    category: RuntimeCategory,
    rootEntries: readonly ScanDirectoryEntry[],
    deadline: number,
    signal?: AbortSignal,
  ): Promise<WalkOutcome> {
    const outcome: WalkOutcome = { entries: [], truncated: false, cutShort: false }
    for (const entry of rootEntries) {
      if (ProjectScanner.stopped(deadline, signal)) return ProjectScanner.cutShort(outcome)
      if (!ProjectScanner.isCandidate(entry.name, category)) continue
      const path = join(category.path, entry.name)
      if (!await this.isDirectory(entry, path, deadline)) continue
      if (!category.flattenFolders.has(entry.name)) {
        if (!ProjectScanner.push(outcome.entries, entry.name, path)) return ProjectScanner.capped(outcome)
        continue
      }
      const children = await ProjectScanner.withinDeadline(this.readDirectory(path), deadline)
      if (!children.done) return ProjectScanner.cutShort(outcome)
      if (children.value === null) continue
      for (const child of children.value) {
        if (ProjectScanner.stopped(deadline, signal)) return ProjectScanner.cutShort(outcome)
        if (child.name.startsWith('.')) continue
        const childPath = join(path, child.name)
        if (!await this.isDirectory(child, childPath, deadline)) continue
        if (!ProjectScanner.push(outcome.entries, `${entry.name}/${child.name}`, childPath))
          return ProjectScanner.capped(outcome)
      }
    }
    return outcome
  }

  private static isCandidate(name: string, category: RuntimeCategory): boolean {
    if (name.startsWith('.')) return false
    // Archived is the archive target of every category, so it is never a project itself.
    if (name === ProjectScanner.archivedFolderNameConst) return false
    return !category.hiddenFolders.has(name)
  }

  /** `lastActivity` belongs to the facade: the scanner never opens a provider store. */
  private static push(entries: ProjectEntry[], name: string, path: string): boolean {
    if (entries.length >= ProjectScanner.maxEntriesConst) return false
    entries.push({ name, path, lastActivity: null })
    return true
  }

  private static capped(outcome: WalkOutcome): WalkOutcome {
    outcome.truncated = true
    return outcome
  }

  private static cutShort(outcome: WalkOutcome): WalkOutcome {
    outcome.truncated = true
    outcome.cutShort = true
    return outcome
  }

  private static stopped(deadline: number, signal?: AbortSignal): boolean {
    return signal?.aborted === true || Date.now() >= deadline
  }

  private async isDirectory(
    entry: ScanDirectoryEntry,
    path: string,
    deadline: number,
  ): Promise<boolean> {
    if (!entry.isSymbolicLink()) return entry.isDirectory()
    const target = await ProjectScanner.withinDeadline(this.statDirectory(path), deadline)
    // A link whose target is gone stats as an error and is simply not a project, as in V1. A link
    // that outran the deadline is treated the same; the next loop check ends the walk anyway.
    return target.done ? target.value : false
  }

  private async readDirectory(directory: string): Promise<ScanDirectoryEntry[] | null> {
    try { return await this.fileSystem.readdir(directory) }
    catch { return null }
  }

  private async statDirectory(path: string): Promise<boolean> {
    try { return (await this.fileSystem.stat(path)).isDirectory() }
    catch { return false }
  }

  /**
   * Both callers swallow their own errors, so `work` never rejects - otherwise losing this race
   * would leave an unhandled rejection behind for every timed-out directory.
   */
  private static async withinDeadline<T>(
    work: Promise<T>,
    deadline: number,
  ): Promise<DeadlineOutcome<T>> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { done: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<DeadlineOutcome<T>>((resolve) => {
      timer = setTimeout(() => resolve({ done: false }), remaining)
    })
    try {
      return await Promise.race([work.then((value) => ({ done: true as const, value })), expiry])
    } finally {
      clearTimeout(timer)
    }
  }

  private static nodeFileSystem(): ScannerFileSystem {
    return {
      readdir: (directory) => readdir(directory, { withFileTypes: true }),
      stat: (path) => stat(path),
    }
  }
}
