import type { RateMonitorDebugStatus, RateMonitorSnapshot } from '../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { RemoteControlOperationMap } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionModelReading } from '../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type {
  DirectoryNote,
  DirectoryNotesImportResult,
  DirectoryNotesSnapshot,
} from './directoryNotes'
import type { AgentSettingsAgentId, AgentSettingsValue } from './agentSettings'
import type { FileChangesSettingsValue } from './fileChangesSettings'
import type { HistoricSession, HistoricSessionGroup } from './historicSessions'
import type { SessionGroupDefinition } from './sessionsGroupsState'
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
