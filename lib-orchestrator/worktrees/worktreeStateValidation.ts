import { SvnConflictShapes } from '../svn/svnConflictShapes'
import type { SvnActionConflictSet } from '../sessionManager/worktreeSessionRecords'
import type { WorktreeView } from '../sessionManager/sessionManagerApi.types'
import { z } from 'zod'
import { worktreeRepositoryReviewSchema } from '../sessionManager/worktreeReviewSchema'
import type { WorktreeLifecycle, WorktreeWaitKind } from './worktreeState'
import { ConflictJournals } from './conflicts/conflictJournals'
import { WorktreePublication } from './worktreePublication'
import { FinishStepPolicy } from './finish/finishStepPolicy'

const count = z.number().int().nonnegative()
const time = z.number().finite().nonnegative()
const option = z.enum(['merged', 'keep-mine', 'take-incoming', 'keep-both', 'union'])
const nodeKind = z.enum(['file', 'dir', 'none', 'unrecognized'])
const conflictSet: z.ZodType<SvnActionConflictSet> = z.strictObject({ readAt: time, baseRevision: count, revision: count, more: count,
  waited: z.literal(true).optional(), entries: z.array(z.strictObject({ path: z.string(), occurrenceId: z.string().uuid().optional(),
    kind: z.enum(['text', 'property', 'tree', 'diverged']), shape: z.custom<SvnActionConflictSet['entries'][number]['shape']>(SvnConflictShapes.isShape),
    state: z.enum(['rule', 'agent', 'person', 'settled']), options: z.array(option), rule: option.optional(),
    by: z.enum(['jamat', 'agent', 'merger', 'person']).optional(), settledWith: option.optional(), saved: z.string().optional(), confirmedLoss: z.literal(true).optional(),
    journal: z.strictObject({ option, done: count }).optional(),
    facts: z.strictObject({ reason: z.enum(['edited', 'obstructed', 'deleted', 'missing', 'unversioned', 'added', 'replaced', 'moved-away', 'moved-here', 'unrecognized']).optional(),
      action: z.enum(['edited', 'added', 'deleted', 'replaced', 'unrecognized']).optional(), localKind: nodeKind.optional(), incomingKind: nodeKind.optional(),
      incomingRevision: count.optional(), movedTo: z.string().optional(), files: z.strictObject({ local: count, incoming: count, same: count, differing: count }).optional(),
      properties: z.array(z.string()).optional(), unsafe: z.literal(true).optional(), dropped: count.optional() }),
  })) })
const hashes = z.record(z.string(), z.string())
const revision = z.strictObject({ repository: z.string(), revision: count, label: z.enum(['receipt', 'base-proof', 'inferred']), paths: z.array(z.string()).optional() })
const proof = z.strictObject({ root: z.string(), revision: count, repository: z.string().optional(), base: z.string().optional(), paths: z.array(z.string()), at: time })
  .refine((value) => (value.repository === undefined) === (value.base === undefined))
const preparation = z.strictObject({ format: z.literal(1), manifest: z.string().min(1), content: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: z.string().regex(/^[a-f0-9]{64}$/), commands: z.string().regex(/^[a-f0-9]{64}$/), environment: z.string().optional(),
  checks: z.enum(['pending', 'passed', 'none', 'overridden']), checkedAt: time.optional(), attempt: count })
const update = z.strictObject({ actionId: z.string().min(1), generation: z.string().min(1), root: z.string().min(1), revision: count,
  cursor: count, completed: z.boolean(), units: z.array(z.strictObject({
    target: z.strictObject({ path: z.string().min(1), url: z.string().min(1), repository: z.string().min(1), revision: count,
      kind: z.enum(['file', 'dir']), pinned: z.boolean() }),
    phase: z.enum(['pending', 'updated', 'reconciling', 'reconciled', 'done']),
    before: hashes.optional(), definitions: hashes.optional(), parent: count.optional(), mappingChanged: z.boolean().optional(), runId: z.string().optional(),
    protectedMounts: z.array(z.strictObject({ path: z.string().min(1), url: z.string().min(1), repository: z.string().min(1) })).optional(),
  })).min(1),
}).refine((value) => value.cursor <= value.units.length && (!value.completed || value.cursor === value.units.length)
  && value.units.every((unit, index) => (index < value.cursor ? unit.phase === 'done' : unit.phase !== 'done')
    && (unit.parent === undefined || unit.parent < index)))
