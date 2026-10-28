import { z } from 'zod'
import type { RemoteFileRequest } from '../../lib-orchestrator/remoteControl/remoteContentApi.types'

const text = z.string().max(32_768)
const id = z.string().min(1).max(256)
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const sourceBase = { sessionId: id, path: text, workingTree: z.strictObject({ scopeRoot: text, source: z.enum(['svn', 'git']) }).optional() }
const source = z.discriminatedUnion('kind', [
  z.strictObject({ ...sourceBase, kind: z.literal('workspace') }), z.strictObject({ ...sourceBase, kind: z.literal('filesystem') }),
  z.strictObject({ ...sourceBase, kind: z.literal('detected') }), z.strictObject({ ...sourceBase, kind: z.literal('external'), anchorPath: text }),
  z.strictObject({ ...sourceBase, kind: z.literal('scriptLog'), runId: id }),
])
const kind = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('markdown'), flavor: z.enum(['markdown', 'mdext']) }),
  z.strictObject({ kind: z.enum(['text', 'html', 'hex', 'missing']) }),
  z.strictObject({ kind: z.literal('code'), language: text }),
  z.strictObject({ kind: z.literal('image'), mimeType: text, animated: z.boolean() }),
  z.strictObject({ kind: z.literal('svg'), mimeType: z.literal('image/svg+xml') }),
  z.strictObject({ kind: z.literal('video'), mimeType: text }),
])
const document = z.strictObject({ documentId: id, documentKey: text, source, path: text, name: text, size: size.nullable(), contentVersion: id.nullable(), kind,
  modes: z.array(z.enum(['rendered', 'raw', 'diff', 'preview', 'hex'])).max(5) })
const entry = z.strictObject({ entryId: id, name: text, path: text, nodeKind: z.enum(['file', 'directory', 'symlink', 'other']),
  targetKind: z.enum(['file', 'directory']).nullable(), size: size.nullable(), modifiedAt: z.number().finite().nullable(), openable: z.boolean(), detail: text.nullable() })
const directory = z.strictObject({ directoryId: id, rootPath: text, path: text, relativePath: text, canGoParent: z.boolean(), entries: z.array(entry).max(5000), truncated: z.boolean() })
const resource = z.strictObject({ resourceId: id, mimeType: text, size, contentVersion: id })
const bytes = z.strictObject({ version: id, offset: size, length: size.max(65536), totalSize: size, eof: z.boolean(),
  base64: z.string().max(87_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) })
const failure = z.strictObject({ ok: z.literal(false), code: z.enum(['invalid-source', 'outside-root', 'not-file', 'not-found', 'access-denied', 'proof-expired',
  'document-expired', 'wrong-owner', 'document-changed', 'invalid-range', 'missing', 'directory-expired', 'entry-expired', 'not-directory', 'invalid-reference']), detail: text })
const result = (value: z.ZodType) => z.union([z.strictObject({ ok: z.literal(true), value }), failure])
const detectionBase = { detectionId: id, path: text, name: text, via: z.enum(['direct', 'changed', 'search']) }
const detections = z.strictObject({ requestId: id, detections: z.array(z.discriminatedUnion('kind', [
  z.strictObject({ ...detectionBase, kind: z.literal('file'), line: size.nullable(), column: size.nullable(), opensExternally: z.boolean() }),
  z.strictObject({ ...detectionBase, kind: z.literal('directory'), childrenTruncated: z.boolean(), children: z.array(z.strictObject({ detectionId: id, name: text, opensExternally: z.boolean() })).max(256) }),
  z.strictObject({ kind: z.literal('url'), detectionId: id, url: text }),
])).max(256) })
const version = z.union([failure,
  z.strictObject({ ok: z.literal(true), kind: z.enum(['unchanged', 'missing']) }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('changed'), contentVersion: id }),
])

export class RemoteFileResults {
  static readonly document = document
  static valid(request: RemoteFileRequest, value: unknown): boolean {
    if (request.kind === 'detect') return detections.safeParse(value).success
    else if (request.kind === 'detected-directory') return result(z.strictObject({ sessionId: id, path: text, directoryKey: text })).safeParse(value).success
    else if (request.kind === 'restore' || request.kind === 'open-entry' || request.kind === 'detected-file'
      || request.kind === 'conflict' || request.kind === 'merge-brief') return result(document).safeParse(value).success
    else if (request.kind === 'root-directory' || request.kind === 'project-directory' || request.kind === 'directory-at'
      || request.kind === 'document-directory' || request.kind === 'directory-entry' || request.kind === 'parent-directory') return result(directory).safeParse(value).success
    else if (request.kind === 'version') return version.safeParse(value).success
    else if (request.kind === 'release') return value === null
    else if (request.kind === 'resource-metadata') return z.union([z.strictObject({ kind: z.literal('ready'), resource }), z.strictObject({ kind: z.enum(['missing', 'changed']) })]).safeParse(value).success
    else if (request.kind === 'bytes' || request.kind === 'resource-bytes') return result(bytes).safeParse(value).success
    else if (request.kind === 'media' || request.kind === 'relative' || request.kind === 'export') return result(resource).safeParse(value).success
    else throw new Error(`Unknown remote file result: ${JSON.stringify(request)}`)
  }
}
