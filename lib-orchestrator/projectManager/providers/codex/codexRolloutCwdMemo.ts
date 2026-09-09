import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { AtomicJsonFile } from '../../../shared/atomicJsonFile'
import { ErrorText } from '../../../shared/errorText'
import { PathCompare } from '../../../shared/pathCompare'

/**
 * What a remembered answer is only true for. Codex appends to a rollout and this library rewrites its
 * header in place, and either one moves one of these two numbers.
 */
export interface RolloutStamp {
  mtimeMs: number
  size: number
}

interface MemoEntry extends RolloutStamp {
  cwd: string
}

interface MemoDocument {
  schemaVersion: 2
  /** The store these keys are relative to. A memo built over another one is discarded, not merged. */
  sessionsRoot: string
  cwdByFile: Record<string, MemoEntry>
}

/**
 * Which project directory each Codex rollout was written for, remembered across runs.
 *
 * This exists because enumerating a project's whole history means opening every rollout in the
 * store to read its header: 25 371 files and nine and a half seconds on one real machine, paid
 * again by every rename, move, archive and delete. Remembering the answers turns that walk into a
 * directory listing plus whatever is new.
 *
 * **An entry is only true for the bytes it was read from, so it carries that file's stamp.** Codex
 * only ever appends, but this library rewrites the recorded `cwd` in place: the history migrator when
 * a project moves, and the startup sweep afterwards for whatever that migration left locked. Neither
 * has to announce itself - a mtime or a size that moved is a miss and the header is read again -
 * which is what keeps a second writer, or a rewrite loop that threw half way, from leaving an answer
 * nobody ever comes back to. `forget` and `forgetFile` remain the shortcut for the caller that
 * already knows, and cost the next walk one less read.
 *
 * This is a cache and never a record. An unreadable file is an empty memo and one reported line; the
 * walk then does exactly what it did before this class existed.
 */
export class CodexRolloutCwdMemo {
  private entries: Map<string, MemoEntry> | null = null
  private dirty = false
  private saveFailed = false
  /**
   * Resolved once. `keyOf` runs three times per rollout and a heavy store holds 25 000 of them, so
   * re-deriving this invariant inside it was most of what the memo still cost.
   */
  private readonly comparableRoot: string

  constructor(
    private readonly file: string,
    private readonly sessionsRoot: string,
    private readonly report: (message: string) => void,
  ) {
    this.comparableRoot = PathCompare.comparable(sessionsRoot)
  }

  get(file: string, stamp: RolloutStamp): string | null {
    const entry = this.current().get(this.keyOf(file))
    if (!entry) return null
    if (entry.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) return null
    return entry.cwd
  }

  set(file: string, cwd: string, stamp: RolloutStamp): void {
    const key = this.keyOf(file)
    const entries = this.current()
    const existing = entries.get(key)
    if (existing
      && existing.cwd === cwd
      && existing.mtimeMs === stamp.mtimeMs
      && existing.size === stamp.size) return
    entries.set(key, { cwd, mtimeMs: stamp.mtimeMs, size: stamp.size })
    this.dirty = true
  }

  /**
   * Every rollout whose remembered directory the caller just rewrote. The predicate belongs to the
   * caller because how a Codex path is spelled is the index's rule, not this store's.
   */
  forget(matches: (cwd: string) => boolean): void {
    const entries = this.current()
    for (const [key, entry] of entries)
      if (matches(entry.cwd)) {
        entries.delete(key)
        this.dirty = true
      }
  }

  /** One rollout, for the caller that rewrites them one at a time: the startup sweep. */
  forgetFile(file: string): void {
    if (this.current().delete(this.keyOf(file)))
      this.dirty = true
  }

  /**
   * Only a walk that saw the whole store may say what is gone. The windowed walk sees ninety days of
   * it, and pruning from that would throw away every older rollout on each listing - which is the
   * exact set the unbounded walk exists to still find.
   */
  prune(seenFiles: Iterable<string>): void {
    const seen = new Set<string>()
    for (const file of seenFiles) seen.add(this.keyOf(file))
    const entries = this.current()
    for (const key of entries.keys())
      if (!seen.has(key)) {
        entries.delete(key)
        this.dirty = true
      }
  }

  /** Writing megabytes back when nothing changed would make every listing an I/O of its own. */
  save(): void {
    if (!this.dirty || this.saveFailed) return
    const document: MemoDocument = {
      schemaVersion: 2,
      sessionsRoot: PathCompare.normalized(this.sessionsRoot),
      cwdByFile: Object.fromEntries(this.current()),
    }
    try {
      AtomicJsonFile.ensureDirectory(dirname(this.file))
      AtomicJsonFile.write(this.file, document)
      this.dirty = false
    } catch (error) {
      // Latched, the way the leftovers store latches its own: a state directory that refuses one
      // write refuses the next, and every later walk would re-serialise the whole document only to
      // say this again. A cache that cannot be written costs the next run its speed and nothing else.
      this.saveFailed = true
      this.report(
        `Codex rollout memo at ${this.file} could not be written (${ErrorText.of(error)}); `
        + 'nothing more is written for the rest of this session',
      )
    }
  }

  /**
   * Relative to the store and forward-slashed: the keys are shorter, and a memo that names its own
   * root can be recognised as belonging to a different store instead of answering for it.
   */
  private keyOf(file: string): string {
    const path = PathCompare.comparable(file)
    return path.startsWith(`${this.comparableRoot}/`)
      ? path.slice(this.comparableRoot.length + 1)
      : path
  }

  private current(): Map<string, MemoEntry> {
    if (!this.entries)
      this.entries = this.read()
    return this.entries
  }

  private read(): Map<string, MemoEntry> {
    if (!existsSync(this.file)) return new Map()
    try {
      return this.coerce(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      this.report(
        `Codex rollout memo at ${this.file} is unreadable (${ErrorText.of(error)}); `
        + 'reading the rollout headers again',
      )
      return new Map()
    }
  }

  private coerce(parsed: unknown): Map<string, MemoEntry> {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected an object')
    // Read as unknown fields and narrowed one by one: a document off the disk is whatever somebody
    // wrote there, and typing it as the shape it is being checked FOR is the check answering itself.
    const document = parsed as Record<string, unknown>
    // Version 1 held a bare cwd with nothing to check it against, which is exactly the answer this
    // class must no longer trust; such a document is discarded rather than carried forward.
    if (document.schemaVersion !== 2)
      throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
    const sessionsRoot = document.sessionsRoot
    // A memo built over another store answers for files this one does not have. Recognising that is
    // cheaper and more honest than trusting that two stores never name the same relative path.
    if (typeof sessionsRoot !== 'string'
      || PathCompare.comparable(sessionsRoot) !== PathCompare.comparable(this.sessionsRoot))
      throw new Error(`built over ${JSON.stringify(sessionsRoot)}`)
    const cwdByFile = document.cwdByFile
    if (!cwdByFile || typeof cwdByFile !== 'object')
      throw new Error('cwdByFile must be an object')
    const entries = new Map<string, MemoEntry>()
    for (const [key, value] of Object.entries(cwdByFile as Record<string, unknown>)) {
      const entry = CodexRolloutCwdMemo.entryOf(value)
      if (entry) entries.set(key, entry)
    }
    return entries
  }

  private static entryOf(value: unknown): MemoEntry | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const { cwd, mtimeMs, size } = value as Record<string, unknown>
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    if (!CodexRolloutCwdMemo.isFiniteNumber(mtimeMs)
      || !CodexRolloutCwdMemo.isFiniteNumber(size)) return null
    return { cwd, mtimeMs, size }
  }

  private static isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
  }
}
