import { RemoteReviewSchemas } from './remoteReviewSchemas'
import { RemoteTaskSchemas } from './remoteTaskSchemas'
import { RemoteContentSchemas } from './remoteContentSchemas'
import { z } from 'zod'

import type { SessionsSnapshot } from '../sessionManager/sessionManagerApi.types'
import { SessionsSnapshotValidation } from '../sessionManager/sessionsSnapshotValidation'
import { RemoteControlConst } from './remoteControlProtocol'
import type { RemoteSessionStatePage, RemoteSessionStateRequest, RemoteSessionStateResponse, RemoteSessionViewRequest, RemoteSessionViewResponse } from './remoteSessionApi.types'

const text = z.string().min(1).max(256)
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const revision = z.strictObject({ epoch: text, revision: index })
const cursor = { requestId: text, expected: revision.nullable(), offset: index }
const request = z.discriminatedUnion('kind', [
  z.strictObject({ ...cursor, kind: z.literal('sessions') }),
  z.strictObject({ ...cursor, kind: z.literal('categories') }),
  z.strictObject({ ...cursor, kind: z.literal('detail'), sessionId: text }),
])
const pageCursor = { epoch: text, revision: index, offset: index, next: index.nullable() }
const snapshot = z.custom<SessionsSnapshot>((value) => SessionsSnapshotValidation.parse(value) !== null)
const page = z.discriminatedUnion('kind', [
  z.strictObject({ ...pageCursor, kind: z.literal('sessions'), snapshot }),
  z.strictObject({ ...pageCursor, kind: z.literal('categories'), snapshot }),
  z.strictObject({ ...pageCursor, kind: z.literal('detail'), sessionId: text, sourceRevision: index.optional(),
    base64: z.string().max(87_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), totalBytes: index }),
])
const response = z.strictObject({ requestId: text, result: z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: page }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.enum(RemoteControlConst.errorCodes), detail: z.string().max(4096) }) }),
]) })

const view = { viewId: text, epoch: text, sessionId: text, viewerId: text }
const sharedOpen = z.strictObject({ openId: text, item: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), documentId: text }),
  z.strictObject({ kind: z.literal('workflow') }),
  z.strictObject({ kind: z.literal('task'), task: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('subagent'), subagentId: text }), z.strictObject({ kind: z.literal('shell'), shellId: text }), z.strictObject({ kind: z.literal('script'), runId: text }),
  ]) }),
]) })
const viewRequest = z.discriminatedUnion('operation', [
  z.strictObject({ requestId: text, ...view, operation: z.literal('sidebar.request'), body: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.enum(['notes', 'model', 'transcript']) }),
    z.strictObject({ kind: z.literal('save-notes'), operationId: text,
      notes: z.array(z.strictObject({ text: z.string().max(20_000), large: z.boolean().optional(), sticky: z.boolean().optional() })).max(50) }),
    z.strictObject({ kind: z.literal('import-prompt'), operationId: text }),
    z.strictObject({ kind: z.literal('compact'), action: z.enum(['claim', 'note', 'cooldown', 'deliver']), operationId: text }),
  ]) }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('sidebar.page'), body: RemoteContentSchemas.cursor }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('reviews.request'), body: RemoteReviewSchemas.request }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('reviews.page'), body: RemoteContentSchemas.cursor }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('tasks.request'), body: RemoteTaskSchemas.request }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('tasks.page'), body: z.strictObject({ task: RemoteTaskSchemas.request, cursor: RemoteContentSchemas.cursor }) }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('items.open'), body: sharedOpen }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('items.request'), body: z.strictObject({ after: index, epoch: text.optional(), revision: index.optional() }) }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('items.page'), body: RemoteContentSchemas.cursor }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('changes.request'), body: RemoteContentSchemas.changesRequest }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('changes.page'), body: RemoteContentSchemas.cursor }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('files.request'), body: RemoteContentSchemas.fileRequest }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('files.page'), body: RemoteContentSchemas.cursor }),
  z.strictObject({ requestId: text, epoch: text, operation: z.literal('views.open'), body: z.strictObject({ sessionId: text, viewerId: text }) }),
  z.strictObject({ requestId: text, ...view, operation: z.literal('views.close'), body: z.strictObject({}) }),
  z.strictObject({ requestId: text, operationId: text, ...view, operation: z.literal('actions.press'), body: z.union([z.strictObject({
    revision: index, workflowId: text, actionId: text,
    agreement: z.strictObject({ acknowledgeSetup: text.optional(), confirmWorking: z.literal(true).optional(), overrideChecks: z.literal(true).optional() }),
    commit: z.strictObject({ selection: z.array(z.string().min(1).max(4096)).max(20_000), message: z.string().max(128_000) }).optional(),
  }), z.strictObject({ kind: z.literal('clear-history'), revision: index }),
  z.strictObject({ kind: z.literal('resolve-conflict'), revision: index, path: z.string().min(1).max(4096),
    conflictKind: z.enum(['text', 'property', 'tree', 'diverged']).optional(),
    option: z.enum(['merged', 'take-incoming', 'keep-mine', 'keep-both', 'union']), confirm: z.literal(true).optional() })]) }),
])
const viewResponse = z.strictObject({ requestId: text, operation: z.enum(['sidebar.request', 'sidebar.page', 'views.open', 'views.close', 'actions.press', 'files.request', 'files.page', 'changes.request', 'changes.page', 'items.request', 'items.page', 'items.open', 'tasks.request', 'tasks.page', 'reviews.request', 'reviews.page']),
  result: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value: z.union([z.strictObject(view), RemoteContentSchemas.page, z.null()]) }),
    z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.enum(RemoteControlConst.errorCodes), detail: z.string().max(4096), data: z.record(z.string(), z.unknown()).optional() }) }),
  ]),
})

