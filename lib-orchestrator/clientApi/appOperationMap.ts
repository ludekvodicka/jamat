import type { RateMonitorDebugStatus, RateMonitorSnapshot } from '../rateMonitor/rateMonitorApi.types'
import type { AccountBrokerAnswer, AccountBrokerRequest, AccountCallersView, AccountUsageReport } from '../agentAccounts/accountBrokerApi.types'
import type { AntigravityLoginsView, AntigravitySwitchResult } from '../agentAccounts/antigravityLoginsApi.types'
import type { SnapinKindState, SnapinsSettings, SnapinsSettingsView, SnapinView } from '../snapins/snapinsApi.types'
import type { RemoteControlOperationMap } from '../remoteControl/remoteControlApi.types'
import type { SessionErasure, SessionScriptOutput } from '../sessionManager/sessionManagerApi.types'
import type { AgentMemoryListing, AgentMemoryLocation, AgentMemoryText } from '../agentMemory/agentMemoryApi.types'
import type { SessionModelReading } from '../sessionModelReader/sessionModelReaderApi.types'
import type {
  SessionShellOutput,
  SessionSubagentTranscript,
  SessionTaskListing,
} from '../sessionTasks/sessionTasksApi.types'
import type {
  DirectoryNote,
  DirectoryNotesImportResult,
  DirectoryNotesSnapshot,
} from './directoryNotes'
import type { ProjectTodoOperation, ProjectTodosPlace, ProjectTodosQuery, ProjectTodosSnapshot } from './projectTodos'
import type { RemoteControlSessionSelector } from '../remoteControl/remoteControlApi.types'
import type { TabControlTodosOpenedDto } from '../shared/tabRequestPort.types'
import type { AgentSettingsAgentId, AgentSettingsValue } from './agentSettings'
import type { FileChangesSettingsValue } from './fileChangesSettings'
import type { HistoricSession, HistoricSessionGroup } from './historicSessions'
import type { SessionGroupDefinition } from './sessionsGroupsState'
import type { TabControlTaskRef } from './tabControl'
import type { UiSettingsValue } from './uiSettings'
import type { VersioningSettingsField, VersioningSettingsValue } from '../versioning/versioningSettings'
import type { WorktreeSettingsValue } from './worktreeSettings'

/** Whose memory: a session of this client, or an agent and a project directory, as Historic sessions knows them. */
export type AgentMemoryTarget = { sessionId: string } | AgentMemoryLocation

/** A write that answers nothing but that it was done. */
type Done = Record<string, never>

/**
 * The operations this client registers beside the protocol's, as a typed map: a request and a
 * response per name. Main registers against it (`registry.registrar<AppOperationMap>()`), and the
 * window calls against it through `renderer/ipc/appControl`, so the two cannot disagree.
 */
