import { z } from 'zod'
import type { RemoteTaskRequest, RemoteTaskValue } from '../../lib-orchestrator/remoteControl/remoteTaskApi.types'
import type { RemoteControlStepResult } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'

const text = z.string().max(512 * 1024), id = z.string().min(1).max(256), at = z.number().finite(), count = z.number().int().nonnegative()
const taskRequest: z.ZodType<RemoteTaskRequest> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list') }),
  z.strictObject({ kind: z.literal('transcript'), subagentId: id, known: id.optional() }),
  z.strictObject({ kind: z.literal('shell'), shellId: id, known: id.optional() }),
  z.strictObject({ kind: z.literal('script'), runId: id }),
])
const subagentState = z.enum(['running', 'done', 'failed', 'stopped', 'unfinished'])
const shellState = z.enum(['running', 'done', 'failed', 'killed', 'unfinished'])
const scriptState = z.enum(['running', 'succeeded', 'failed', 'stopped', 'lost'])
const none = z.strictObject({ kind: z.literal('none'), code: z.enum(['not-agent', 'native-session-id-pending', 'transcript-not-found', 'unknown-task', 'unreadable']), reason: text })
const unchanged = z.strictObject({ kind: z.literal('unchanged'), revision: id })
const entry = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prompt'), text, truncated: z.boolean() }),
  z.strictObject({ kind: z.literal('message'), role: z.enum(['assistant', 'user']), text, truncated: z.boolean(), at: at.nullable() }),
  z.strictObject({ kind: z.literal('tool'), tool: text, summary: text, output: text.nullable(), outputTruncated: z.boolean(), failed: z.boolean(), at: at.nullable() }),
  z.strictObject({ kind: z.literal('edit'), path: text, added: count, removed: count, preview: text, at: at.nullable() }),
  ...(['thinking', 'compact', 'interrupted', 'encrypted'] as const).map((kind) => z.strictObject({ kind: z.literal(kind), at: at.nullable() })),
  z.strictObject({ kind: z.literal('error'), text, at: at.nullable() }),
])
const transcript = z.union([none, unchanged, z.strictObject({ kind: z.literal('transcript'), revision: id,
  header: z.strictObject({ agentType: text, description: text, model: text.nullable(), state: subagentState, contextTokens: count.nullable() }),
  entries: z.array(entry).max(65536), earlierStepsOmitted: z.boolean() })])
const shell = z.union([none, unchanged, z.strictObject({ kind: z.literal('output'), revision: id, command: text,
  state: shellState, startedAt: at, endedAt: at.nullable(), text, earlierOutputOmitted: z.boolean() })])
const script = z.strictObject({ state: scriptState, source: z.enum(['live', 'log']), lines: z.array(text).max(65537), logReason: text.optional(),
  terminal: z.strictObject({ hostInstanceId: id, runtimeSessionId: id, generation: count }).nullable(), endedAt: at.optional() })
const listing = z.union([none, z.strictObject({ kind: z.literal('tasks'), olderFinished: count, catchingUp: z.boolean(), rows: z.array(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('subagent'), subagentId: id, agentType: text, description: text, depth: z.union([z.literal(1), z.literal(2)]),
    parentSubagentId: id.nullable(), state: subagentState, startedAt: at, endedAt: at.nullable(), model: text.nullable(), step: text.nullable() }),
  z.strictObject({ kind: z.literal('shell'), shellId: id, command: text, description: text.nullable(), state: shellState, startedAt: at, endedAt: at.nullable() }),
])).max(10000) })])
const scripts = z.strictObject({ runs: z.array(z.strictObject({ runId: id, phase: z.enum(['before', 'after', 'inner']),
  scriptId: z.enum(['setup', 'declared', 'merge-resolve', 'requested', 'svn', 'checks', 'svn-resolve', 'svn-merge', 'review']),
  name: text, title: text, state: scriptState, summary: text, startedAt: at, endedAt: at.optional(), durationText: text.optional(), exitCode: z.number().int().optional(),
  commands: z.array(text), row: z.boolean(), log: z.enum(['saved', 'unavailable', 'none']), logDetail: text.optional() })).max(10000),
  badge: z.strictObject({ phase: z.enum(['before', 'after']), state: z.enum(['running', 'failed', 'skipped', 'succeeded']), text, title: text, runId: id.optional() }).optional(), waitingOn: id.optional(),
})
const failure = z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.enum(['invalid-request', 'protocol-mismatch', 'forbidden', 'not-found', 'conflict', 'unavailable', 'operation-failed', 'timeout']), detail: text }) })

export class RemoteTaskResults {
  static parse(sessionId: string, request: RemoteTaskRequest, input: unknown): RemoteControlStepResult<RemoteTaskValue> {
    let value: z.ZodType
    switch (request.kind) {
      case 'list': value = z.strictObject({ listing, scripts: scripts.nullable() }); break
      case 'transcript': value = transcript; break
      case 'shell': value = shell; break
      case 'script': value = script; break
      default: throw new Error(`Unknown task request: ${JSON.stringify(request satisfies never)}`)
    }
    const envelope = z.strictObject({ sessionId: id, request: taskRequest,
      result: z.union([failure, z.strictObject({ ok: z.literal(true), value })]) }).parse(input)
    if (envelope.sessionId !== sessionId || JSON.stringify(envelope.request) !== JSON.stringify(taskRequest.parse(request)))
      throw new Error('Source task response belongs to another session or run')
    if (envelope.result.ok && request.kind !== 'list' && 'kind' in (envelope.result.value as object)) {
      const result = envelope.result.value as { kind: string; revision?: string }
      if (result.kind === 'unchanged' && (!('known' in request) || result.revision !== request.known)) throw new Error('Source task revision does not match the requested version')
    }
    return envelope.result as RemoteControlStepResult<RemoteTaskValue>
  }
}
