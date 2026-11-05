import { JsonDocumentStore, type JsonDocumentReading } from '../../shared/jsonDocumentStore'
import type { SessionRecord } from './sessionRecord.types'

interface SessionRecordsArchiveDocument {
  schemaVersion: 1
  savedAt: number
  records: SessionRecord[]
}

/**
 * Ended sessions older than a week, out of the records file every change rewrites.
 *
 * They are still read: Historic sessions lists them, token usage attributes their transcripts, the
 * session numbers count their titles, and Reopen, Restart or Fork moves one back first. Nothing writes
 * them in place, so the file is written only when records move in or out. The records store owns the
 * move and its order (this file first, then the records file with a recovery point); a record found in
 * both keeps its active copy. An older Jamat reads only the records file and sees fewer ended rows.
 */
export class SessionRecordsArchive extends JsonDocumentStore<Map<string, SessionRecord>> {
  static readonly ageMillisecondsConst = 7 * 24 * 60 * 60 * 1000
  private records = new Map<string, SessionRecord>()
  private values: readonly SessionRecord[] = []
  private writes: Promise<unknown> = Promise.resolve()

  private constructor(file: string, report: (message: string) => void) {
    super(file, report)
  }

  /** `session-records.json` keeps its archive beside it as `session-records-archive.json`. */
  static fileOf(recordsFile: string): string {
    return `${recordsFile.replace(/\.json$/i, '')}-archive.json`
  }

  static async load(file: string, report: (message: string) => void): Promise<SessionRecordsArchive> {
    const archive = new SessionRecordsArchive(file, report)
    archive.set(await archive.readDocument())
    return archive
  }

  /**
   * Whether an ended record may leave the records file: ended a week ago, and nothing that runs can
   * still reach it - no worktree, action, merge or setup on it, a worktree lifecycle that is over, and
   * no other record naming it as parent or script parent. Whether a landed row still waits for its
   * UPDATE is the worktrees module's question; the caller adds it.
   */
  static eligible(record: SessionRecord, now: number, referenced: ReadonlySet<string>): boolean {
    if (record.life !== 'ended') return false
    if (record.endedAt === undefined || now - record.endedAt < SessionRecordsArchive.ageMillisecondsConst) return false
    if (record.scriptOf !== undefined || referenced.has(record.sessionId)) return false
    if (record.worktree !== undefined || record.svnAction !== undefined || record.worktreeMerge !== undefined
      || record.pendingSetup !== undefined || record.worktreeFinish !== undefined || record.worktreeCleanup !== undefined) return false
    const phase = record.worktreeLifecycle?.phase
    return phase === undefined || phase === 'landed' || phase === 'kept' || phase === 'removed'
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId)
  }

  list(): readonly SessionRecord[] {
    return this.values
  }

  /** Adds or replaces records. Answers whether the file now holds them. */
  async add(records: readonly SessionRecord[]): Promise<boolean> {
    return this.inTurn(() => {
      const next = new Map(this.records)
      for (const record of records) next.set(record.sessionId, record)
      return next
    })
  }

  /** Removes records. Answers whether the file no longer holds them. */
  async drop(sessionIds: readonly string[]): Promise<boolean> {
    return this.inTurn(() => {
      if (!sessionIds.some((id) => this.records.has(id))) return null
      const next = new Map(this.records)
      for (const id of sessionIds) next.delete(id)
      return next
    })
  }

  protected get subject(): string {
    return 'Archived session records'
  }

  protected get refusalConsequence(): string {
    return 'no ended session is archived or restored for the rest of this session'
  }

  protected get readFailureConsequence(): string {
    return 'archived sessions are not listed'
  }

  protected emptyDocument(): Map<string, SessionRecord> {
    return new Map()
  }

  protected writeFailureMessage(detail: string): string {
    return `Archived session records at ${this.file} could not be written (${detail}); the file is left as it was`
  }

  /** Records were valid when they moved in; one without a session id is dropped aloud. */
  protected coerce(parsed: unknown): JsonDocumentReading<Map<string, SessionRecord>> {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object')
    const document = parsed as Partial<SessionRecordsArchiveDocument>
    if (document.schemaVersion !== 1) throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
    if (!Array.isArray(document.records)) throw new Error('records must be an array')
    const records = new Map<string, SessionRecord>()
    for (const record of document.records) {
      if (!record || typeof record !== 'object' || typeof record.sessionId !== 'string' || record.sessionId === '' || records.has(record.sessionId)) {
        this.report(`Archived session records at ${this.file}: dropping a record without a usable session id`)
        continue
      }
      records.set(record.sessionId, record)
    }
    return { document: records, damaged: false }
  }

  private async inTurn(change: () => Map<string, SessionRecord> | null): Promise<boolean> {
    const run = this.writes.then(async () => {
      const next = change()
      if (next === null) return true
      const document: SessionRecordsArchiveDocument = { schemaVersion: 1, savedAt: Date.now(), records: [...next.values()] }
      if (!await this.writeDocument(document, undefined, true)) return false
      this.set(next)
      return true
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  private set(records: Map<string, SessionRecord>): void {
    this.records = records
    this.values = [...records.values()]
  }
}