export interface AppOperationMap {
  'usage.tokens': { request: import('../tokenUsage/tokenUsageApi.types').TokenUsageQuery; response: import('../tokenUsage/tokenUsageApi.types').TokenUsageResult }
  'usage.rescan': { request: Record<string, never>; response: Done }
  'usage.history': { request: { agentId: 'claude' | 'codex' | 'antigravity'; from: number; to: number; burnHours: 1 | 3 | 6 }; response: import('../rateMonitor/usageApi.types').PoolSeries }
  'usage.get': { request: Record<string, never>; response: import('../rateMonitor/usageApi.types').UsageSnapshot }
  'usage.callers': { request: Record<string, never>; response: AccountCallersView }
  'accounts.add': { request: { agentId: 'claude' | 'codex'; label: string }; response: { accountId: string } }
  'accounts.login': { request: { accountId: string }; response: { sessionId: string } }
  'accounts.rename': { request: { accountId: string; label: string }; response: Done }
  'accounts.setEnabled': { request: { accountId: string; enabled: boolean }; response: Done }
  'accounts.remove': { request: { accountId: string }; response: Done }
  /** Local only: never in `RemoteControlPeerConst.controlOperations`. */
  'accounts.antigravity.list': { request: Record<string, never>; response: AntigravityLoginsView }
  'accounts.antigravity.store': { request: { label: string }; response: { slotId: string } }
  'accounts.antigravity.update': { request: { slotId: string }; response: Done }
  'accounts.antigravity.clear': { request: Record<string, never>; response: Done }
  'accounts.antigravity.login': { request: Record<string, never>; response: { sessionId: string } }
  'accounts.antigravity.switch': { request: { slotId: string; reopenRunning?: boolean }; response: AntigravitySwitchResult }
  'accounts.antigravity.remove': { request: { slotId: string }; response: Done }
  /** Local only: never in `RemoteControlPeerConst.controlOperations`. */
  'accounts.pick': { request: AccountBrokerRequest; response: AccountBrokerAnswer }
  'accounts.report': { request: AccountUsageReport; response: { recorded: true } }
  'snapins.passWake': { request: { passDirectory: string }; response: { woken: true } }
  'snapins.list': { request: Record<string, never>; response: { kinds: { kind: string; title: string; state: SnapinKindState }[] } }
  'snapins.view': { request: { kind: string }; response: SnapinView }
  'snapins.press': { request: { kind: string; actionId: string; itemKeys?: string[] }; response: { accepted: true } }
  'snapins.settings.get': { request: Record<string, never>; response: SnapinsSettingsView }
  'snapins.settings.save': { request: { settings: SnapinsSettings }; response: { saved: true } }
  'historicSessions.appJamat': {
    request: { lastUsedSince?: number | null }
    response: HistoricSessionGroup[]
  }
  'historicSessions.project': {
    request: { categoryId: string; projectName: string; lastUsedSince?: number | null }
    response: HistoricSession[]
  }
  /** Prune: erase a conversation of the history, every Jamat record naming it included; local only. */
  'historicSessions.prune': {
    request: { agentId: AgentSettingsAgentId; nativeSessionId: string; projectPath: string; createdAt: number }
    response: SessionErasure
  }
  'agentMemory.list': { request: { target: AgentMemoryTarget }; response: AgentMemoryListing }
  'agentMemory.read': { request: { target: AgentMemoryTarget; name: string }; response: AgentMemoryText }
  'agentMemory.write': { request: { target: AgentMemoryTarget; name: string; text: string; expectedModifiedAt: number }; response: { modifiedAt: number } }
  'agentMemory.delete': { request: { target: AgentMemoryTarget; name: string }; response: { indexLinesRemoved: number } }
  'uiSettings.get': { request: Record<string, never>; response: UiSettingsValue }
  'uiSettings.save': { request: { value: UiSettingsValue }; response: Done }
  'sessionGroups.list': { request: Record<string, never>; response: readonly SessionGroupDefinition[] }
  'sessionGroups.save': { request: { groups: readonly SessionGroupDefinition[] }; response: Done }
  'agentSettings.get': { request: Record<string, never>; response: AgentSettingsValue }
  'agentSettings.save': { request: { value: AgentSettingsValue }; response: Done }
  'agentSettings.setAutoCompact': { request: { agentId: AgentSettingsAgentId; enabled: boolean }; response: Done }
  'worktreeSettings.get': { request: Record<string, never>; response: WorktreeSettingsValue }
  'worktreeSettings.save': { request: { value: WorktreeSettingsValue }; response: Done }
  'projectSetup.get': { request: { projectPath: string }; response: { setup: string[] | null } }
  'projectSetup.save': { request: { projectPath: string; setup: string[] }; response: Done }
  'fileChangesSettings.get': { request: Record<string, never>; response: FileChangesSettingsValue }
  'fileChangesSettings.save': { request: { value: FileChangesSettingsValue }; response: Done }
  'versioningSettings.get': { request: Record<string, never>; response: VersioningSettingsValue }
  'versioningSettings.save': { request: { value: VersioningSettingsValue; field?: VersioningSettingsField }; response: Done }
  'rate.get': { request: Record<string, never>; response: RateMonitorSnapshot }
  'rate.refresh': { request: Record<string, never>; response: RateMonitorSnapshot }
  'rate.debugStatus': { request: Record<string, never>; response: RateMonitorDebugStatus }
  'sessions.model': { request: { sessionId: string }; response: SessionModelReading }
  /** Local only: the owning computer runs the recovery; never in `RemoteControlPeerConst.controlOperations`. */
  'sessions.limitRecovery': { request: { sessionId: string; action: import('../limitRecovery/limitRecoveryApi.types').LimitRecoveryAction }; response: Done }
  'sessions.scriptOutput': { request: { sessionId: string; runId: string }; response: SessionScriptOutput }
  'sessionTasks.list': { request: { sessionIds: string[] }; response: Record<string, SessionTaskListing> }
  'sessionTasks.transcript': {
    request: { sessionId: string; subagentId: string; known?: string }
    response: SessionSubagentTranscript
  }
  'sessionTasks.shellOutput': {
    request: { sessionId: string; shellId: string; known?: string }
    response: SessionShellOutput
  }
  'sessionTasks.open': {
    request: { sessionId: string; task: TabControlTaskRef; title: string }
    response: { panelId: string }
  }
  'sessionTasks.openWorkflow': {
    request: { sessionId: string }
    response: { panelId: string }
  }
  'directoryNotes.get': {
    request: { sessionId: string }
    response: DirectoryNotesSnapshot
  }
  'directoryNotes.save': { request: { sessionId: string; notes: readonly DirectoryNote[] }; response: Done }
  'directoryNotes.importPrompt': { request: { sessionId: string }; response: DirectoryNotesImportResult }
  /** Exactly one of `session` and `project` (any directory inside a catalog project). */
  'projectTodos.list': {
    request: { session?: RemoteControlSessionSelector; project?: string; filter?: ProjectTodosQuery }
    response: ProjectTodosSnapshot
  }
  'projectTodos.apply': {
    request: { session?: RemoteControlSessionSelector; project?: string; operation: ProjectTodoOperation }
    response: ProjectTodosSnapshot
  }
  'projectTodos.restore': {
    request: { session?: RemoteControlSessionSelector; project?: string; id: string }
    response: ProjectTodosSnapshot
  }
  'projectTodos.open': { request: { session: RemoteControlSessionSelector; view?: ProjectTodosPlace }; response: TabControlTodosOpenedDto }
}

/** Everything the window can call: the protocol's operations and the client's own. */
export type AppControlOperationMap = RemoteControlOperationMap & AppOperationMap

export type AppControlOperation = keyof AppControlOperationMap & string
export type AppControlRequest<K extends AppControlOperation> = AppControlOperationMap[K]['request']
export type AppControlResponse<K extends AppControlOperation> = AppControlOperationMap[K]['response']
