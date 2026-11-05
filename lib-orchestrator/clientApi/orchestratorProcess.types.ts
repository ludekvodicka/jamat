import type { OrchestratorRequestMethodsConst, OrchestratorNoticeMethodsConst } from './orchestratorProcess'
import type { PerfBuild } from '../perfMonitor/perfRecord.types'
import type { HostPingResult } from '../sessionManager/sessionManagerApi.types'
import type { ScriptRunCollapsed } from './scriptRunHandOff.types'
import type { ConfigSections } from './configSections.types'
import type { OrchestratorApi } from './orchestratorApi.types'
import type { ShellGroupAssignment } from '../shared/shellPort.types'
import type { TabPanelSnapshot } from '../shared/tabRequestPort.types'

export interface ShellSnapshot {
  groups: readonly ShellGroupAssignment[]
  panels: readonly (TabPanelSnapshot & { terminalTargetKey: string | null })[]
  lastFocusedWindowId: string | null
}
export interface OrchestratorBootstrap {
  config: { configDir: string; identity: { configIdentity: string }; runtimeChannel: 'development' | 'production' }
  smoke: boolean
  appVersion: string
  privateStateRoot: boolean
  applicationRoot: string
  resourcesPath: string
  isPackaged: boolean
  shell: ShellSnapshot
}
export type OrchestratorRuntime = Omit<OrchestratorBootstrap, 'shell'> & {
  fileDiffWorkerPath: string; svnAssemblyWorkerPath: string; tokenUsageWorkerPath: string; build: PerfBuild
}
export interface OrchestratorProjection {
  processTree: ReturnType<OrchestratorApi['processTree']>
  snapins: ReturnType<OrchestratorApi['snapinDefinitions']>
}
export type OrchestratorEvent =
  | { kind: 'projection'; value: OrchestratorProjection }
  | { kind: 'host-ping-result'; value: HostPingResult }
  | { kind: 'config'; value: ConfigSections }
  | { kind: 'session-items-changed' }
  | { kind: 'remote-changed' }
  | { kind: 'close-terminal'; key: string }
  | { kind: 'script-collapsed'; args: Parameters<ScriptRunCollapsed> }

export type OrchestratorNativeApi = {
  [Method in typeof OrchestratorRequestMethodsConst[number]]:
    (...args: Parameters<OrchestratorApi[Method]>) => Promise<Awaited<ReturnType<OrchestratorApi[Method]>>>
} & Pick<OrchestratorApi, typeof OrchestratorNoticeMethodsConst[number] | 'processTree' | 'snapinDefinitions'>
