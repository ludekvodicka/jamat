import { z } from 'zod'
import { RemoteReviewSchemas } from '../../../lib-orchestrator/remoteControl/remoteReviewSchemas'

import { JsonDocumentStore, type JsonDocumentReading } from '../../../lib-orchestrator/shared/jsonDocumentStore'
import type { VersioningCommitDraftDto, VersioningCommitRunResult } from '../../shared/versioningCommit'

import { versioningReviewSchema, decisionResult } from '../../shared/versioningReviewSchemas'
const literal = z.string().min(1).max(32_768)

const recordSchema = z.object({
  decisions: z.array(z.object({ operationId: literal, actorId: literal, payload: z.string().refine((value) => {
    try { return RemoteReviewSchemas.decision.safeParse(JSON.parse(value)).success } catch { return false }
  }, 'The saved decision is unreadable'), acceptedAt: z.number(), result: decisionResult.optional() }).strict()).optional(),
  dto: versioningReviewSchema.omit({ epoch: true }), cwd: literal, lockRoot: literal,
  targets: z.array(z.object({ path: literal, directory: z.boolean(), recursive: z.boolean() }).strict()).max(2_000).optional(),
  committedPaths: z.array(literal).optional(), externalReview: z.enum(['running', 'closed']).optional(),
  rejectedSnapshotId: literal.optional(), closedAt: z.number().optional(),
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
  targets?: readonly { path: string; directory: boolean; recursive: boolean }[]
  committedPaths?: readonly string[]
  externalReview?: 'running' | 'closed'
  rejectedSnapshotId?: string
  closedAt?: number
  wake?: VersioningReviewWake
}

interface ReviewDocument { version: 1; reviews: VersioningReviewRecord[] }

export class VersioningReviewStore extends JsonDocumentStore<ReviewDocument> {
  private document: ReviewDocument

  constructor(file: string, report: (message: string) => void) {
    super(file, report)
    this.document = this.readDocumentSync()
  }

  read(): readonly VersioningReviewRecord[] { return structuredClone(this.document.reviews) }

  save(reviews: readonly VersioningReviewRecord[]): boolean {
    const document = { version: 1 as const, reviews: reviews.map((review) => recordSchema.parse({ ...review,
      dto: Object.fromEntries(Object.entries(review.dto).filter(([key]) => key !== 'epoch')) })) }
    if (!this.writeDocumentSync(document)) return false
    this.document = document
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
