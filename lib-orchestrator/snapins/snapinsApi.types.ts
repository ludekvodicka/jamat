import type { VersioningMode } from '../git/git.types'
import type { SessionAgentId, SessionCreateOrigin, SessionCreateSpec, SessionCreated, SessionsOpResult,
  SessionsSnapshot, WorktreeResultDto, WorktreeResultsFilter } from '../sessionManager/sessionManagerApi.types'
import type { SvnResult } from '../svn/svn.types'

export type AttemptPhase = 'pending' | 'working' | 'waiting' | 'blocked' | 'review' | 'completed' | 'ended'
export type DoneOutcome = 'closed' | 'published' | 'analysis' | 'blocked' | 'ready'
export type WaitingReason = 'user' | 'blocked' | 'deploy' | 'foreign-deploy'
export type PassMode = 'wc' | 'wt'
export type SnapinKindState = 'reconciling' | 'unavailable' | 'unconfigured' | 'paused' | 'running' | 'idle'
export type SnapinRefusalCode = 'unknown-kind' | 'unknown-action' | 'invalid-items' | 'kind-latched'
  | 'invalid-settings' | 'config-latched' | 'session-live' | 'no-session' | 'tab-unavailable' | 'stopping'
export type SnapinResult<T> = { ok: true; value: T } | { ok: false; code: SnapinRefusalCode; detail: string }

export interface SnapinView {
  kind: string
  title: string
  state: SnapinKindState
  revision: number
  counts: Partial<Record<AttemptPhase | 'queued' | 'held', number>>
  sections: SnapinSection[]
}

export type SnapinSection =
  | { kind: 'notice'; tone: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'items'; groups: { title: string; mode?: PassMode; items: SnapinItemView[] }[]; actions: SnapinAction[] }
  | { kind: 'progress'; rows: { label: string; value: string }[] }
  | { kind: 'log'; lines: { at: number; level: 'info' | 'warn' | 'error'; text: string }[] }

export interface SnapinItemView {
  key: string
  title: string
  state: string
  mode?: PassMode
  tone: 'neutral' | 'active' | 'attention' | 'done'
  hold?: string
  sessionId?: string
  selectable: boolean
  actions: SnapinAction[]
}

export interface SnapinAction {
  id: string
  label: string
  scope: 'kind' | 'item' | 'selection'
  tone: 'primary' | 'secondary' | 'danger'
}

export type SnapinField =
  | { kind: 'number'; id: string; label: string; value: number; min: number; max: number }
  | { kind: 'text'; id: string; label: string; value: string }
  | { kind: 'choicePerRow'; id: string; label: string; rows: { key: string; label: string; value: string }[];
      options: { value: string; label: string }[] }

export type SnapinKindValues = Record<string, number | string | Record<string, string>>
export interface SnapinsSettings {
  limit: number
  agents: SessionAgentId[]
  workerPrompts: Partial<Record<SessionAgentId, string>>
  kinds: Record<string, SnapinKindValues>
}
export interface SnapinsSettingsView {
  settings: SnapinsSettings
  kinds: { kind: string; title: string; fields: SnapinField[] }[]
}

export interface SnapinSessionsPort {
  snapshot(): SessionsSnapshot
  versioningMode(): VersioningMode
  openTerminal(sessionId: string): Promise<'ok' | 'missing-session' | { error: string }>
  createSession(spec: SessionCreateSpec, origin: SessionCreateOrigin): Promise<SessionsOpResult<SessionCreated>>
  worktreeResults(filter: WorktreeResultsFilter): Promise<SessionsOpResult<{ results: WorktreeResultDto[] }>>
  acknowledgeWorktreeResult(actionId: string): Promise<SessionsOpResult<{ actionId: string }>>
}
export interface SnapinSvnPort {
  urlOf(dir: string): Promise<SvnResult<string>>
  listAtHead(url: string): Promise<SvnResult<string[]>>
  changedNames(dir: string): Promise<SvnResult<string[]>>
}
export interface SnapinProjectsPort {
  projects(): Promise<{ categoryId: string; categoryPath: string; projectPath: string }[]>
}
export interface SnapinPresentationPort {
  ensureGroups(): Promise<boolean>
  assign(sessionId: string, group: string): 'ok' | 'missing-session' | 'missing-group' | 'failed'
  setNote(sessionId: string, note: string): Promise<'ok' | 'missing-session' | 'failed'>
}
