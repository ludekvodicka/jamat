import { z } from 'zod'
import { RemoteReviewSchemas } from '../../../lib-orchestrator/remoteControl/remoteReviewSchemas'

import { JsonDocumentStore, type JsonDocumentReading } from '../../../lib-orchestrator/shared/jsonDocumentStore'
import type { VersioningCommitDraftDto, VersioningCommitRunResult } from '../../../lib-orchestrator/versioning/versioningCommit'

import { versioningReviewSchema, decisionResult } from '../../../lib-orchestrator/versioning/versioningReviewSchemas'
const literal = z.string().min(1).max(32_768)

const recordSchema = z.object({
  decisions: z.array(z.object({ operationId: literal, actorId: literal, payload: z.string().refine((value) => {
    try { return RemoteReviewSchemas.decision.safeParse(JSON.parse(value)).success } catch { return false }
  }, 'The saved decision is unreadable'), acceptedAt: z.number(), result: decisionResult.optional() }).strict()).optional(),
  dto: versioningReviewSchema.omit({ epoch: true }), cwd: literal, lockRoot: literal,
  targets: z.array(z.object({ path: literal, directory: z.boolean(), recursive: z.boolean(), checked: z.literal(false).optional() }).strict()).max(5_000).optional(),
  committedPaths: z.array(literal).optional(), externalReview: z.enum(['running', 'closed']).optional(),
  rejectedSnapshotId: literal.optional(), closedAt: z.number().optional(), failure: z.string().max(8_388_608).optional(),
  wake: z.union([z.object({ state: z.literal('watching') }).strict(), z.object({
    state: z.enum(['pending', 'delivered', 'expired']), text: literal, at: z.number(), attempts: z.number().int().min(0),
  }).strict()]).optional(),
}).strict()

/**
 * The close line of a review the CLI opened: `watching` until the review ends the way a CLI waiter
 * ends on it, then the line typed once into the review's session.
 */
export type VersioningReviewWake =
  | { state: 'watching' }
  | { state: 'pending' | 'delivered' | 'expired'; text: string; at: number; attempts: number }

export interface VersioningReviewRecord {
  decisions?: { operationId: string; actorId: string; payload: string; acceptedAt: number; result?: VersioningCommitRunResult }[]
  dto: VersioningCommitDraftDto
  cwd: string
  lockRoot: string
  targets?: readonly { path: string; directory: boolean; recursive: boolean; checked?: false }[]
  committedPaths?: readonly string[]
  externalReview?: 'running' | 'closed'
  rejectedSnapshotId?: string
  closedAt?: number
  wake?: VersioningReviewWake
  /** Why a Finish approval failed on this computer, kept beside the Finish's own summary. */
  failure?: string
}

interface ReviewDocument { version: 1; reviews: VersioningReviewRecord[] }

/**
 * Every draft edit saves all reviews (98 on 2026-11-25, 3.4 MB) synchronously on the orchestrator's
 * main thread. A record whose JSON did not change since the last save is not validated again (its
 * decisions each parse a nested schema), and the file is written without indentation: only this
 * process reads it.
 */
export class VersioningReviewStore extends JsonDocumentStore<ReviewDocument> {
  private document: ReviewDocument
  private validated: Map<string, { text: string; record: VersioningReviewRecord }>
  private lastOrder: string[] | null

  constructor(file: string, report: (message: string) => void) {
    super(file, report)
    this.document = this.readDocumentSync()
    this.validated = new Map()
    this.lastOrder = null
  }

  read(): readonly VersioningReviewRecord[] {
    return this.document.reviews.map((review) => {
      const cloned = structuredClone(review)
      if (cloned.committedPaths === undefined && cloned.dto.phase.kind === 'done'
        && cloned.dto.vcs === 'svn' && cloned.dto.published !== undefined)
        cloned.committedPaths = [...new Set(cloned.dto.published.flatMap((item) => item.paths ?? []))]
      return cloned
    })
  }

  save(reviews: readonly VersioningReviewRecord[]): boolean {
    const validated = new Map<string, { text: string; record: VersioningReviewRecord }>()
    const order: string[] = []
    let unchanged = this.lastOrder !== null && reviews.length === this.lastOrder.length
    const records = reviews.map((review, index) => {
      const input = { ...review, dto: Object.fromEntries(Object.entries(review.dto).filter(([key]) => key !== 'epoch')) }
      const text = JSON.stringify(input)
      const known = this.validated.get(review.dto.draftId)
      const same = known?.text === text
      if (!same || this.lastOrder?.[index] !== review.dto.draftId) unchanged = false
      const record = same ? known.record : recordSchema.parse(input) as VersioningReviewRecord
      validated.set(review.dto.draftId, { text, record })
      order.push(review.dto.draftId)
      return record
    })
    if (unchanged) return true
    const document = { version: 1 as const, reviews: records }
    if (!this.writeDocumentSync(document, true)) return false
    this.document = document
    this.validated = validated
    this.lastOrder = order
    return true
  }

  protected get subject(): string { return 'Commit reviews' }
  protected get refusalConsequence(): string { return 'commit reviews cannot be saved until the file is repaired' }
  protected get readFailureConsequence(): string { return 'saved commit reviews could not be restored' }
  protected emptyDocument(): ReviewDocument { return { version: 1, reviews: [] } }
  protected writeFailureMessage(detail: string): string { return `Commit reviews could not be saved: ${detail}` }
  protected coerce(parsed: unknown): JsonDocumentReading<ReviewDocument> {
    return { document: z.object({ version: z.literal(1), reviews: z.array(recordSchema) }).strict().parse(parsed), damaged: false }
  }
}
