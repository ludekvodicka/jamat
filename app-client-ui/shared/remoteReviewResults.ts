import { z } from 'zod'
import type { RemoteReviewRequest } from '../../lib-orchestrator/remoteControl/remoteReviewApi.types'
import { RemoteChangesResults } from './remoteChangesResults'
import { versioningReviewSchema, decisionResult } from './versioningReviewSchemas'

const id = z.string().min(1).max(256), text = z.string().max(1_048_576)
const open = z.union([
  z.strictObject({ ok: z.literal(true), value: z.strictObject({ draftId: id, scopeRoot: text, title: text, paths: versioningReviewSchema.shape.paths }), messageApplied: z.boolean() }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['unknown-session', 'no-working-copy', 'outside-session', 'remote-session', 'message-too-long']), detail: text }),
])
const edit = z.union([z.strictObject({ ok: z.literal(true), value: versioningReviewSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['stale', 'busy', 'invalid-target', 'unknown-draft']), detail: text, current: versioningReviewSchema.optional() })])
const files = z.union([z.strictObject({ ok: z.literal(true), value: RemoteChangesResults.working, checkedPaths: z.array(text).max(2_000).optional() }), RemoteChangesResults.failure])

export class RemoteReviewResults {
  static parse(request: RemoteReviewRequest, value: unknown, sessionId?: string): unknown {
    const parsed = RemoteReviewResults.shape(request, value)
    if (sessionId !== undefined) {
      const id = request.kind === 'list' || request.kind === 'workflow' || request.kind === 'create' ? null : request.kind === 'edit' ? request.edit.draftId : request.kind === 'decide' ? request.decision.draftId : request.reviewId
      const drafts = request.kind === 'read' ? [parsed] : request.kind === 'list' ? parsed as unknown[]
        : request.kind === 'edit' ? [(parsed as { value?: unknown; current?: unknown }).value ?? (parsed as { current?: unknown }).current] : []
      for (const candidate of drafts) {
        if (candidate === null || candidate === undefined) continue
        const draft = versioningReviewSchema.parse(candidate)
        if (draft.sessionId !== sessionId || id !== null && draft.draftId !== id) throw new Error('Source returned another session or review')
      }
      if (request.kind === 'open') {
        const opened = open.parse(parsed)
        if (opened.ok && opened.value.draftId !== id) throw new Error('Source opened another review')
      } else if (request.kind === 'workflow') {
        const opened = open.parse(parsed)
        if (opened.ok && opened.value.scopeRoot !== request.scopeRoot) throw new Error('Source opened another workflow scope')
      } else if (request.kind === 'files') {
        const listing = files.parse(parsed)
        if (listing.ok && listing.value.sessionId !== sessionId) throw new Error('Review files belong to another session')
      }
    }
    return parsed
  }

  private static shape(request: RemoteReviewRequest, value: unknown): unknown {
    if (request.kind === 'open' || request.kind === 'workflow' || request.kind === 'create') return open.parse(value)
    else if (request.kind === 'read') return versioningReviewSchema.nullable().parse(value)
    else if (request.kind === 'edit') return edit.parse(value)
    else if (request.kind === 'decide') return decisionResult.parse(value)
    else if (request.kind === 'files') return files.parse(value)
    else if (request.kind === 'release') return z.null().parse(value)
    else if (request.kind === 'list') return z.array(versioningReviewSchema).max(4_096).parse(value)
    else throw new Error(`Unknown review result: ${JSON.stringify(request satisfies never)}`)
  }
}
