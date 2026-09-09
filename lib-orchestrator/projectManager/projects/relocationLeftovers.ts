import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { LeftoverEntry, RelocationLeftoversWriter } from '../providers/providerContract.types'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrorText } from '../../shared/errorText'

interface LeftoversDocument {
  schemaVersion: 1
  entries: LeftoverEntry[]
}

/**
 * What a relocation could not finish with: an old copy still to delete, or a transcript still to
 * rewrite. These records outlive the operation that made them - its journal is removed the moment it
 * ends, whether or not anything was left behind, and the startup sweep retries this list instead.
 *
 * The store rules are the catalog's: coerce on read so one damaged record cannot cost the others,
 * validate on write so a bad record is refused instead of stored, and never overwrite a file that
 * failed to read. Order is preserved and nothing is merged: two relocations of the same file leave
 * two records, and replaying only the newer one would skip a rewrite that never happened.
 */
export class RelocationLeftovers implements RelocationLeftoversWriter {
  private list: LeftoverEntry[] | null = null
  /**
   * What the latch refused to store. The file it names is already on disk, so dropping the record
   * outright would leave a copy nothing ever comes back to; held here, this process's own sweep
   * still gets one attempt at it.
   */
  private unstored: LeftoverEntry[] = []
  private readFailed = false
  private refusalReported = false

  constructor(
    private readonly file: string,
    private readonly report: (message: string) => void,
  ) {}

  /** False when the latch refused it: the caller has a leftover it must report some other way. */
  record(entry: LeftoverEntry): boolean {
    const problem = RelocationLeftovers.entryProblem(entry)
    if (problem)
      throw new Error(`Refusing to record a relocation leftover: ${problem}`)
    const entries = this.current()
    if (this.readFailed) {
      this.reportRefusal()
      this.unstored.push(entry)
      return false
    }
    entries.push(entry)
    this.write(entries)
    return true
  }

  entries(): readonly LeftoverEntry[] {
    return [...this.current(), ...this.unstored]
  }

  /**
   * The sweep removes what it cleaned up; whatever is still locked stays for the next start.
   *
   * By identity, never by path: two relocations of the same file leave two records on purpose, and
   * removing both because one replay succeeded would skip a rewrite that never happened.
   */
  remove(entry: LeftoverEntry): void {
    this.unstored = this.unstored.filter((candidate) => !RelocationLeftovers.same(candidate, entry))
    const entries = this.current()
    if (this.readFailed) {
      this.reportRefusal()
      return
    }
    const kept = entries.filter((candidate) => !RelocationLeftovers.same(candidate, entry))
    if (kept.length === entries.length) return
    this.write(kept)
  }

  count(): number {
    return this.current().length + this.unstored.length
  }

  private static same(left: LeftoverEntry, right: LeftoverEntry): boolean {
    return left.path === right.path
      && left.operationId === right.operationId
      && left.kind === right.kind
  }

  private current(): LeftoverEntry[] {
    if (!this.list)
      this.list = this.read()
    return this.list
  }

  private read(): LeftoverEntry[] {
    if (!existsSync(this.file)) return []
    try {
      return this.coerce(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      // The damaged file is left exactly as it is: it names files of the user's that are still to be
      // cleaned up, and a store that "repairs" it by overwriting forgets them for good.
      this.readFailed = true
      this.report(
        `Relocation leftovers at ${this.file} are unreadable (${ErrorText.of(error)}); starting from an empty list`,
      )
      return []
    }
  }

  private coerce(parsed: unknown): LeftoverEntry[] {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected an object')
    const document = parsed as Partial<LeftoversDocument>
    if (document.schemaVersion !== 1)
      throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
    if (!Array.isArray(document.entries))
      throw new Error('entries must be an array')
    const entries: LeftoverEntry[] = []
    for (const candidate of document.entries) {
      const problem = RelocationLeftovers.entryProblem(candidate)
      if (problem) {
        this.report(`Relocation leftovers at ${this.file}: dropping a record (${problem})`)
        continue
      }
      entries.push(candidate)
    }
    return entries
  }

  private write(entries: LeftoverEntry[]): void {
    AtomicJsonFile.ensureDirectory(dirname(this.file))
    const document: LeftoversDocument = { schemaVersion: 1, entries }
    AtomicJsonFile.write(this.file, document)
    this.list = entries
  }

  private static entryProblem(candidate: unknown): string | null {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return 'expected an object'
    const entry = candidate as Partial<LeftoverEntry>
    if (!RelocationLeftovers.isFilledString(entry.path))
      return 'path must be a non-empty string'
    if (!RelocationLeftovers.isFilledString(entry.operationId))
      return 'operationId must be a non-empty string'
    if (typeof entry.recordedAt !== 'number' || !Number.isFinite(entry.recordedAt))
      return 'recordedAt must be a number'
    if (entry.kind === 'delete')
      return null
    else if (entry.kind === 'rewrite')
      return RelocationLeftovers.rewriteProblem(entry)
    else
      return `unknown kind ${JSON.stringify(entry.kind)}`
  }

  private static rewriteProblem(entry: Partial<Extract<LeftoverEntry, { kind: 'rewrite' }>>): string | null {
    // Without the provider the sweep cannot know whether the replay includes the encoded shape of the
    // path, and guessing it either misses a rewrite or edits text the format never held.
    if (entry.provider !== 'claude' && entry.provider !== 'codex')
      return `unknown provider ${JSON.stringify(entry.provider)}`
    if (!RelocationLeftovers.isFilledString(entry.oldPath)
      || !RelocationLeftovers.isFilledString(entry.newPath))
      return 'oldPath and newPath must be non-empty strings'
    return null
  }

  private static isFilledString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }

  /** Reported once: a latched file would otherwise repeat the same line for every locked file the
   *  operation walks past. */
  private reportRefusal(): void {
    if (this.refusalReported) return
    this.refusalReported = true
    this.report(
      `Relocation leftovers at ${this.file} were unreadable; nothing is written for the rest of this session`,
    )
  }
}
