import type { RateMonitorDebugStatus, RateMonitorSnapshot } from '../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { AccountAgentId } from '../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import type { SnapinKindState, SnapinsSettings, SnapinsSettingsView, SnapinView } from '../../lib-orchestrator/snapins/snapinsApi.types'
import type { RemoteControlOperationMap } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionScriptOutput } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionModelReading } from '../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type {
  SessionShellOutput,
  SessionSubagentTranscript,
  SessionTaskListing,
} from '../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type {
  DirectoryNote,
  DirectoryNotesImportResult,
  DirectoryNotesSnapshot,
} from './directoryNotes'
import type { AgentSettingsAgentId, AgentSettingsValue } from './agentSettings'
import type { FileChangesSettingsValue } from './fileChangesSettings'
import type { HistoricSession, HistoricSessionGroup } from './historicSessions'
import type { SessionGroupDefinition } from './sessionsGroupsState'
import type { TabControlTaskRef } from './tabControl'
import type { UiSettingsValue } from './uiSettings'
import type { VersioningSettingsField, VersioningSettingsValue } from './versioningSettings'
import type { WorktreeSettingsValue } from './worktreeSettings'

/** A write that answers nothing but that it was done. */
type Done = Record<string, never>

/**
 * The operations this client registers beside the protocol's, as a typed map: a request and a
 * response per name. Main registers against it (`registry.registrar<AppOperationMap>()`), and the
 * window calls against it through `renderer/ipc/appControl`, so the two cannot disagree.
 */
export interface AppOperationMap {
  'usage.tokens': { request: import('../../lib-orchestrator/tokenUsage/tokenUsageApi.types').TokenUsageQuery; response: import('../../lib-orchestrator/tokenUsage/tokenUsageApi.types').TokenUsageResult }
  'usage.rescan': { request: Record<string, never>; response: Done }
  'usage.history': { request: { agentId: 'claude' | 'codex'; from: number; to: number; burnHours: 1 | 3 | 6 }; response: import('../../lib-orchestrator/rateMonitor/usageApi.types').PoolSeries }
  'usage.get': { request: Record<string, never>; response: import('../../lib-orchestrator/rateMonitor/usageApi.types').UsageSnapshot }
  'accounts.add': { request: { agentId: AccountAgentId; label: string }; response: { accountId: string } }
  'accounts.login': { request: { accountId: string }; response: { sessionId: string } }
  'accounts.rename': { request: { accountId: string; label: string }; response: Done }
  'accounts.setEnabled': { request: { accountId: string; enabled: boolean }; response: Done }
  'accounts.remove': { request: { accountId: string }; response: Done }
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
}

/** Everything the window can call: the protocol's operations and the client's own. */
export type AppControlOperationMap = RemoteControlOperationMap & AppOperationMap

export type AppControlOperation = keyof AppControlOperationMap & string
export type AppControlRequest<K extends AppControlOperation> = AppControlOperationMap[K]['request']
export type AppControlResponse<K extends AppControlOperation> = AppControlOperationMap[K]['response']
