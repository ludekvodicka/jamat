import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AtomicJsonFile } from './atomicJsonFile'
import { ErrorText } from './errorText'

/**
 * What a read made of the file: what this store now holds, and whether the file said more than it
 * could make sense of. `damaged` is the whole point - a document that came back USABLE but partial
 * is still a document a write would erase the rest of.
 */
export interface JsonDocumentReading<TDocument> {
  document: TDocument
  damaged: boolean
}

/**
 * One JSON document on disk, read leniently and never written over when it could not be read.
 *
 * **The latch is why this class exists.** Every store here had its own copy of the same five
 * behaviours - load, coerce, report once, refuse the write after a damaged read, write atomically -
 * and the latch was present in some and missing from others, which is how a workspace was lost on
 * 2026-06-11: the fallback replaced a rich document that was merely unreadable. A subclass cannot
 * forget it now, because `writeDocument` is the only writer and it checks.
 *
 * A missing file is NOT damage: it is what a machine that has recorded nothing looks like, and the
 * first write creates it. Only a file that exists and cannot be understood latches.
 *
 * Sync and async reads are both here because the callers differ and neither is wrong: a store loaded
 * during boot awaits, and one whose `load` is synchronous by contract does not. They share one
 * interpretation, so the two paths cannot come to different conclusions about the same bytes.
 */
export abstract class JsonDocumentStore<TDocument> {
  private damagedRead = false
  private refusalReported = false

  protected constructor(
    protected readonly file: string,
    protected readonly report: (message: string) => void,
  ) {}

  /** True once a damaged file was read: nothing is written for the rest of this process. */
  get latched(): boolean {
    return this.damagedRead
  }

  /** What this store is, in the words it says to a person: `Session records`, `Session numbers`. */
  protected abstract get subject(): string

  /** What a person will notice for the rest of the session, said after the refusal to write. */
  protected abstract get refusalConsequence(): string

  /**
   * The same fact from the other end, said once when the damage is FOUND rather than when a write
   * hits the latch. Separate because the two sentences land at different moments and a store words
   * them differently: "starting from none" reads at boot, and "for the rest of this session" reads
   * over an operation somebody just asked for.
   */
  protected abstract get readFailureConsequence(): string

  /** What this store holds before anything was ever written. */
  protected abstract emptyDocument(): TDocument

  /**
   * The parsed JSON as this store's document. THROW for a document that cannot be used at all; the
   * throw is read as damage, exactly like `damaged: true`, and the empty document is used instead.
   */
  protected abstract coerce(parsed: unknown): JsonDocumentReading<TDocument>

  /** What is said when a write could not land. The consequence differs per store, so it is asked. */
  protected abstract writeFailureMessage(detail: string): string

  protected async readDocument(): Promise<TDocument> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return this.emptyDocument()
    }
    return this.interpret(raw)
  }

  protected readDocumentSync(): TDocument {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf-8')
    } catch {
      return this.emptyDocument()
    }
    return this.interpret(raw)
  }

  /**
   * The only writer. `false` means the file was left exactly as this call found it, for all three
   * reasons that can be true of: the read latched, the write threw, or `before` refused.
   *
   * `before` is for a store that must do something first and abandon the write if it fails -
   * `SessionRecordsStore` takes a recovery point ahead of a destructive write, and a destructive
   * write with no undo behind it is refused rather than made.
   */
  protected async writeDocument(
    document: unknown,
    before?: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!this.mayWrite()) return false
    try {
      AtomicJsonFile.ensureDirectory(dirname(this.file))
      if (before && !await before()) return false
      AtomicJsonFile.write(this.file, document)
    } catch (error) {
      this.report(this.writeFailureMessage(ErrorText.of(error)))
      return false
    }
    return true
  }

  /** The same write for a store whose own surface is synchronous. */
  protected writeDocumentSync(document: unknown): boolean {
    if (!this.mayWrite()) return false
    try {
      AtomicJsonFile.ensureDirectory(dirname(this.file))
      AtomicJsonFile.write(this.file, document)
    } catch (error) {
      this.report(this.writeFailureMessage(ErrorText.of(error)))
      return false
    }
    return true
  }

  /**
   * Read as damage from wherever a store learns of it. `coerce` is the usual place; a store that
   * discovers mid-read that the file says more than it can hold calls this itself.
   */
  protected latchRead(): void {
    this.damagedRead = true
  }

  /**
   * Whether a write may go ahead, and the refusal said ONCE when it may not - a latched file would
   * otherwise repeat the line on every tick that tries.
   *
   * Both writers below call it, and so does a store that declines a write it never attempts: a
   * question whose answer would have to be recorded refuses for the same reason and with the same
   * sentence, and asking here is what keeps the two from each saying it.
   */
  protected mayWrite(): boolean {
    if (!this.damagedRead) return true
    if (!this.refusalReported) {
      this.refusalReported = true
      this.report(`${this.subject} at ${this.file} were unreadable; ${this.refusalConsequence}`)
    }
    return false
  }

  private interpret(raw: string): TDocument {
    try {
      const reading = this.coerce(JSON.parse(raw))
      if (reading.damaged) this.latchRead()
      return reading.document
    } catch (error) {
      this.latchRead()
      this.report(`${this.subject} at ${this.file} are unreadable (${ErrorText.of(error)}); `
        + this.readFailureConsequence)
      return this.emptyDocument()
    }
  }
}
