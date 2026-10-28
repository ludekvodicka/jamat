import { z } from 'zod'
import { worktreeRepositoryReviewSchema } from '../sessionManager/worktreeReviewSchema'

const id = z.string().min(1).max(256)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const selection = z.strictObject({ snapshotId: id, fileIds: z.array(id).max(2_000) })
const base = { draftId: id, epoch: id, expectedRevision: revision }
const edit = z.strictObject({ ...base, repositoryMessage: z.strictObject({ root: z.string().min(1).max(32768), message: z.string().max(100000) }).optional(), messageSource: z.literal('restored-draft').optional(), message: z.string().max(16_384).optional(), selection: selection.optional() })
const decision = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('finish'), operationId: id, ...selection.shape, message: z.string().max(16_384),
    workflow: z.strictObject({ workflowId: id, revision, actionId: z.literal('finish-again'),
      repositories: z.array(worktreeRepositoryReviewSchema).max(100).optional(),
    reviewVersion: revision.optional(),
      acknowledgedFindings: z.array(z.enum(['empty', 'no-prefix', 'long-first-line', 'chat-opening', 'markdown', 'reused-after-keep'])).max(6).optional(),
      agreement: z.strictObject({ acknowledgeSetup: id.optional(), confirmWorking: z.literal(true).optional(), overrideChecks: z.literal(true).optional() }) }) }),
  z.strictObject({ ...base, kind: z.literal('approve'), operationId: id, snapshotId: id, fileIds: z.array(id).max(2_000), message: z.string().max(16_384), includeExternals: z.literal(true).optional() }),
  z.strictObject({ ...base, kind: z.literal('cancel'), operationId: id }),
  z.strictObject({ ...base, kind: z.literal('revert'), operationId: id, ...selection.shape, confirmed: z.literal(true) }),
  z.strictObject({ ...base, kind: z.literal('external-review'), operationId: id, ...selection.shape, message: z.string().max(16_384) }),
  z.strictObject({ ...base, kind: z.literal('external-diff'), operationId: id, snapshotId: id, fileId: id, baselineId: id }),
  z.strictObject({ ...base, kind: z.literal('split'), operationId: id, snapshotId: id, scopeRoot: z.string().min(1).max(32_768) }),
])

export class RemoteReviewSchemas {
  static readonly edit = edit
  static readonly decision = decision
  static readonly request = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('create'), vcs: z.enum(['svn', 'git']), openId: z.string().min(1).max(256), scopeRoot: z.string().min(1).max(32_768).optional() }),
    z.strictObject({ kind: z.literal('workflow'), vcs: z.enum(['svn', 'git']), scopeRoot: z.string().min(1).max(32_768) }),
    z.strictObject({ kind: z.literal('open'), reviewId: id }), z.strictObject({ kind: z.literal('read'), reviewId: id }),
    z.strictObject({ kind: z.literal('files'), reviewId: id }), z.strictObject({ kind: z.literal('release'), reviewId: id }),
    z.strictObject({ kind: z.literal('edit'), edit }), z.strictObject({ kind: z.literal('decide'), decision }),
    z.strictObject({ kind: z.literal('list') }),
  ])
}