const execution = z.strictObject({ root: z.string().min(1), requestedBy: z.enum(['window', 'cli', 'peer']), startedAt: time,
  actionId: z.string().optional(), kind: z.enum(['finish', 'discard', 'update-main']).optional(),
  stage: z.enum(['changes', 'committing', 'stopping', 'evidence', 'checks', 'updating', 'cleaning', 'resolving', 'merging', 'verifying', 'fixing', 'diffing', 'reviewing', 'removing', 'recording', 'main-update']).optional(),
  rounds: z.strictObject({ outOfDate: count, incoming: count, lock: count }).optional(),
  flowVersion: z.literal(1).optional(),
  updateProtection: z.strictObject({ before: z.array(z.string()), overlaps: z.array(z.string()), saved: z.array(z.string()) }).optional(),
  fixed: z.array(z.strictObject({ path: z.string(), option: z.enum(['merged', 'keep-mine', 'take-incoming', 'keep-both', 'union']) })).optional(),
  passes: z.array(z.strictObject({ stage: z.enum(['changes', 'committing', 'stopping', 'evidence', 'checks', 'updating', 'cleaning', 'resolving', 'merging', 'verifying', 'fixing', 'diffing', 'reviewing', 'removing', 'recording', 'main-update']),
    runId: z.string().optional(), startedAt: time, endedAt: time, result: z.enum(['done', 'failed', 'waited']),
    facts: z.strictObject({ revision: count.optional(), conflicts: count.optional(), fixed: count.optional(), left: count.optional() }).optional() })).optional(),
  checkCursor: count, rootCursor: count,
  preparationRound: count.optional(),
  refresh: z.strictObject({ steps: z.array(z.strictObject({ key: z.string(), scriptId: z.literal('setup'), name: z.string(),
    commands: z.array(z.strictObject({ cwd: z.string(), command: z.string() })) })).min(1), cursor: count, paths: z.array(z.string()), endedAt: time.optional() }).optional(),
  checkStartedAt: time.optional(),
  checks: z.array(z.strictObject({ key: z.string(), scriptId: z.literal('checks'), name: z.string(),
    commands: z.array(z.strictObject({ cwd: z.string(), command: z.string() })) })),
  evidence: z.array(z.strictObject({ repository: z.string(), revision: count, label: z.enum(['receipt', 'base-proof', 'inferred']), paths: z.array(z.string()).optional() })),
  runId: z.string().min(1).optional(), stopRefused: z.literal(true).optional(), stopRefusedRunId: z.string().min(1).optional(),
  stopRefusedPress: z.enum(['back-to-work', 'keep', 'discard', 'commit']).optional(), checkLogPath: z.string().optional(), checkBefore: hashes.optional(), confirmBusy: z.boolean().optional(), reviewWaitAt: time.optional(),
  pendingLog: z.strictObject({ runId: z.string().min(1), title: z.string() }).optional(),
  baseRevision: count.optional(), resolverSpent: z.literal(true).optional(), retryAt: time.optional(), stageAt: time.optional(),
  removal: z.enum(['removed', 'kept', 'in-use', 'undeleted']).optional(), removalAt: time.optional(), removalLines: z.array(z.string()).optional(),
  neverStartedReason: z.string().optional(), marked: z.array(z.string()).optional(), mergeBrief: z.string().optional(),
  conflicts: z.strictObject({ paths: z.array(z.string()), before: z.array(z.string()), at: time }).optional(),
  merger: z.strictObject({ runId: z.string().min(1), setAt: time, startedAt: time, endedAt: time.optional(), checkedAt: time.optional() }).optional(),
  notice: z.strictObject({ id: z.string(), at: time, attempts: count, state: z.enum(['pending', 'delivered', 'expired']), settledAt: time.optional() }).optional(),
  checksPassed: z.strictObject({ fingerprint: z.string(), at: time }).optional(),
  verdict: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('succeeded'), exitCode: z.number().optional() }),
    z.strictObject({ kind: z.literal('failed'), reason: z.string(), exitCode: z.number().optional() })]).optional(),
  commit: z.strictObject({ selection: z.array(z.string()), message: z.string(), hashes,
    messageSource: z.enum(['agent-proposal', 'person-local', 'person-remote', 'restored-draft', 'kept-attempt', 'unknown']).optional(),
    acknowledgedFindings: z.array(z.enum(['empty', 'no-prefix', 'long-first-line', 'chat-opening', 'markdown', 'reused-after-keep'])).optional(),
    preparedAdds: z.array(z.string()).optional(), files: z.strictObject({ targetsFile: z.string(), messageFile: z.string() }).optional() }).optional(),
  roots: z.array(z.strictObject({ path: z.string(), own: z.string(), changed: z.array(z.string()), selection: z.array(z.string()).optional(), pinned: z.boolean().optional(),
    bounds: z.strictObject({ repository: z.string(), base: z.string(), rootBase: count, since: count }).optional() })).optional(),
  mounts: z.array(z.strictObject({ own: z.string(), repository: z.string() })).optional(),
}).refine((value) => value.checkCursor <= value.checks.length && (value.roots === undefined || value.rootCursor <= value.roots.length))
const subpath = z.string().min(1).refine((path) => !/[\\:\0\r\n]/.test(path)
  && !path.startsWith('/') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
const memory = z.strictObject({ actionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), readAt: time,
  paths: z.array(z.strictObject({ path: z.union([z.literal('.'), subpath]), saved: z.string().min(1), sidecars: z.array(subpath), kind: z.enum(['text', 'property', 'tree']).optional(),
    occurrenceId: z.string().uuid().optional(), source: z.string().optional() })) })
