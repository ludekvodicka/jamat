import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JsonDocumentStore, type JsonDocumentReading } from '../../../lib-orchestrator/shared/jsonDocumentStore'
import { sessionOpenSchema, type SessionOpen, type SessionOpenPage, type SessionOpenCursor } from '../../shared/sessionViewItems'

const schema = z.strictObject({ version: z.literal(1), epoch: z.string().min(1), revision: z.number().int().nonnegative(), items: z.array(sessionOpenSchema), receipts: z.record(z.string(), z.strictObject({ sequence: z.number().int().positive(), digest: z.string().length(64) })) })
type Catalog = z.infer<typeof schema>

export class SessionViewItemsStore extends JsonDocumentStore<Catalog> {
  private catalog: Catalog
  private turn: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(sessionId: string) => void>()

  constructor(file: string, report: (message: string) => void) {
    super(file, report)
    this.catalog = this.readDocumentSync()
  }

  protected get subject(): string { return 'Shared session opens' }
  protected get refusalConsequence(): string { return 'shared opens cannot be saved until the catalog is repaired' }
  protected get readFailureConsequence(): string { return 'earlier shared opens cannot be restored' }
  protected writeFailureMessage(detail: string): string { return `Could not save shared session opens: ${detail}` }
  protected emptyDocument(): Catalog { return { version: 1, epoch: randomUUID(), revision: 0, items: [], receipts: {} } }
  protected coerce(value: unknown): JsonDocumentReading<Catalog> {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return { document: this.emptyDocument(), damaged: true }
    const ids = new Set<string>()
    let previous = 0
    for (const item of parsed.data.items) {
      if (ids.has(item.openId) || item.sequence <= previous || item.sequence > parsed.data.revision)
        return { document: this.emptyDocument(), damaged: true }
      ids.add(item.openId)
      previous = item.sequence
    }
    return { document: parsed.data, damaged: false }
  }

  subscribe(listener: (sessionId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  record(open: Omit<SessionOpen, 'sequence'>): Promise<SessionOpen> {
    const run = this.turn.then(async () => {
      const candidate = sessionOpenSchema.parse({ ...open, sequence: this.catalog.revision + 1 })
      const digest = createHash('sha256').update(JSON.stringify({ ...candidate, sequence: undefined })).digest('hex')
      const receipt = this.catalog.receipts[open.openId]
      if (receipt) {
        if (receipt.digest !== digest) throw new Error('An open ID cannot describe another intent')
        return { ...candidate, sequence: receipt.sequence }
      }
      if (Object.keys(this.catalog.receipts).length >= 65536) throw new Error('Shared open receipt capacity reached')
      const item = candidate
      if (Buffer.byteLength(JSON.stringify(item), 'utf8') > 96 * 1024) throw new Error('Shared open reference is too large')
      const items = [...this.catalog.items, item]
      const ordinary = items.filter((entry) => entry.sessionId === item.sessionId && entry.item.kind !== 'review')
      const dropped = new Set(ordinary.slice(0, Math.max(0, ordinary.length - 512)).map((entry) => entry.openId))
      const next = { ...this.catalog, revision: item.sequence, items: items.filter((entry) => !dropped.has(entry.openId)), receipts: { ...this.catalog.receipts, [item.openId]: { sequence: item.sequence, digest } } }
      if (!await this.writeDocument(next)) throw new Error('Shared open could not be persisted')
      this.catalog = next
      for (const listener of this.listeners) {
        try { listener(item.sessionId) } catch (error) { this.report(String(error)) }
      }
      return item
    })
    this.turn = run.catch(() => {})
    return run
  }

  page(sessionId: string, cursor: SessionOpenCursor): SessionOpenPage {
    if (cursor.epoch !== undefined && cursor.epoch !== this.catalog.epoch) throw new Error('Shared catalog was replaced')
    const revision = cursor.revision ?? this.catalog.revision
    if (!Number.isSafeInteger(cursor.after) || cursor.after < 0 || revision > this.catalog.revision || cursor.after > revision)
      throw new Error('Invalid shared catalog cursor')
    const candidates = this.catalog.items.filter((item) => item.sessionId === sessionId && item.sequence > cursor.after && item.sequence <= revision)
    const items: SessionOpen[] = []
    let bytes = 0
    for (const item of candidates) {
      const length = Buffer.byteLength(JSON.stringify(item), 'utf8')
      if (items.length >= 64 || bytes + length > 128 * 1024) break
      items.push(item)
      bytes += length
    }
    return { epoch: this.catalog.epoch, revision, after: cursor.after, items,
      next: items.length < candidates.length ? items.at(-1)!.sequence : null }
  }
}
