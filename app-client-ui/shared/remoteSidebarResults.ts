import { z } from 'zod'
import type { RemoteSidebarRequest } from '../../lib-orchestrator/remoteControl/remoteSidebarApi.types'

const notes = z.array(z.strictObject({ text: z.string().max(20_000), large: z.boolean().optional(), sticky: z.boolean().optional() })).max(50)
const model = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none'), reason: z.string() }),
  z.strictObject({ kind: z.literal('ok'), info: z.strictObject({ model: z.string(), modelLabel: z.string(), effortLevel: z.string().nullable(),
    contextTokens: z.number().nonnegative(), contextWindow: z.number().nonnegative().nullable() }) }),
])
const transcript = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none'), code: z.enum(['not-agent', 'native-session-id-pending', 'transcript-not-found', 'no-messages-in-scanned-tail', 'transcript-unreadable']), reason: z.string() }),
  z.strictObject({ kind: z.literal('messages'), messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), text: z.string(), at: z.number().nullable(), textTruncated: z.boolean() })),
    bounds: z.strictObject({ maxMessages: z.number(), maxCharactersPerMessage: z.number(), scannedBytes: z.number() }), earlierContentOmitted: z.boolean() }),
])
const imported = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('taken'), notes, index: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('partial'), notes, index: z.number().int().nonnegative(), reason: z.enum(['not-erased', 'text-remains']), detail: z.string() }),
  z.strictObject({ kind: z.literal('empty') }),
  z.strictObject({ kind: z.literal('refused'), reason: z.enum(['unknown-session', 'not-live', 'not-agent', 'unreadable', 'dialog', 'no-prompt', 'too-tall', 'placeholder', 'in-flight', 'read-only', 'storage', 'unavailable', 'failed']), detail: z.string() }),
])

export class RemoteSidebarResults {
  static parse(sessionId: string, request: RemoteSidebarRequest, value: unknown) {
    const envelope = z.strictObject({ sessionId: z.string(), request: z.unknown(), result: z.unknown() }).parse(value)
    if (envelope.sessionId !== sessionId || JSON.stringify(envelope.request) !== JSON.stringify(request)) throw new Error('Source sidebar response belongs to another request')
    const schema = request.kind === 'notes' ? z.strictObject({ directory: z.string(), notes })
      : request.kind === 'save-notes' ? z.null() : request.kind === 'import-prompt' ? imported
      : request.kind === 'model' ? model : request.kind === 'transcript' ? transcript
      : request.kind === 'compact' ? RemoteSidebarResults.compact(request.action)
      : (() => { throw new Error(`Unknown sidebar request: ${JSON.stringify(request satisfies never)}`) })()
    return z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: schema }),
      z.strictObject({ ok: z.literal(false), error: z.object({ code: z.string().max(256), detail: z.string() }) })]).parse(envelope.result)
  }

  private static compact(action: Extract<RemoteSidebarRequest, { kind: 'compact' }>['action']): z.ZodType {
    if (action === 'claim') return z.boolean()
    else if (action === 'note') return z.null()
    else if (action === 'cooldown') return z.strictObject({ requestedAt: z.number(), expiresAt: z.number() }).nullable()
    else if (action === 'deliver') return z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('delivered'), proof: z.enum(['transcript', 'queued', 'working', 'echo']) }),
      z.strictObject({ kind: z.literal('refused'), stage: z.string(), reason: z.string(), detail: z.string() }),
    ])
    else throw new Error(`Unknown compact action: ${action satisfies never}`)
  }
}