const phase = z.enum(['active', 'finishing', 'waiting', 'landed', 'kept', 'removed'])
const step = z.enum(['syncing', 'worker-resolving', 'checking', 'reviewing', 'awaiting-idle', 'committing', 'verifying', 'disposing', 'stopping-worker', 'removing', 'recording'])
const wait = z.strictObject({ kind: z.enum(['review', 'waiting-for-review', 'conflict-person', 'checks-failed', 'repository-busy',
  'published-with-differences', 'worker-lost', 'changed-outside', 'removal-blocked', 'host-unhealthy', 'svn-failed', 'locked',
  'auth', 'pinned-external', 'partially-landed', 'never-started', 'worker-busy']), reason: z.string(), at: time })
// Peer views carry additive presentation fields; only persisted lifecycle data uses strict objects.
const view = z.object({ version: count, phase, step: step.optional(), wait: wait.optional(), outOfDate: count,
  conflicts: count, summary: z.string() }).refine((value) => value.phase === 'finishing' ? value.step !== undefined && value.wait === undefined
    : value.phase === 'waiting' ? value.wait !== undefined : value.step === undefined && value.wait === undefined)
const schema = z.strictObject({
  publication: z.strictObject({ revisions: z.array(revision), verified: z.array(revision), proofs: z.array(proof), savedActions: z.array(z.string().min(1)),
    remaining: z.array(z.string()).optional(),
    selected: z.array(z.strictObject({ repository: z.string(), since: count, paths: z.array(z.string()) })).optional() }).optional(),
  legacyCommit: z.literal(true).optional(),
  unreadable: z.string().min(1).optional(),
  version: count, actionId: z.string().min(1).nullable(), phase, step: step.optional(), wait: wait.optional(), outOfDate: count,
  owner: z.enum(['person', 'remote-person', 'worker', 'agent', 'jamat']).optional(), purpose: z.enum(['finish', 'discard']).optional(),
  hasWindow: z.boolean().optional(),
  execution: z.unknown().optional(),
  update: z.unknown().optional(), updateFailure: z.string().optional(),
  preparation: z.unknown().optional(),
  preparationIntent: z.strictObject({ root: z.string(), paths: z.array(z.string()), at: time }).optional(),
  preparationAdds: z.array(z.strictObject({ root: z.string(), paths: z.array(z.string()) })).optional(),
  environment: z.strictObject({ inputs: z.string(), commands: z.string().optional(), checksPolicy: z.string().optional(), at: time, source: z.enum(['setup', 'person']), pending: z.literal(true).optional(), paths: z.array(z.string()),
    inputHashes: z.record(z.string(), z.string()).optional() }).optional(),
  approvedAt: time.optional(),
  awaitingIdleAt: time.optional(),
  awaitingIdleReason: z.string().optional(),
  busyConfirmedFor: time.optional(),
  incoming: z.array(z.strictObject({ revision: count, author: z.string().nullable() })).optional(),
  knownIncoming: z.strictObject({ paths: z.array(z.string()).min(1), at: time }).optional(),
  handoff: z.strictObject({ id: z.string(), key: z.string(), text: z.string(), at: time, attempts: count,
    state: z.enum(['pending', 'delivered', 'expired']), settledAt: time.optional() }).optional(),
  workerNotice: z.strictObject({ id: z.string(), key: z.string(), text: z.string(), at: time, attempts: count,
    state: z.enum(['pending', 'delivered', 'expired']), settledAt: time.optional() }).optional(),
  checks: z.strictObject({ passed: z.boolean(), logPath: z.string(), at: time, overridden: z.boolean(), configured: z.boolean().optional() }).optional(),
  checkBaseline: hashes.optional(),
  verified: z.array(proof).optional(),
  differences: z.array(z.string()).optional(),
  conflictProgress: z.strictObject({ generation: z.string().optional(), owner: z.enum(['worker', 'merger']), settled: count, observedAt: time, idle: z.boolean(), milliseconds: time }).optional(),
  ownerSince: time.optional(),
  removalPermit: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('clean'), provedAt: time, allowed: z.array(z.string()) }),
    z.strictObject({ kind: z.literal('discard'), by: z.literal('person'), at: time })]).optional(),
  review: z.strictObject({ repositories: z.array(worktreeRepositoryReviewSchema.strict()).optional(), version: count, reviewVersion: count.optional(), selection: z.array(z.string()), hashes, message: z.string(),
    source: z.enum(['agent-proposal', 'person-local', 'person-remote', 'restored-draft', 'kept-attempt', 'unknown']),
    acknowledged: z.array(z.enum(['empty', 'no-prefix', 'long-first-line', 'chat-opening', 'markdown', 'reused-after-keep'])), headMovedBy: count, deletions: z.array(z.string()).optional() }).optional(),
  corrective: z.literal(true).optional(),
  stoppedFailure: z.string().optional(),
  retryFrom: count.optional(),
  journal: z.array(z.strictObject({ stepId: z.string().min(1), kind: z.enum(['checkout', 'update', 'cleanup', 'status', 'diff', 'commit', 'revert', 'resolve']),
    attempt: count, baseRevision: count.optional(), cwd: z.string().min(1).optional(), args: z.array(z.string()).optional(),
    targetRevision: count.optional(), preparedAdds: z.array(z.string()).optional(), paths: z.array(z.string()).optional(), messageHash: z.string().optional(), message: z.string().optional(), author: z.string().optional(), revision: count.optional(),
    startedAt: time, endedAt: time.optional(), recovered: z.literal('not-landed').optional(), uncertain: z.strictObject({ repository: z.string(), revisions: z.array(count) }).optional(), output: z.string().optional(), logPath: z.string().optional(), outcome: z.enum(['ok', 'out-of-date', 'locked', 'auth', 'network', 'conflict', 'other']).optional(), runId: z.string() })),
  syncConflictSet: conflictSet.optional(),
  syncJournals: z.record(z.string(), z.strictObject({ option: z.enum(['merged', 'keep-mine', 'take-incoming', 'keep-both', 'union']), done: count })).optional(),
  conflictMemory: memory.optional(),
  facts: z.strictObject({ worker: z.strictObject({ liveness: z.enum(['alive', 'dead', 'stopped']), resumeFailures: count,
    diedAt: time.optional(), diedDuring: step.optional(), deathReason: z.string().optional(), resumedAt: time.optional(),
    resumeMode: z.enum(['resume-and-redeliver', 'resume-quiet', 'resume-after-step']).optional(),
    ready: z.strictObject({ at: time, hashes }).optional() }), syncedAt: z.strictObject({ revision: count, at: time, headMovedBy: count.optional() }).optional(), fingerprint: z.string().optional() }),
}).refine((value) => value.phase === 'finishing' ? value.step !== undefined && value.wait === undefined
  : value.phase === 'waiting' ? value.wait !== undefined : value.step === undefined && value.wait === undefined)

