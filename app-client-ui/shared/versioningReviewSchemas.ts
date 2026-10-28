import { z } from 'zod'
import { worktreeRepositoryReviewSchema } from '../../lib-orchestrator/sessionManager/worktreeReviewSchema'

const literal = z.string().min(1).max(32_768)
const phase = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('editing') }).strict(),
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({ kind: z.literal('running'), startedAt: z.number(), detail: z.string().optional(), progress: z.object({
    stage: z.enum(['preparing', 'sending', 'transmitting', 'committing', 'verifying']), completed: z.number(), total: z.number().nullable(),
    stageStartedAt: z.number(), updatedAt: z.number(), groupIndex: z.number(), groupCount: z.number(),
  }).strict().optional() }).strict(),
  z.object({ kind: z.literal('done'), revision: z.string().max(8_388_608), output: z.string().max(8_388_608), finishedAt: z.number() }).strict(),
  z.object({ kind: z.literal('failed'), detail: z.string().max(8_388_608), failedAt: z.number() }).strict(),
])

export const versioningReviewSchema = z.object({
  repositories: z.array(worktreeRepositoryReviewSchema.extend({ findings: z.array(z.object({ id: z.enum(['empty', 'no-prefix', 'long-first-line', 'chat-opening', 'markdown', 'reused-after-keep']), text: z.string(), confirm: z.literal(true).optional() })).optional() })).optional(),
  workflow: z.strictObject({ workflowId: literal, acceptedAt: z.number(), lockRoots: z.array(literal).max(4096).optional() }).optional(),
  draftId: literal, sessionId: literal, vcs: z.enum(['svn', 'git']), scopeRoot: literal,
  paths: z.array(z.union([literal, z.object({ path: literal, depth: z.enum(['empty', 'infinity']) }).strict()])).max(2_000).optional(),
  scopeTooltip: z.string().max(1_048_576), source: z.enum(['svn', 'git']), message: z.string().max(16_384),
  messageSource: z.enum(['agent-proposal', 'person-local', 'person-remote', 'restored-draft', 'kept-attempt', 'unknown']).optional(), messageAt: z.number().finite().optional(),
  messageFindings: z.array(z.strictObject({ id: z.enum(['empty', 'no-prefix', 'long-first-line', 'chat-opening', 'markdown', 'reused-after-keep']), text: z.string(), confirm: z.literal(true).optional() })).optional(),
  editedByPerson: z.boolean(), proposedByAgent: z.boolean(), phase, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  externalReview: z.enum(['running', 'closed']).optional(), externalDiffAvailable: z.boolean().optional(),
  published: z.array(z.strictObject({ scopeRoot: literal, revision: literal, paths: z.array(literal).max(65_536).optional(), omittedPaths: z.array(literal).max(65_536).optional() })).max(4_096).optional(),
  epoch: literal.optional(), selection: z.object({ paths: z.array(literal).max(2_000), snapshotId: literal }).strict().optional(),
}).strict()

export const decisionResult = z.union([z.object({ ok: z.literal(true), revision: z.string().max(32_768), reviewId: z.string().min(1).max(256).optional() }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['unknown-draft', 'busy', 'stale', 'no-targets', 'invalid-target', 'external-target', 'message-too-long', 'vcs-failed', 'forbidden', 'conflict', 'uncertain']), detail: z.string().max(8_388_608), reloadRequired: z.literal(true).optional(),
    setup: z.strictObject({ commands: z.array(z.string()).max(256), hash: literal }).optional(), working: z.literal(true).optional() }).strict()])
