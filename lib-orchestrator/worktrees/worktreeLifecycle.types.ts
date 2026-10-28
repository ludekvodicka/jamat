import type { SessionRecord, SessionRecordAgent, SessionRecordProcess, SessionRecordScriptLink, SessionRecordScriptStep, SessionRecordWorktree } from '../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../sessionManager/worktreeSessionRecords'
import type { SessionActivity, SessionCreated, SessionFinishChoice, SessionFinishPress, SessionStepInfo, SessionWorktreeKind, SessionsOpErrorCode, SessionsOpResult, SessionWorkflowInfo, SessionActionsInfo } from '../sessionManager/sessionManagerApi.types'
import type { WorktreeChoicesInput, WorktreeFinisher } from './finish/worktreeFinish.types'
import type { FinishChecksGate } from '../sessionManager/worktreeSessionRuntime'
import type { SessionConflictResolved, SessionCreateSpec, SvnConflictResolveRequest, SvnConflictActor } from '../sessionManager/sessionManagerApi.types'
import type { SvnActionVerdict } from '../sessionManager/worktreeSessionRecords'

/**
 * Where a worktree of a session's directory is wanted. `projectRoot` is the catalog project the
 * directory was chosen as, null for an ad-hoc directory; `owner` is pp 7.3's explicit SVN owner at
 * or below it (dormant register, `lib-orchestrator.md`).
 */
export interface WorktreePlaceRequest {
  directory: string
  projectRoot: string | null
  owner?: string
}

/**
 * Where a worktree stands, decided before its number and its agreement so a refusal leaves nothing:
 * the kind, the directory it checks out or cuts from (whose `.worktree.json` drives setup and
 * checks), the session's place below it, and the catalog project whose counter numbers it.
 */
export interface WorktreePlacement {
  kind: SessionWorktreeKind
  ownerDir: string
  /** '/'-separated, `''` at the owner. */
  cwdSubpath: string
  catalogProject: string | null
  setupScope?: SessionRecordWorktree['setupScope']
}

export type WorktreePlacing =
  | { ok: true; value: WorktreePlacement }
  | { ok: false; code: SessionsOpErrorCode; detail: string }

/** What a worktree create asks for. `folder` is the final directory name, the session number already in front. */
export interface WorktreeRequest {
  placement: WorktreePlacement
  folder: string
  baseRef?: string
}

/**
 * The worktree as the record keeps it, and for an SVN worktree the checkout that leads the before
 * chain: the create reserves the folder, and the checkout is a visible run.
 */
export type WorktreeProvision =
  | { ok: true; value: { worktree: SessionRecordWorktree; checkout: (SessionRecordProcess & { cwd: string }) | null } }
  | { ok: false; code: SessionsOpErrorCode; detail: string }

/**
 * What a session wants of a worktree at create. Tearing one down is deliberately not on it: that is
 * a finish, under a person who has said what should happen to the work inside, and it belongs to
 * the finish flows rather than to a record being deleted. What `remove` does instead is SAY what it
 * leaves - see there.
 */
export interface SessionWorktreePort {
  place(request: WorktreePlaceRequest): Promise<WorktreePlacing>
  create(request: WorktreeRequest): Promise<WorktreeProvision>
  /** Empties the reserved folder of an SVN worktree whose checkout failed, by identity, before the checkout runs again. */
  purgeReserved(worktree: SessionRecordWorktree): Promise<SessionsOpResult>
}

/**
 * The marks of a session this library starts for itself, which the wire spec refuses to carry: a
 * one-shot run, the permission mode it runs in, and the parent it is a script run of. Without
 * `oneShot` the run is an interactive agent (the SVN merger): it gets the Claude settings file like
 * any interactive session and ends when it is stopped or exits.
 */
export interface SessionInternalMarks {
  sessionId: string
  oneShot?: true
  permission?: SessionRecordAgent['permission']
  scriptOf: SessionRecordScriptLink
}

export interface WorktreeSessionAdapter {
  setupPaths(record: SessionRecord, paths: readonly string[]): Promise<SessionsOpResult<string[]>>
  removeWithSession(record: SessionRecord): Promise<SessionsOpResult>
}

export interface WorktreeFinisherRegistration {
  session: WorktreeSessionAdapter
  load(): Promise<WorktreeFinisher>
  choices(input: WorktreeChoicesInput): readonly SessionFinishChoice[]
}

export interface WorktreeLifecycleDeps {
  withControl?<T>(record: SessionRecord, work: () => Promise<T>): Promise<T>
  dirty?(record: SessionRecord): Promise<boolean>
  sync?(sessionId: string, trigger: 'ready' | 'finish' | 'worker', confirmed?: boolean): Promise<SessionsOpResult<import('../sessionManager/sessionManagerApi.types').SessionWorktreeSyncResult> | null>
  records(): Pick<SessionRecordsStore, 'get' | 'list'> | null
  finishers: ReadonlyMap<SessionWorktreeKind, WorktreeFinisherRegistration>
  actions(): Promise<WorktreeActions>
  provision: SessionWorktreePort
  changed(): void
  create(spec: SessionCreateSpec): Promise<SessionsOpResult<SessionCreated>>
  stop(sessionId: string): Promise<SessionsOpResult>
  awaitExit(sessionId: string): Promise<boolean>
  refresh(): Promise<void>
  activityOf(record: SessionRecord): SessionActivity | null
  checks(sessionId: string, acknowledge: string | undefined, refusal: SessionsOpResult<never> | null): Promise<SessionsOpResult<FinishChecksGate>>
  whileFinishing(sessionId: string, work: () => Promise<SessionsOpResult>): Promise<SessionsOpResult>
  requestCleanup(sessionId: string): Promise<SessionsOpResult>
  remove(sessionId: string): Promise<SessionsOpResult>
  mainCopyOf(record: SessionRecord): Promise<SessionsOpResult<string>>
  onQueue<T>(work: () => Promise<SessionsOpResult<T>>): Promise<SessionsOpResult<T>>
  stepOf(record: SessionRecord): SessionStepInfo | null
  workflowOf(record: SessionRecord): SessionWorkflowInfo | null
  actionsOf(record: SessionRecord): SessionActionsInfo
}

export type WorktreeDueChange = { kind: 'clean-worktree' | 'svn-action-due'; sessionId: string }

export interface WorktreeActions {
  resolveConflict(sessionId: string, request: SvnConflictResolveRequest & { by: SvnConflictActor }): Promise<SessionsOpResult<SessionConflictResolved>>
  helperOf(sessionId: string): Promise<SessionsOpResult<SessionCreateSpec>>
  backToWork(sessionId: string, actor: 'person' | 'agent', confirmStoppedRunId?: string): Promise<SessionsOpResult<{ actionId: string | null }>>
  startUpdate(sessionId: string, mainCopy: string, requestedBy: SessionFinishPress['requestedBy'], wait?: boolean, press?: boolean): Promise<SessionsOpResult<{ actionId: string }>>
  noteVerdict(sessionId: string, verdict: SvnActionVerdict): Promise<boolean>
}

export interface LocalBeforeStep {
  accepts(step: SessionRecordScriptStep): boolean
  run(sessionId: string, recover: boolean): Promise<string>
}
