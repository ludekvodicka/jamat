import type { SessionAgentId, SessionColorName, SessionCreateSpec } from '../../sessionManager/sessionManagerApi.types'
import type { AttemptPhase, DoneOutcome, PassMode, SnapinAction, SnapinField, SnapinKindValues,
  SnapinProjectsPort, SnapinSessionsPort, SnapinSvnPort, WaitingReason } from '../snapinsApi.types'

export interface AttemptRecord {
  attemptId: string
  itemKey: string
  title: string
  mode: PassMode
  projectDirectory: string
  agentId: SessionAgentId
  phase: AttemptPhase
  createdAt: number
  sessionId?: string
  createUndecided?: true
  startedAt?: number
  trail?: string
  readyObservedAt?: number
  goneObservedAt?: number
  outcome?: { kind: DoneOutcome; waiting?: WaitingReason; detail: string; note?: string; report?: string; at: number }
  appliedThrough: number
  attention?: 'start' | 'setup' | 'not-published' | 'worktree-kind'
  endedReason?: string
  endedAt?: number
  completedAt?: number
  completion?: { detail: string }
  resultsSettled?: boolean
  resultsCheckedAt?: number
  group: string
  leaseHeld: boolean
  leaseFrom?: string
  presentedPhase?: AttemptPhase
  presentationRetryAt?: number
  evidenceCheckedAt?: number
}
export interface QueueEntry {
  itemKey: string
  addedAt: number
  startAnyway?: true
  priorAttemptId?: string
  inheritsLeaseFrom?: string
  setupAgreement?: { hash: string; commands: string[] }
  acknowledgeSetup?: string
}
export interface SnapinStateDocument {
  schemaVersion: 1
  kind: string
  paused: boolean
  queue: QueueEntry[]
  attempts: AttemptRecord[]
}
export interface PassBrief {
  schema: 1
  attemptId: string
  kind: string
  mode: PassMode
  projectDirectory: string
  priorAttemptId: string | null
  work: { kind: string } & Record<string, unknown>
}
export interface SnapinDefinition {
  kind: string
  title: string
  colour: SessionColorName
  menuOrder: number
  settings: {
    fields(values: SnapinKindValues, ctx: SnapinContext): Promise<SnapinField[]>
    validate(values: SnapinKindValues): string | null
  }
  list(ctx: SnapinContext, values: SnapinKindValues): Promise<{ ok: true; items: SnapinItem[] } | { ok: false; detail: string }>
  /** `{ hold }` refuses the item: it leaves the queue and stays held until the next listing. */
  launchSpec(ctx: SnapinContext, values: SnapinKindValues, item: SnapinItem, attemptId: string): Promise<LaunchSpec | { hold: string }>
  evidence(ctx: SnapinContext, attempt: AttemptRecord): Promise<{ published: true; detail: string } | { published: false } | { discarded: true }>
  solveAllOrder(items: SnapinItem[]): SnapinItem[]
  press(ctx: SnapinContext, values: SnapinKindValues, actionId: string, itemKeys: string[]): Promise<
    { ok: true } | { ok: false; code: 'unknown-action' | 'invalid-items' }>
}
export interface SnapinItem {
  key: string
  title: string
  group: string
  mode: PassMode
  projectDirectory: string
  hold?: string
  selectable: boolean
  actions: SnapinAction[]
  payload: Record<string, string | number>
}
export interface LaunchSpec {
  directory: SessionCreateSpec['directory']
  title: string
  number: string
  worktreeSlug?: string
  work: PassBrief['work']
}
export interface SnapinContext {
  sessions: SnapinSessionsPort
  svn: SnapinSvnPort
  projects: SnapinProjectsPort
  log(text: string): void
  now(): number
}
