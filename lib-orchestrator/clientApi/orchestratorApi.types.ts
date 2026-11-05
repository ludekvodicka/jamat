import type { FileViewer } from '../fileViewer/fileViewer'
import type { FileViewerMediaView } from '../fileViewer/fileViewerMediaView'
import type { TerminalDetector } from '../terminalDetector/terminalDetector'
import type { SessionManager } from '../sessionManager/sessionManager'
import type { PastedFileStore } from '../pastedFiles/pastedFileStore'
import type { RemoteControlRegistry } from '../remoteControl/remoteControlRegistry'
import type { HostConnectionSnapshot } from '../hostClient/hostConnection'
import type { RemoteOutboundPort, RemoteWindowIdentity } from '../remoteControl/remoteOutbound.types'
import type { RemoteSessionView } from '../remoteControl/remoteSessionApi.types'
import type { AutolauncherPort } from './autolauncher'
import type { FileChangesManagerDeps } from '../fileChangesManager/fileChangesManager'
import type { DebugSectionId } from './debugSections.types'
import type { RunawayProcess } from '../perfMonitor/runawayTracker'

export interface OrchestratorPresentation { anythingVisible: boolean; accepting: string[]; seen: string[]; front: { panelId: string | null } | null; lastActivePanel: string | null }
export interface OrchestratorApi {
  viewerPath: FileViewer['path']
  viewerImageDragPath: FileViewer['imageDragPath']
  viewerOpenDetected: FileViewer['openDetected']
  viewerReleaseGrant: FileViewer['releaseGrant']
  mediaMetadata: FileViewerMediaView['metadata']
  mediaOpen: FileViewerMediaView['open']
  mediaCancel: FileViewerMediaView['cancel']
  stopMedia: FileViewerMediaView['stop']
  viewerOpenWorkspace: FileViewer['openWorkspace']
  viewerMediaResource: FileViewer['mediaResource']
  viewerRelease: FileViewer['release']
  detect: TerminalDetector['detect']
  detectionPath: TerminalDetector['pathOf']
  markOpened: TerminalDetector['markOpened']
  workingContext: SessionManager['workingContext']
  conflictRoot: SessionManager['conflictRootOf']
  sessionsSnapshot: SessionManager['snapshot']
  processTree: SessionManager['processTree']
  pingHost: SessionManager['pingHost']
  setDebugVisible(visible: boolean): void
  setDebugSection(section: DebugSectionId | null): void
  stopDebugPing(): void
  saveImage: PastedFileStore['saveImage']
  remoteSessionView: RemoteOutboundPort['sessionView']
  remoteViewEpoch(endpointId: string): string | null
  remoteAuthorizeView(window: RemoteWindowIdentity, endpointId: string, viewId: string): Promise<RemoteSessionView | null>
  remotePasteImage(window: RemoteWindowIdentity, ...args: Parameters<RemoteOutboundPort['terminalPasteImage']>): ReturnType<RemoteOutboundPort['terminalPasteImage']>
  remotePasteFile(window: RemoteWindowIdentity, ...args: Parameters<RemoteOutboundPort['terminalPasteFile']>): ReturnType<RemoteOutboundPort['terminalPasteFile']>
  controlIsWrite: RemoteControlRegistry['isWrite']
  controlNames: RemoteControlRegistry['names']
  autolauncherGet: AutolauncherPort['get']
  autolauncherInspect: AutolauncherPort['inspect']
  autolauncherEnable: AutolauncherPort['enable']
  autolauncherDisable: AutolauncherPort['disable']
  checkTreeRemoval(timeoutMilliseconds: number): Promise<void>
  executeDiff(input: Parameters<FileChangesManagerDeps['diffExecutor']['execute']>[0]): ReturnType<FileChangesManagerDeps['diffExecutor']['execute']>
  controlExecute: RemoteControlRegistry['execute']
  initializeInbound(): Promise<void>
  initializeOutbound(): Promise<void>
  configureServices(): void
  initializeRemoteSettingsIpc(): void
  initializeTabRequestsIpc(): void
  initializeVersioningCommitIpc(): void
  initializeFileChangesIpc(): void
  initializeFileViewerIpc(): void
  initializeRemarkableIpc(): void
  initializeContextCompactionIpc(): void
  initializeCliUpdatesIpc(): void
  initializeAttentionIpc(): void
  beginStopRemarkable(): void
  beginStopFileDiffWorker(): void
  beginStopTokenUsage(): void
  beginStopRemoteControlServer(): void
  beginStopPeerWork(): void
  beginStopRemoteListener(): void
  stopRemarkable(): void | Promise<void>
  stopFileDiffWorker(): void | Promise<void>
  stopTokenUsage(): void | Promise<void>
  stopRemoteControlServer(): void | Promise<void>
  stopPeerWork(): void | Promise<void>
  stopRemoteListener(): void | Promise<void>
  stopInbound(): Promise<void>
  stopRemoteConnections(): void | Promise<void>
  stopCliUpdates(): void | Promise<void>
  stopAccounts(): void | Promise<void>
  stopRateMonitor(): void | Promise<void>
  stopSessionNotifier(): void | Promise<void>
  stopSnapins(): void | Promise<void>
  stopSessions(): void | Promise<void>
  stopSvnAssemblyWorker(): void | Promise<void>
  cancelTabs(): void
  disposeGroups(): void
  disposeNotices(): void
  stopAttention(): void
  personActive(): void
  openSnapin(kind: string): void
  tabsChanged(): void
  revokeCommitOwner(windowId: string): void
  revokeOwner(windowId: string): void
  setPresentation(value: OrchestratorPresentation): void
  startBackground(): void
  runaway(row: RunawayProcess): void
  hostConnection(value: HostConnectionSnapshot): void
  hostClosed(): void
  snapinDefinitions(): readonly { kind: string; title: string }[]
}