export class RemoteSessionSchemas {
  static readonly sharedOpen = sharedOpen
  static readonly viewCapabilities = {
    'sidebar.request': 'session-workspace.sidebar', 'sidebar.page': 'session-workspace.sidebar',
    'views.open': 'session-workspace.views', 'views.close': 'session-workspace.views', 'actions.press': 'session-workspace.actions',
    'reviews.request': 'session-workspace.reviews', 'reviews.page': 'session-workspace.reviews',
    'tasks.request': 'session-workspace.tasks', 'tasks.page': 'session-workspace.tasks',
    'files.request': 'session-workspace.files', 'files.page': 'session-workspace.files',
    'changes.request': 'session-workspace.changes', 'changes.page': 'session-workspace.changes',
    'items.open': 'session-workspace.views', 'items.request': 'session-workspace.views', 'items.page': 'session-workspace.views',
  } as const
  static readonly maximumPageBytes = 256 * 1024
  static readonly chunkBytes = 64 * 1024

  static viewRequest(value: unknown): RemoteSessionViewRequest | null {
    const parsed = viewRequest.safeParse(value)
    return parsed.success ? parsed.data : null
  }

  static viewResponse(value: unknown): RemoteSessionViewResponse | null {
    if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > RemoteSessionSchemas.maximumPageBytes) return null
    const parsed = viewResponse.safeParse(value)
    if (!parsed.success) return null
    if (parsed.data.result.ok) {
      const operation = parsed.data.operation
      const value = parsed.data.result.value
      if (operation === 'views.open') { if (!value || !('viewId' in value)) return null }
      else if (operation === 'views.close' || operation === 'actions.press') { if (value !== null) return null }
      else if (operation === 'sidebar.request' || operation === 'sidebar.page' || operation === 'reviews.request' || operation === 'reviews.page' || operation === 'tasks.request' || operation === 'tasks.page' || operation === 'files.request' || operation === 'files.page' || operation === 'changes.request' || operation === 'changes.page' || operation === 'items.request' || operation === 'items.page' || operation === 'items.open') { if (!value || !('transferId' in value)) return null }
      else throw new Error(`Unknown view response: ${operation}`)
    }
    return parsed.data
  }

  static stateRequest(value: unknown): RemoteSessionStateRequest | null {
    const parsed = request.safeParse(value)
    if (!parsed.success || (parsed.data.expected === null && parsed.data.offset !== 0)) return null
    return parsed.data
  }

  static stateResponse(value: unknown): RemoteSessionStateResponse | null {
    if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > RemoteSessionSchemas.maximumPageBytes) return null
    const parsed = response.safeParse(value)
    if (!parsed.success) return null
    if (parsed.data.result.ok && !RemoteSessionSchemas.validPage(parsed.data.result.value)) return null
    return parsed.data
  }

  private static validPage(value: RemoteSessionStatePage): boolean {
    if (value.next !== null && value.next <= value.offset) return false
    if (value.kind === 'detail') {
      const bytes = Buffer.from(value.base64, 'base64')
      const end = value.offset + bytes.length
      return bytes.length <= RemoteSessionSchemas.chunkBytes && end <= value.totalBytes
        && value.next === (end < value.totalBytes ? end : null)
        && (bytes.length > 0 || value.totalBytes === 0)
    } else if (value.kind === 'sessions' || value.kind === 'categories') {
      const snapshot = value.snapshot
      if (snapshot.revision !== value.revision || snapshot.orphans.length !== 0) return false
      if (value.kind === 'sessions') {
        if (snapshot.categories.length !== 0) return false
        for (const session of snapshot.sessions) {
          const summary = session as Partial<{ pending: boolean; hasResult: boolean; reviewPending: boolean }>
          if (summary.reviewPending !== undefined && typeof summary.reviewPending !== 'boolean') return false
          if (typeof summary.pending !== 'boolean' || typeof summary.hasResult !== 'boolean') return false
          if (session.workflow || session.actions || session.scripts || session.svnAction || session.note || session.step) return false
        }
      } else if (value.kind === 'categories') {
        if (snapshot.sessions.length !== 0) return false
      } else throw new Error(`Unknown state page: ${value.kind}`)
      const count = value.kind === 'sessions' ? snapshot.sessions.length : snapshot.categories.length
      return value.next === null || value.next === value.offset + count
    } else throw new Error(`Unknown state page: ${JSON.stringify(value)}`)
  }
}
