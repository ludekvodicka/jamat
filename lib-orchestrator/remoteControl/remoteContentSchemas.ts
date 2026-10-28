import { z } from 'zod'

const id = z.string().min(1).max(256)
const path = z.string().max(32_768).refine((value) => !value.includes('\0'))
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const sourceBase = { sessionId: id, path, workingTree: z.strictObject({ scopeRoot: path, source: z.enum(['svn', 'git']) }).optional() }
const source = z.discriminatedUnion('kind', [
  z.strictObject({ ...sourceBase, kind: z.literal('workspace') }),
  z.strictObject({ ...sourceBase, kind: z.literal('filesystem') }),
  z.strictObject({ ...sourceBase, kind: z.literal('detected') }),
  z.strictObject({ ...sourceBase, kind: z.literal('external'), anchorPath: path }),
  z.strictObject({ ...sourceBase, kind: z.literal('scriptLog'), runId: id }),
])

export class RemoteContentSchemas {
  static readonly source = source
  static readonly cursor = z.strictObject({ transferId: id, version: id, offset: index })
  static readonly page = z.strictObject({ transferId: id, version: id, offset: index, totalBytes: index.max(16 * 1024 * 1024),
    base64: z.string().max(87_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).refine((value) => {
    const size = Buffer.from(value.base64, 'base64').length
    return size <= 64 * 1024 && value.offset + size <= value.totalBytes && (size > 0 || value.totalBytes === 0)
  })
  static readonly changesRequest = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('list'), preferredVcs: z.enum(['svn', 'git']).nullable() }),
    z.strictObject({ kind: z.literal('working-tree'), source: z.enum(['svn', 'git', 'checkpoint', 'worktree-base']).nullable() }),
    z.strictObject({ kind: z.literal('scoped'), source }),
    z.strictObject({ kind: z.literal('history'), snapshotId: id, cursor: id }),
    z.strictObject({ kind: z.literal('diff'), request: z.strictObject({ snapshotId: id, fileId: id, baselineId: id }) }),
    z.strictObject({ kind: z.literal('open'), snapshotId: id, fileId: id }),
  ])
  static readonly fileRequest = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('conflict'), path }),
    z.strictObject({ kind: z.literal('merge-brief') }),
    z.strictObject({ kind: z.literal('detect'), capture: z.strictObject({ token: path.nullable(), selection: path.nullable(), contextText: path, fallbackToken: path.nullable() }) }),
    z.strictObject({ kind: z.enum(['detected-file', 'detected-directory']), requestId: id, detectionId: id }),
    z.strictObject({ kind: z.literal('restore'), source, supportsDiff: z.boolean() }),
    z.strictObject({ kind: z.enum(['release', 'version', 'document-directory', 'media', 'export']), documentId: id }),
    z.strictObject({ kind: z.literal('resource-metadata'), resourceId: id, version: id }),
    z.strictObject({ kind: z.literal('resource-bytes'), resourceId: id, version: id, offset: index, length: index.min(1).max(65536) }),
    z.strictObject({ kind: z.literal('bytes'), documentId: id, version: id, offset: index, length: index.min(1).max(64 * 1024) }),
    z.strictObject({ kind: z.enum(['root-directory', 'project-directory']) }),
    z.strictObject({ kind: z.literal('directory-at'), path }),
    z.strictObject({ kind: z.enum(['directory-entry', 'open-entry']), directoryId: id, entryId: id }),
    z.strictObject({ kind: z.literal('parent-directory'), directoryId: id }),
    z.strictObject({ kind: z.literal('relative'), documentId: id, reference: path }),
  ])
}
