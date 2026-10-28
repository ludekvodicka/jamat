import { z } from 'zod'
import type { RemoteChangesRequest } from '../../lib-orchestrator/remoteControl/remoteContentApi.types'
import { RemoteFileResults } from './remoteFileResults'

const text = z.string().max(1_048_576)
const id = z.string().min(1).max(256)
const number = z.number().finite()
const count = number.int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const vcs = z.enum(['git', 'svn'])
const source = z.enum(['checkpoint', 'git', 'svn', 'worktree-base'])
const status = z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'replaced', 'untracked', 'conflicted', 'missing', 'obstructed'])
const properties = z.strictObject({ changes: z.array(z.strictObject({ name: text, before: text.nullable(), after: text.nullable() })), detail: text.nullable() })
const entry = z.strictObject({ fileId: id, path: text, displayPath: text, nodeKind: z.enum(['file', 'directory']), location: z.enum(['workspace', 'external']),
  status, previousPath: text.nullable(), previousDisplayPath: text.nullable(), modifiedAt: number.nullable(), sources: z.array(z.enum(['vcs', 'chat'])),
  gitState: z.strictObject({ index: text, worktree: text }).nullable(), carriedItems: count.optional(), origin: z.literal('setup').optional(), properties: properties.optional() })
const baseline = z.strictObject({ baselineId: id, kind: z.enum(['git-head', 'svn-base', 'git-commit', 'svn-revision', 'chat-message']), label: text,
  revision: text.nullable(), createdAt: number.nullable() })
const history = z.strictObject({ groups: z.array(z.strictObject({ groupId: id, baseline, label: text, message: text.nullable(), author: text.nullable(),
  createdAt: number, entries: z.array(entry) })), nextCursor: id.nullable() })
const common = { snapshotId: id, sessionId: id, createdAt: number, defaultBaseline: baseline.nullable(), entries: z.array(entry), warnings: z.array(text) }
const snapshot = z.strictObject({ ...common, vcs: z.strictObject({ requested: vcs, selected: vcs.nullable(), available: z.array(vcs), root: text.nullable(), fallbackReason: text.nullable() }), history })
const working = z.strictObject({ ...common, source: z.strictObject({ requested: source.nullable(), selected: source.nullable(), available: z.array(source), fallbackReason: text.nullable() }),
  externalRoots: z.array(z.strictObject({ path: text, displayPath: text, fileIds: z.array(id) })) })
const version = z.strictObject({ label: text, path: text, exists: z.boolean(), eol: z.enum(['none', 'lf', 'crlf', 'mixed']), finalNewline: z.boolean().nullable() })
const failure = z.strictObject({ ok: z.literal(false), code: z.enum(['invalid-context', 'snapshot-expired', 'invalid-cursor', 'unknown-file', 'unknown-baseline', 'invalid-pair',
  'invalid-source', 'outside-root', 'not-file', 'not-found', 'access-denied', 'proof-expired']), detail: text })
const result = (value: z.ZodType) => z.union([z.strictObject({ ok: z.literal(true), value }), failure])
const diff = z.union([failure, z.strictObject({ ok: z.literal(true), kind: z.enum(['binary', 'too-large', 'too-complex', 'busy', 'missing', 'incomplete-history', 'source-unavailable']), detail: text, properties: properties.optional() }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('text'), data: z.strictObject({ status, completeness: z.enum(['full', 'region']), current: version, baseline: version,
    detail: text.nullable(), properties: properties.optional(), hunks: z.array(z.strictObject({ beforeStart: count, beforeLines: count, afterStart: count, afterLines: count,
      lines: z.array(z.strictObject({ kind: z.enum(['context', 'add', 'remove']), text, beforeLine: count.nullable(), afterLine: count.nullable() })) })) }) })])

export class RemoteChangesResults {
  static readonly working = working
  static readonly failure = failure
  static valid(request: RemoteChangesRequest, value: unknown): boolean {
    if (request.kind === 'list') return result(snapshot).safeParse(value).success
    else if (request.kind === 'working-tree' || request.kind === 'scoped') return result(working).safeParse(value).success
    else if (request.kind === 'history') return result(history).safeParse(value).success
    else if (request.kind === 'diff') return diff.safeParse(value).success
    else if (request.kind === 'open') return result(RemoteFileResults.document).safeParse(value).success
    else throw new Error(`Unknown changes result: ${JSON.stringify(request)}`)
  }
}
