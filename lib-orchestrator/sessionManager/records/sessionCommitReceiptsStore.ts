import { JsonShape } from '../../shared/jsonShape'
import { JsonDocumentStore, type JsonDocumentReading } from '../../shared/jsonDocumentStore'
import type { SessionRecordCommitReceipt } from './sessionRecord.types'

interface SessionCommitReceiptsDocument {
  schemaVersion: 1
  savedAt: number
  receipts: Record<string, SessionRecordCommitReceipt[]>
}

/**
 * Commit receipts kept beside `session-records.json` so high-frequency session writes
 * (`flushUserInput`, status ticks) do not rewrite hundreds of kilobytes of historical commit paths.
 */
export class SessionCommitReceiptsStore extends JsonDocumentStore<Map<string, SessionRecordCommitReceipt[]>> {
  private receipts = new Map<string, SessionRecordCommitReceipt[]>()
  private writes: Promise<unknown> = Promise.resolve()

  private constructor(file: string, report: (message: string) => void) {
    super(file, report)
  }

  /** `session-records.json` keeps its commit receipts beside it as `session-records-commit-receipts.json`. */
  static fileOf(recordsFile: string): string {
    return `${recordsFile.replace(/\.json$/i, '')}-commit-receipts.json`
  }

  static async load(file: string, report: (message: string) => void): Promise<SessionCommitReceiptsStore> {
    const store = new SessionCommitReceiptsStore(file, report)
    store.receipts = await store.readDocument()
    return store
  }

  get(sessionId: string): SessionRecordCommitReceipt[] | undefined {
    return this.receipts.get(sessionId)
  }

  /** Writes only when the receipts map differs from what is already on disk. */
  async sync(next: ReadonlyMap<string, SessionRecordCommitReceipt[]>): Promise<boolean> {
    const run = this.writes.then(async () => {
      if (SessionCommitReceiptsStore.sameMap(this.receipts, next)) return true
      const cloned = new Map<string, SessionRecordCommitReceipt[]>()
      for (const [sessionId, list] of next)
        if (list.length > 0) cloned.set(sessionId, structuredClone(list))
      const document: SessionCommitReceiptsDocument = {
        schemaVersion: 1,
        savedAt: Date.now(),
        receipts: Object.fromEntries(cloned),
      }
      if (!await this.writeDocument(document, undefined, true)) return false
      this.receipts = cloned
      return true
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  protected get subject(): string {
    return 'Session commit receipts'
  }

  protected get refusalConsequence(): string {
    return 'commit receipts cannot be saved until the file is repaired'
  }

  protected get readFailureConsequence(): string {
    return 'saved commit receipts could not be restored'
  }

  protected emptyDocument(): Map<string, SessionRecordCommitReceipt[]> {
    return new Map()
  }

  protected writeFailureMessage(detail: string): string {
    return `Session commit receipts at ${this.file} could not be written (${detail}); the file is left as it was`
  }

  protected coerce(parsed: unknown): JsonDocumentReading<Map<string, SessionRecordCommitReceipt[]>> {
    const document = JsonShape.record(parsed)
    if (document === null) throw new Error('expected an object')
    if (document.schemaVersion !== 1)
      throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
    const raw = JsonShape.record(document.receipts)
    if (raw === null) throw new Error('receipts must be an object')
    const receipts = new Map<string, SessionRecordCommitReceipt[]>()
    for (const [sessionId, value] of Object.entries(raw)) {
      if (!sessionId.trim()) continue
      if (!Array.isArray(value)) {
        this.report(`Session commit receipts at ${this.file}: dropping receipts for "${sessionId}" (must be an array)`)
        continue
      }
      const valid: SessionRecordCommitReceipt[] = []
      for (const entry of value)
        if (SessionCommitReceiptsStore.isValidReceipt(entry)) valid.push(entry)
        else this.report(`Session commit receipts at ${this.file}: dropping an unreadable receipt for "${sessionId}"`)
      if (valid.length > 0) receipts.set(sessionId, valid)
    }
    return { document: receipts, damaged: false }
  }

  private static isValidReceipt(value: unknown): value is SessionRecordCommitReceipt {
    const receipt = JsonShape.record(value)
    if (receipt === null) return false
    if (typeof receipt.scopeRoot !== 'string' || receipt.scopeRoot.trim().length === 0) return false
    if (receipt.revision !== null && (typeof receipt.revision !== 'number'
      || !Number.isSafeInteger(receipt.revision) || receipt.revision <= 0)) return false
    if (!Array.isArray(receipt.paths) || !receipt.paths.every((item) => typeof item === 'string')) return false
    return typeof receipt.at === 'number' && Number.isFinite(receipt.at)
  }

  private static sameMap(
    left: ReadonlyMap<string, SessionRecordCommitReceipt[]>,
    right: ReadonlyMap<string, SessionRecordCommitReceipt[]>,
  ): boolean {
    if (left.size !== right.size) return false
    for (const [sessionId, leftList] of left) {
      const rightList = right.get(sessionId)
      if (rightList === undefined) return false
      if (leftList === rightList) continue
      if (leftList.length !== rightList.length || JSON.stringify(leftList) !== JSON.stringify(rightList))
        return false
    }
    return true
  }
}