export class WorktreeStateValidation {
  static problem(value: unknown): string {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return parsed.error.message
    for (const [name, validator] of [['execution', execution], ['preparation', preparation], ['update', update]] as const) {
      if (parsed.data[name] === undefined) continue
      const checked = validator.safeParse(parsed.data[name])
      if (!checked.success) return `${name}: ${checked.error.message}`
    }
    return 'Inconsistent worktree phase, approval or execution'
  }
  static parse(value: unknown): WorktreeLifecycle | undefined {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return undefined
    const { update: rawUpdate, preparation: rawPreparation, ...rest } = parsed.data
    const checkedPreparation = preparation.safeParse(rawPreparation)
    if (rawPreparation !== undefined && !checkedPreparation.success) return undefined
    const base = { ...rest, preparation: checkedPreparation.success ? checkedPreparation.data : undefined }
    const checked = update.safeParse(rawUpdate)
    if (rawUpdate !== undefined && !checked.success) return undefined
    const state = { ...base, update: checked.success ? checked.data : undefined }
    const parsedExecution = execution.safeParse(parsed.data.execution)
    if (parsed.data.execution !== undefined && !parsedExecution.success) return undefined
    if (FinishStepPolicy.requiresApproval(state.step) && !parsedExecution.success
      && !(state.step === 'committing' && state.legacyCommit === true && state.actionId !== null)) return undefined
    if (state.approvedAt !== undefined && state.review === undefined) return undefined
    if (state.retryFrom !== undefined && state.retryFrom > state.journal.length) return undefined
    if (state.phase === 'waiting' && state.step === undefined && !WorktreeStateValidation.stepless(state.wait?.kind)) return undefined
    if (parsedExecution.success) {
      if (state.actionId === null) return undefined
      if (state.approvedAt !== undefined && state.review === undefined) return undefined
      const legacyCommit = state.step === 'committing' && parsedExecution.data.runId !== undefined
        && !state.journal.some((entry) => entry.runId === parsedExecution.data.runId)
      if (FinishStepPolicy.requiresApproval(state.step) && !legacyCommit
        && (state.approvedAt === undefined || state.review === undefined || !checkedPreparation.success || checkedPreparation.data.checkedAt === undefined)) return undefined
      if (state.step === 'removing' && state.removalPermit === undefined) return undefined
      if (state.phase === 'waiting' && state.step === undefined && !WorktreeStateValidation.stepless(state.wait?.kind)) return undefined
      if (state.retryFrom !== undefined && state.retryFrom > state.journal.length) return undefined
    }
    return WorktreePublication.retain(ConflictJournals.migrate({ ...state, execution: parsedExecution.success ? WorktreeStateValidation.execution(parsedExecution.data) : undefined }))
  }

  /** The waits that stand outside a Finish step: a worker lost while no Finish ran has no step to wait in (UA1-J14R-1). */
  private static stepless(kind: WorktreeWaitKind | undefined): boolean {
    return kind === 'published-with-differences' || kind === 'svn-failed' || kind === 'worker-lost'
  }

  /** An older record flagged a refused Stop without naming its run; the flag belonged to the run it held. */
  private static execution(value: z.infer<typeof execution>) {
    const { stopRefused, ...rest } = value
    return stopRefused === true && rest.runId !== undefined ? { stopRefusedRunId: rest.runId, ...rest } : rest
  }

  static view(value: unknown): WorktreeView | undefined {
    const parsed = view.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }

  static validConflictMemory(value: unknown): boolean {
    return value === undefined || memory.safeParse(value).success
  }
}
