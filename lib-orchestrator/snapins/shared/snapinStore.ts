import { readFile, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { JsonDocumentStore, type JsonDocumentReading } from '../../shared/jsonDocumentStore'
import { PathCompare } from '../../shared/pathCompare'
import type { SnapinStateDocument } from './snapinContract'

const time = z.number().finite().nonnegative()
const id = z.uuid()
const phase = z.enum(['pending', 'working', 'waiting', 'blocked', 'review', 'completed', 'ended'])
const attempt = z.object({
  attemptId: id, itemKey: z.string().min(1), title: z.string(), mode: z.enum(['wc', 'wt']),
  projectDirectory: z.string().min(1), agentId: z.enum(['claude', 'codex']), phase, createdAt: time,
  sessionId: z.string().min(1).optional(), createUndecided: z.literal(true).optional(), startedAt: time.optional(),
  trail: z.string().optional(), readyObservedAt: time.optional(), goneObservedAt: time.optional(),
  outcome: z.object({ kind: z.enum(['closed', 'published', 'analysis', 'blocked', 'ready']),
    waiting: z.enum(['user', 'blocked', 'deploy', 'foreign-deploy']).optional(), detail: z.string(),
    note: z.string().optional(), report: z.string().optional(), at: time }).optional(),
  appliedThrough: z.number().int().nonnegative(), attention: z.enum(['start', 'setup', 'not-published', 'worktree-kind']).optional(),
  endedReason: z.string().optional(), endedAt: time.optional(), completedAt: time.optional(),
  completion: z.object({ detail: z.string() }).optional(), resultsSettled: z.boolean().optional(),
  resultsCheckedAt: time.optional(), group: z.string(), leaseHeld: z.boolean(), leaseFrom: id.optional(),
  presentedPhase: phase.optional(), presentationRetryAt: time.optional(), evidenceCheckedAt: time.optional(),
}).refine((value) => value.mode === 'wc' || !value.leaseHeld)
const document = z.object({
  schemaVersion: z.literal(1), kind: z.string().min(1), paused: z.boolean(),
  queue: z.array(z.object({ itemKey: z.string().min(1), addedAt: time, startAnyway: z.literal(true).optional(),
    priorAttemptId: id.optional(), inheritsLeaseFrom: id.optional(),
    setupAgreement: z.object({ hash: z.string().min(1), commands: z.array(z.string()) }).optional(),
    acknowledgeSetup: z.string().optional() })),
  attempts: z.array(attempt),
}).refine((value) => new Set(value.attempts.map((a) => a.attemptId)).size === value.attempts.length
  && new Set(value.queue.map((entry) => entry.itemKey)).size === value.queue.length
  && new Set(value.attempts.filter((a) => a.leaseHeld).map((a) => a.itemKey)).size
    === value.attempts.filter((a) => a.leaseHeld).length)

export class SnapinStore extends JsonDocumentStore<SnapinStateDocument> {
  private readonly directory: string
  private readonly kind: string
  private readonly now: () => number
  private cached: SnapinStateDocument
  private loading: Promise<void> | null
  private writes: Promise<unknown>
  private failure: string | null

  constructor(directory: string, kind: string, deps: { now: () => number; report: (message: string) => void }) {
    super(join(directory, 'state.json'), deps.report)
    this.directory = directory
    this.kind = kind
    this.now = deps.now
    this.cached = this.emptyDocument()
    this.loading = null
    this.writes = Promise.resolve()
    this.failure = null
  }

  get current(): SnapinStateDocument { return structuredClone(this.cached) }
  protected get subject(): string { return `Snap-in ${this.kind}` }
  protected get refusalConsequence(): string { return 'no snap-in passes will be admitted' }
  protected get readFailureConsequence(): string { return this.refusalConsequence }
  protected emptyDocument(): SnapinStateDocument {
    return { schemaVersion: 1, kind: this.kind, paused: false, queue: [], attempts: [] }
  }
  protected coerce(parsed: unknown): JsonDocumentReading<SnapinStateDocument> {
    const result = document.parse(parsed)
    if (result.kind !== this.kind) throw new Error('State belongs to another snap-in')
    return { document: result, damaged: false }
  }
  protected writeFailureMessage(detail: string): string { return `${this.subject} could not save state: ${detail}` }

  async read(): Promise<{ ok: true; document: SnapinStateDocument } | { ok: false; latched: string }> {
    this.loading ??= this.load()
    await this.loading
    return this.latched ? { ok: false, latched: this.failure! } : { ok: true, document: this.current }
  }

  update(change: (doc: SnapinStateDocument) => SnapinStateDocument): Promise<boolean> {
    const next = this.writes.then(async () => {
      await this.read()
      if (!this.mayWrite()) return false
      try {
        const changed = this.coerce(change(this.current)).document
        const predecessors = new Set(changed.attempts.filter((a) => a.phase === 'pending' && a.leaseHeld && a.leaseFrom).map((a) => a.leaseFrom))
        const ended = changed.attempts.filter((a) => a.phase === 'completed' || a.phase === 'ended')
          .sort((a, b) => (b.completedAt ?? b.endedAt ?? b.createdAt) - (a.completedAt ?? a.endedAt ?? a.createdAt))
        const expired = new Set(ended.slice(200).filter((a) => !a.leaseHeld && !predecessors.has(a.attemptId)
          && a.presentationRetryAt === undefined && (a.phase !== 'completed' || (a.resultsSettled === true && a.presentedPhase === a.phase))
          && this.now() - (a.completedAt ?? a.endedAt ?? a.createdAt) > 14 * 86_400_000).map((a) => a.attemptId))
        changed.attempts = changed.attempts.filter((a) => !expired.has(a.attemptId))
        if (!await this.writeDocument(changed)) return false
        this.cached = changed
        for (const attemptId of expired) await this.removePass(attemptId)
        return true
      } catch (error) {
        this.report(this.writeFailureMessage(ErrorText.of(error)))
        return false
      }
    })
    this.writes = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<void> {
    // The shared store treats read errors as absence; snap-in leases must survive an unreadable file.
    try {
      try { await stat(this.file) }
      catch (error) {
        if (ErrnoCode.of(error) === 'ENOENT') return
        throw error
      }
      this.cached = this.coerce(JSON.parse(await readFile(this.file, 'utf8'))).document
    } catch (error) {
      this.failure = ErrorText.of(error)
      this.latchRead()
      this.report(`${this.subject} is latched: ${this.failure}`)
    }
  }

  private async removePass(attemptId: string): Promise<void> {
    try {
      const root = await realpath(join(this.directory, 'passes'))
      if (PathCompare.comparable(root) !== PathCompare.comparable(join(await realpath(this.directory), 'passes')))
        throw new Error('Passes directory redirects from its owned path')
      const owned = join(root, attemptId)
      const target = await realpath(owned)
      if (PathCompare.comparable(target) !== PathCompare.comparable(owned)) throw new Error('Pass directory redirects from its owned path')
      await rm(target, { recursive: true, force: true })
    } catch (error) {
      if (ErrnoCode.of(error) !== 'ENOENT') this.report(`Old pass ${attemptId} could not be removed: ${ErrorText.of(error)}`)
    }
  }
}
