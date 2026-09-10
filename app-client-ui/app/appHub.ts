import { CatalogSection } from '../../lib-orchestrator/projectManager/catalog/catalogSection'
import { AppClientUiReport } from '../shared/appClientUiReport'
import { DetectionRefusal } from './shared/detectionRefusal'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { app, net, safeStorage, type WebContents } from 'electron'

import { ConfigStore } from '../../lib-orchestrator/configStore/configStore'
import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager'
import { VcsStatusView } from '../../lib-orchestrator/fileChangesManager/vcsStatusView'
import { GitCommitManager } from '../../lib-orchestrator/git/gitCommitManager'
import { GitCheckpointStore } from '../../lib-orchestrator/git/gitCheckpointStore'
import { GitInvoker } from '../../lib-orchestrator/git/gitInvoker'
import { SvnCommitManager } from '../../lib-orchestrator/svn/svnCommitManager'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker'
import type { FileChangesContext } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileViewer } from '../../lib-orchestrator/fileViewer/fileViewer'
import { ProjectManager } from '../../lib-orchestrator/projectManager/projectManager'
import { RateMonitor } from '../../lib-orchestrator/rateMonitor/rateMonitor'
import { RemoteControl } from '../../lib-orchestrator/remoteControl/remoteControl'
import { RemoteControlInstanceRegistry } from '../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry'
import { RemoteControlPeerClient } from '../../lib-orchestrator/remoteControl/remoteControlPeerClient'
import { RemoteControlTerminal } from '../../lib-orchestrator/remoteControl/remoteControlTerminal'
import { SessionManager } from '../../lib-orchestrator/sessionManager/sessionManager'
import { SessionModelReader } from '../../lib-orchestrator/sessionModelReader/sessionModelReader'
import { SessionTranscriptReader } from '../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReader'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths'
import {
  TerminalDetector,
  type TerminalDetectorDeps,
} from '../../lib-orchestrator/terminalDetector/terminalDetector'
import type {
  AppClientUiEventArgs,
  AppClientUiIpcEventMap,
  AppClientUiIpcInvokeMap,
} from '../shared/appClientUiIpc'
import { AgentModels } from '../shared/agentModels'
import { AgentSettings, type AgentSettingsAgentId } from '../shared/agentSettings'
import { AppCommands, type CommandId } from '../shared/commands'
import { ErrorText } from '../shared/errorText'
import { FileViewerProtocolUrl } from '../shared/fileViewerProtocol'
import type { RemoteControlListenerSettings } from '../shared/remoteControlSettings'
import { AgentSettingsSection } from './agents/agentSettingsSection'
import { ServiceAgentSettingsIpc } from './agents/serviceAgentSettingsIpc'
import type { AppContext } from './appContext'
import { ClientStatePaths } from './clientState/clientStatePaths'
import { ClientStateStore } from './clientState/clientStateStore'
import { ServiceContextCompactionIpc } from './contextCompaction/serviceContextCompactionIpc'
import { HostPingLoop } from './debug/hostPingLoop'
import { ServiceDebugIpc } from './debug/serviceDebugIpc'
import { FileChangesSettingsSection } from './fileChanges/fileChangesSettingsSection'
import { FileDiffWorker } from './fileChanges/diff/fileDiffWorker'
import { ServiceFileChangesSettingsIpc } from './fileChanges/serviceFileChangesSettingsIpc'
import { ServiceVersioningSettingsIpc } from './versioning/serviceVersioningSettingsIpc'
import { ServiceVersioningCommitIpc } from './versioning/serviceVersioningCommitIpc'
import { ExternalDiffLauncher } from './versioning/externalDiffLauncher'
import { VersioningCommitManager } from './versioning/versioningCommitManager'
import { ServiceWorktreeSettingsIpc } from './worktrees/serviceWorktreeSettingsIpc'
import { VersioningSettingsSection } from './versioning/versioningSettingsSection'
import { WorktreeSettingsSection } from './worktrees/worktreeSettingsSection'
import { ServiceFileChangesIpc } from './fileChanges/serviceFileChangesIpc'
import { ServiceFileViewerIpc } from './fileViewer/serviceFileViewerIpc'
import { FileViewerProtocol } from './fileViewer/fileViewerProtocol'
import { ServiceProjectsIpc } from './projects/serviceProjectsIpc'
import { ServiceRateMonitorIpc } from './rateMonitor/serviceRateMonitorIpc'
import { RemarkableManager } from './remarkable/remarkableManager'
import { ServiceRemarkableIpc } from './remarkable/serviceRemarkableIpc'
import { RemarkableSettingsSection } from './remarkable/settings/remarkableSettingsSection'
import { RemarkableStorageSection } from './remarkable/settings/remarkableStorageSection'
import { RemarkableCli } from './remarkable/sidecar/remarkableCli'
import { RemarkableSidecarInstaller } from './remarkable/sidecar/remarkableSidecarInstaller'
import { RemarkableSidecarSource } from './remarkable/sidecar/remarkableSidecarSource'
import { RemarkableCredentialStore } from './remarkable/storage/remarkableCredentialStore'
import { RemarkableRunStore } from './remarkable/storage/remarkableRunStore'
import { RemoteConnectionsManager } from './remoteControl/remoteConnectionsManager'
import { RemoteControlInboundRegistry } from './remoteControl/remoteControlInboundRegistry'
import { RemoteControlPairingManager } from './remoteControl/remoteControlPairingManager'
import { RemoteControlPeerServer } from './remoteControl/remoteControlPeerServer'
import { RemoteControlServer } from './remoteControl/remoteControlServer'
import { RemoteControlInstanceStore } from './remoteControl/remoteControlInstanceStore'
import { RemoteControlSettingsSection } from './remoteControl/remoteControlSettingsSection'
import { RemoteEndpointIdentityStore } from './remoteControl/remoteEndpointIdentityStore'
import { RemoteInboundApprovalManager } from './remoteControl/remoteInboundApprovalManager'
import { RemotePeerCredentialStore } from './remoteControl/remotePeerCredentialStore'
import { RemotePeerListenerManager } from './remoteControl/remotePeerListenerManager'
import { RemoteProfileLifecycle } from './remoteControl/remoteProfileLifecycle'
import { ServiceRemoteControlIpc } from './remoteControl/serviceRemoteControlIpc'
import { ServiceRemoteSettingsIpc } from './remoteControl/serviceRemoteSettingsIpc'
import { ServiceSessionModelIpc } from './sessionModel/serviceSessionModelIpc'
import { ServiceSessionTranscriptIpc } from './sessionTranscript/serviceSessionTranscriptIpc'
import { SessionTranscriptAccess } from './sessionTranscript/sessionTranscriptAccess'
import { ServiceSessionsIpc } from './sessions/serviceSessionsIpc'
import { SkillLinkInstaller } from './skills/skillLinkInstaller'
import { AppMenu } from './shell/appMenu'
import { AppRestart } from './shell/appRestart'
import { DebugWindow } from './shell/debugWindow'
import { ServiceClipboardIpc } from './shell/serviceClipboardIpc'
import { ServiceDialogIpc } from './shell/serviceDialogIpc'
import { ServiceShellIpc } from './shell/serviceShellIpc'
import { ServiceWindowsIpc } from './shell/serviceWindowsIpc'
import { WindowIcon } from './shell/windowIcon'
import { WorkspaceWindows } from './shell/workspaceWindows'
import { ServiceTabsIpc } from './tabs/serviceTabsIpc'
import { TabControlBroker } from './tabs/tabControlBroker'
import { TabFileOpenResolver } from './tabs/tabFileOpenResolver'
import { TabTransferBroker } from './tabs/tabTransferBroker'
import { WorkspacePanelIndex } from './tabs/workspacePanelIndex'
import { ServiceTerminalIpc } from './terminals/serviceTerminalIpc'
import { ServiceTerminalMenuIpc } from './terminals/serviceTerminalMenuIpc'
import { KeyboardSettingsSection } from './keyboardSettings/keyboardSettingsSection'
import { ServiceKeyboardSettingsIpc } from './keyboardSettings/serviceKeyboardSettingsIpc'
import { ServiceUiSettingsIpc } from './uiSettings/serviceUiSettingsIpc'
import { UpdateManager } from './update/updateManager'

type TerminalDetectorPathHints = Awaited<ReturnType<TerminalDetectorDeps['changedPaths']>>

/**
 * The one composition layer, the same lesson as `app-host/app/appHub.ts`: V2 reached its domains
 * through classes that only forwarded calls, so a new method had to be written three times before it
 * was reachable. Everything the shell owns is assembled here and exposed only to app.ts.
 */
/** Every key of every table in the tuple, which is what an intersection of them has. */
type MergedChannels<T extends readonly unknown[]> =
  T extends readonly [infer Head, ...infer Rest] ? Head & MergedChannels<Rest> : unknown

export class AppHub {
  private static readonly smokeTimeoutMillisecondsConst = 60_000
  private static readonly smokePhaseTimeoutMillisecondsConst = 15_000
  private static readonly smokePollMillisecondsConst = 25
  /** One burst of right clicks in one place, and short enough that a file just written is found. */
  private static readonly changedPathHintTtlMillisecondsConst = 5_000
  /**
   * The services' channel tables, in ONE list, merged into the whole contract.
   *
   * Two proofs ride on it and both used to name the services separately: `satisfies` fails
   * the compile the day the contract carries a channel no service claims, and the merge throws the
   * day two services claim the same one - which would otherwise reach only whichever registered
   * second, while the other silently handled nothing. The sum that proved the second was a list of
   * `Object.keys(...).length` expressions beside this one, so a service missing from IT reported
   * "a channel unaccounted for" about a contract that was whole.
   */
  static readonly ipcChannelsConst = AppHub.mergedChannelsOf([
    ServiceShellIpc.channelsConst,
    ServiceWindowsIpc.channelsConst,
    ServiceDialogIpc.channelsConst,
    ServiceClipboardIpc.channelsConst,
    ServiceProjectsIpc.channelsConst,
    ServiceSessionsIpc.channelsConst,
    ServiceRemoteControlIpc.channelsConst,
    ServiceRemoteSettingsIpc.channelsConst,
    ServiceTabsIpc.channelsConst,
    ServiceTerminalIpc.channelsConst,
    ServiceTerminalMenuIpc.channelsConst,
    ServiceDebugIpc.channelsConst,
    ServiceVersioningSettingsIpc.channelsConst,
    ServiceVersioningCommitIpc.channelsConst,
    ServiceWorktreeSettingsIpc.channelsConst,
    ServiceFileChangesSettingsIpc.channelsConst,
    ServiceFileChangesIpc.channelsConst,
    ServiceFileViewerIpc.channelsConst,
    ServiceRemarkableIpc.channelsConst,
    ServiceUiSettingsIpc.channelsConst,
    ServiceKeyboardSettingsIpc.channelsConst,
    ServiceAgentSettingsIpc.channelsConst,
    ServiceContextCompactionIpc.channelsConst,
    ServiceRateMonitorIpc.channelsConst,
    ServiceSessionModelIpc.channelsConst,
    ServiceSessionTranscriptIpc.channelsConst,
  ] as const) satisfies Record<keyof AppClientUiIpcInvokeMap, true>

  /**
   * Which agents `agents.describe` answers about. Typed off `AgentSettingsAgentId`, so a name that
   * is not an agent fails here; a THIRD agent added there needs this line, exactly like the pairs
   * `AgentSettings` and `AgentModels` already branch over.
   */
  private static readonly describedAgentsConst: readonly AgentSettingsAgentId[] = ['claude', 'codex']

  private readonly store: ClientStateStore
  private readonly panelIndex: WorkspacePanelIndex
  private readonly workspaceWindows: WorkspaceWindows
  private readonly transferBroker: TabTransferBroker
  private readonly tabControlBroker: TabControlBroker
  private readonly debugWindow: DebugWindow
  private readonly shellIpc: ServiceShellIpc
  private readonly windowsIpc: ServiceWindowsIpc
  private readonly dialogIpc: ServiceDialogIpc
  private readonly clipboardIpc = new ServiceClipboardIpc()
  private readonly projects: ProjectManager
  private readonly projectsIpc: ServiceProjectsIpc
  private readonly sessions: SessionManager
  private readonly remoteControlServer: RemoteControlServer
  private readonly remoteConnections: RemoteConnectionsManager
  private readonly remoteInbound: RemoteControlInboundRegistry
  private readonly remoteIpc: ServiceRemoteControlIpc
  private readonly remoteSettingsIpc: ServiceRemoteSettingsIpc
  private readonly remotePairing: RemoteControlPairingManager
  private readonly remoteInboundApproval: RemoteInboundApprovalManager
  private readonly remoteListener: RemotePeerListenerManager
  /** Read where it is used, never cached: the listener is applied again whenever it changes. */
  private readonly remoteListenerSettings: () => RemoteControlListenerSettings
  private readonly skillLinks: SkillLinkInstaller
  private readonly sessionsIpc: ServiceSessionsIpc
  private readonly tabsIpc: ServiceTabsIpc
  private readonly terminalsIpc: ServiceTerminalIpc
  private readonly terminalDetector: TerminalDetector
  private readonly terminalMenuIpc: ServiceTerminalMenuIpc
  private readonly debugIpc: ServiceDebugIpc
  private readonly versioningSettingsIpc: ServiceVersioningSettingsIpc
  private readonly commits: VersioningCommitManager
  private readonly versioningCommitIpc: ServiceVersioningCommitIpc
  private readonly worktreeSettingsIpc: ServiceWorktreeSettingsIpc
  private readonly fileChangesSettingsIpc: ServiceFileChangesSettingsIpc
  private readonly fileDiffWorker: FileDiffWorker
  private readonly fileChanges: FileChangesManager
  private readonly fileViewer: FileViewer
  private readonly fileChangesIpc: ServiceFileChangesIpc
  private readonly fileViewerIpc: ServiceFileViewerIpc
  private readonly fileViewerProtocol: FileViewerProtocol
  private readonly remarkable: RemarkableManager
  private readonly remarkableIpc: ServiceRemarkableIpc
  private readonly uiSettingsIpc: ServiceUiSettingsIpc
  private readonly keyboardSettingsIpc: ServiceKeyboardSettingsIpc
  private readonly agentSettingsIpc: ServiceAgentSettingsIpc
  private readonly contextCompactionIpc = new ServiceContextCompactionIpc()
  private readonly rateMonitor: RateMonitor
  private readonly rateMonitorIpc: ServiceRateMonitorIpc
  private readonly sessionModelIpc: ServiceSessionModelIpc
  private readonly sessionTranscriptIpc: ServiceSessionTranscriptIpc
  private readonly pingLoop: HostPingLoop
  private readonly menu: AppMenu
  private readonly appRestart: AppRestart
  private readonly updateManager: UpdateManager
  private readonly visibleWorkspaceWindowIds = new Set<string>()
  private readonly changedPathHintCache = new Map<
    string,
    { expiresAt: number; hints: Promise<TerminalDetectorPathHints> }
  >()
  private debugVisible = false
  private remoteRevision = 0

  constructor(context: AppContext) {
    const configIdentity = context.config.identity.configIdentity
    const channel = context.config.runtimeChannel
    const applicationRoot = dirname(app.getAppPath())
    this.store = new ClientStateStore(
      ClientStatePaths.stateFile(configIdentity, channel),
      ClientStatePaths.snapshotsDirectory(configIdentity, channel),
      (message) => this.report(message),
    )
    this.panelIndex = new WorkspacePanelIndex()
    this.workspaceWindows = new WorkspaceWindows(context, this.store, {
      onCreated: (windowId) => this.workspaceWindowCreated(windowId),
      onVisibilityChanged: (windowId, visible) =>
        this.workspaceVisibilityChanged(windowId, visible),
      onRendererGone: (windowId) => this.workspaceRendererGone(windowId),
      onClosed: (windowId) => this.workspaceWindowClosed(windowId),
      confirmMainWindowClose: (parent, holderCount) =>
        this.dialogIpc.confirmMainWindowClose(parent, holderCount),
      plainSessionIds: (windowId) => this.panelIndex.plainSessionIds(windowId),
      closePlainSessions: (sessionIds) => this.closePlainSessions(sessionIds),
      requestQuit: () => app.quit(),
      explicitlyClosing: (windowId) => this.transferBroker.cancelClosingWindow(windowId),
      report: (message) => this.report(message),
    })
    this.transferBroker = new TabTransferBroker(this.workspaceWindows, this.panelIndex)
    this.debugWindow = new DebugWindow(context, {
      store: this.store,
      onVisibilityChanged: (visible) => this.debugVisibilityChanged(visible),
    })
    this.shellIpc = new ServiceShellIpc(
      context.appInfo,
      this.store,
      (sender) => this.workspaceWindows.windowIdOf(sender),
      (sender) => this.workspaceWindows.markRendererReady(sender),
    )
    this.windowsIpc = new ServiceWindowsIpc(
      this.workspaceWindows,
      this.store,
      () => this.updateWindowMenu(),
    )
    this.dialogIpc = new ServiceDialogIpc((sender) => {
      const windowId = this.workspaceWindows.windowIdOf(sender)
      return (windowId === null
        ? null
        : this.workspaceWindows.window(windowId)?.windowHandle() ?? null)
        ?? this.workspaceWindows.main().windowHandle()
    })
    // One writer over config.json for the whole process: every section owner is handed this same
    // instance, so two of them cannot each hold their own idea of what the file says.
    const configStore = ConfigStore.load(context.config.configDir, {
      // Without a snapshots directory the store is read-only and every save throws.
      snapshotsDirectory: OrchestratorPaths.configSnapshotsDirectory(configIdentity, channel),
      report: (message) => this.report(message),
      // Whose the key-less snapshots are is the consumer's to say, and on this machine they are the
      // catalog's: it was the only writer of config.json until `ui` arrived.
      legacySnapshotSection: CatalogSection.spec.key,
    })
    this.projects = new ProjectManager({
      configStore,
      configIdentity,
      channel,
      onError: (message) => this.report(message),
    })
    this.projectsIpc = new ServiceProjectsIpc(this.projects)
    this.versioningSettingsIpc = new ServiceVersioningSettingsIpc(configStore)
    this.worktreeSettingsIpc = new ServiceWorktreeSettingsIpc(
      configStore,
      (projectPath) => this.projects.authorizeProjectPath(projectPath),
    )
    this.fileChangesSettingsIpc = new ServiceFileChangesSettingsIpc(configStore)
    this.fileDiffWorker = new FileDiffWorker(context.fileDiffWorkerPath)
    // The project manager's view, not one of its own: it is the only one in this process whose
    // Codex index carries a memo, and the resolve happens on every read this manager makes.
    this.fileChanges = new FileChangesManager({
      diffExecutor: this.fileDiffWorker,
      transcriptResolver: this.projects.transcripts,
    })
    this.fileViewer = new FileViewer()
    this.fileViewerProtocol = new FileViewerProtocol(this.fileViewer)
    this.uiSettingsIpc = new ServiceUiSettingsIpc(
      configStore,
      () => this.broadcast('ui:settings-changed'),
    )
    // The menu is the only surface whose keys are BUILT rather than drawn, so a save has to rebuild
    // it here; every window that prints a key reads the section back over the event.
    this.keyboardSettingsIpc = new ServiceKeyboardSettingsIpc(
      configStore,
      () => {
        this.menu.install()
        this.broadcast('keyboard:settings-changed')
      },
    )
    this.rateMonitor = new RateMonitor({
      configIdentity,
      channel,
      // The same path the session snapshot takes: every workspace window draws the widget and the
      // Debug window draws the section, and the monitor only says this when the content moved.
      onChanged: () => this.broadcast('rate:changed'),
      onError: (message) => this.report(message),
    })
    this.rateMonitorIpc = new ServiceRateMonitorIpc(this.rateMonitor)
    this.agentSettingsIpc = new ServiceAgentSettingsIpc(
      configStore,
      () => this.broadcast('agents:settings-changed'),
    )
    this.sessions = new SessionManager({
      // Electron's app path is this package; `app-host` stands beside it. It is named here rather
      // than measured in the library, which is bundled into `out/main` and can only measure that.
      applicationRoot,
      // The other place a Host can come from, and the only composer that has one: an installed
      // client ships the Host as a bundle under `resources/host`. In a development run there is no
      // such bundle - `process.resourcesPath` then names Electron's own resources - so it is `null`
      // and the source entry beside `applicationRoot` is what starts.
      resourcesRoot: app.isPackaged ? process.resourcesPath : null,
      configDir: context.config.configDir,
      configIdentity,
      channel,
      autoStartHost: !context.smoke,
      onChanged: () => this.sessionsChanged(),
      onError: (message) => this.report(message),
      // Read per launch rather than captured once: `readSection` re-reads whenever the file's mtime
      // moved, so the switch in the tab reaches the next launch without a notification of its own.
      // The same shape and the same reason as `yoloFor` below: read per operation, so switching
      // the mode in the tab reaches the next one without a notification of its own.
      versioningModeOf: () => configStore.readSection(VersioningSettingsSection.spec).mode,
      platformSettingsOf: () => configStore.readSection(WorktreeSettingsSection.spec),
      yoloFor: (agentId) =>
        AgentSettings.yoloFor(configStore.readSection(AgentSettingsSection.spec), agentId),
      modelFor: (agentId) =>
        AgentSettings.modelFor(configStore.readSection(AgentSettingsSection.spec), agentId),
      effortFor: (agentId) =>
        AgentSettings.effortFor(configStore.readSection(AgentSettingsSection.spec), agentId),
      // One view for the whole client: it holds nothing, so a second instance would buy nothing
      // either. Which VCS is preferred is read per probe for the same reason the two above are.
      vcsStatusView: new VcsStatusView(),
      preferredVcsOf: () => configStore.readSection(FileChangesSettingsSection.spec).primaryVcs,
      // The same view the two transcript readers below take, for the same reason: resolving a Codex
      // rollout is not free, and a view of one's own has no memo behind its index.
      transcripts: this.projects.transcripts,
    })
    this.sessionsIpc = new ServiceSessionsIpc(this.sessions)
    // Each reader is handed over rather than held: there is no timer to stop and no child to end.
    // The transcript view is the project manager's, because resolving a Codex rollout is not free -
    // a view of one's own has no memo behind its index, and this pair is POLLED.
    this.sessionModelIpc = new ServiceSessionModelIpc(
      new SessionModelReader({ transcripts: this.projects.transcripts }),
      this.sessions,
    )
    const transcriptReader = new SessionTranscriptReader({ transcripts: this.projects.transcripts })
    const transcriptAccess = new SessionTranscriptAccess(this.sessions, transcriptReader)
    this.sessionTranscriptIpc = new ServiceSessionTranscriptIpc(transcriptAccess)
    const workspaceOwnerIdOf = (sender: WebContents): string | null =>
      this.workspaceWindows.acceptsRenderer(sender)
        ? this.workspaceWindows.windowIdOf(sender)
        : null
    const remarkableCredentialStore = new RemarkableCredentialStore(
      ClientStatePaths.remarkableCredentialFile(configIdentity, channel),
      configIdentity,
      channel,
      {
        available: async () => await safeStorage.isAsyncEncryptionAvailable(),
        encrypt: async (value) => await safeStorage.encryptStringAsync(value),
        decrypt: async (value) => await safeStorage.decryptStringAsync(value),
      },
    )
    const remarkableInstaller = new RemarkableSidecarInstaller({
      sourceDirectory: RemarkableSidecarSource.resolve(
        app.isPackaged,
        applicationRoot,
        process.resourcesPath,
      ),
      toolsDirectory: ClientStatePaths.remarkableToolsDirectory(),
    })
    this.remarkable = new RemarkableManager({
      readSettings: () => configStore.readSection(RemarkableSettingsSection.spec),
      readStorage: () => configStore.readSection(RemarkableStorageSection.spec),
      workingContext: (sessionId) => this.sessions.workingContext(sessionId),
      credentialStore: remarkableCredentialStore,
      installer: remarkableInstaller,
      cli: new RemarkableCli({ executable: remarkableInstaller }),
      runStore: new RemarkableRunStore({
        runsDirectory: ClientStatePaths.remarkableRunsDirectory(configIdentity, channel),
        importsDirectory: ClientStatePaths.remarkableImportsDirectory(configIdentity, channel),
      }),
    })
    this.remarkableIpc = new ServiceRemarkableIpc(
      this.remarkable,
      configStore,
      remarkableCredentialStore,
      workspaceOwnerIdOf,
    )
    this.fileChangesIpc = new ServiceFileChangesIpc(
      this.fileChanges,
      this.fileViewer,
      this.sessions,
      configStore,
      workspaceOwnerIdOf,
    )
    const commitGit = new GitInvoker()
    const checkpointStore = new GitCheckpointStore(commitGit)
    this.commits = new VersioningCommitManager({
      sessions: this.sessions,
      vcsStatus: new VcsStatusView(),
      checkpointStore,
      fileAccess: (owner, snapshot, file) => this.fileChangesIpc.ownedFileAccess(owner, snapshot, file),
      snapshotOf: (owner, snapshot) => this.fileChangesIpc.ownedWorkingTreeSnapshot(owner, snapshot),
      git: new GitCommitManager(commitGit),
      svn: new SvnCommitManager({ svn: new SvnInvoker(), git: commitGit, checkpointStore }),
      onChanged: () => this.broadcast('versioning:commit-changed'),
    })
    this.versioningCommitIpc = new ServiceVersioningCommitIpc(this.commits, workspaceOwnerIdOf, this.fileChangesIpc, async (sessionId, vcs, scope) => {
      const info = this.sessions.snapshot().sessions.find((session) => session.sessionId === sessionId)
      if (info?.life !== 'live') return { ok: false, error: { code: 'not-found', detail: 'The session is not live' } }
      return this.tabControlBroker.openCommit(sessionId, info.tabTitle, vcs, scope ?? null, null, { plain: info.presentation === 'tab', showRefusal: true })
    }, new ExternalDiffLauncher({
      readBaseline: (request) => this.fileChanges.readBaseline(request),
      fileAccess: (owner, snapshot, file) => this.fileChangesIpc.ownedFileAccess(owner, snapshot, file),
      toolOf: () => configStore.readSection(VersioningSettingsSection.spec).diffTool,
      reportError: (detail) => AppClientUiReport.error(detail),
    }))
    this.terminalDetector = new TerminalDetector({
      workingContext: (sessionId) => this.sessions.workingContext(sessionId),
      // Names only. What an agent wrote about narrows which file a half-written token means, and it
      // authorizes opening none of them: every open still goes the file viewer's proven way.
      changedPaths: (context) => this.changedPathHints(context),
    })
    this.tabControlBroker = new TabControlBroker(
      this.workspaceWindows,
      this.panelIndex,
      new TabFileOpenResolver(this.sessions, this.fileViewer, this.terminalDetector),
      this.commits,
    )
    this.fileViewerIpc = new ServiceFileViewerIpc(
      this.fileViewer,
      this.sessions,
      workspaceOwnerIdOf,
      (ownerId, source, supportsDiff) =>
        this.fileChangesIpc.restoreExternal(ownerId, source, supportsDiff),
      // A detected panel proves itself again out of the register of opens, which lives as long as
      // this process and no longer: after a restart nothing proves it and the refusal says so
      // rather than letting a stored path reopen itself unchecked.
      (ownerId, source, supportsDiff) =>
        this.terminalDetector.wasOpened(source.path)
          ? this.fileViewer.openDetected(ownerId, source.sessionId, null, source.path, supportsDiff)
          : Promise.resolve({
            ok: false as const,
            code: 'proof-expired' as const,
            detail: DetectionRefusal.detailOf('file'),
          }),
      (path) => this.terminalDetector.wasOpened(path),
    )
    this.tabsIpc = new ServiceTabsIpc(
      this.workspaceWindows,
      this.panelIndex,
      this.transferBroker,
      this.tabControlBroker,
      () => this.tabsPresenceChanged(),
    )
    this.terminalsIpc = new ServiceTerminalIpc(
      this.sessions,
      (sender) => this.workspaceWindows.acceptsRenderer(sender),
    )
    this.terminalMenuIpc = new ServiceTerminalMenuIpc(
      this.terminalDetector,
      this.fileViewer,
      this.sessions,
      this.terminalsIpc,
      workspaceOwnerIdOf,
    )
    this.pingLoop = new HostPingLoop({
      ping: () => this.sessions.pingHost(),
      // To the Debug window alone: it asked for it, and the workspace has nowhere to put it.
      publish: (result) => this.debugWindow.publish('debug:host-ping-result', result),
    })
    this.debugIpc = new ServiceDebugIpc({
      debugStatusOf: () => this.sessions.debugStatus(),
      pingHost: () => this.sessions.pingHost(),
      sectionActive: (section) => this.pingLoop.setActiveSection(section),
    })
    this.menu = new AppMenu(
      (id) => this.runMainCommand(id),
      (id) => this.publishRendererCommand(id),
      (windowId) => this.workspaceWindows.focusOrRecreate(windowId),
      () => configStore.readSection(KeyboardSettingsSection.spec).launcherKeys,
    )
    this.appRestart = new AppRestart({
      devRendererUrl: context.rendererDevUrl,
      // Electron's app path is this package, which is where the dev pipeline must start.
      packageDir: app.getAppPath(),
      logFile: join(app.getPath('userData'), 'restart-dev.log'),
      report: (message) => this.report(message),
      relaunch: () => app.relaunch(),
      quit: () => app.quit(),
    })
    this.updateManager = new UpdateManager({
      // The workspace in front, main when the menu was reached some other way: the questions belong
      // over the window the person is looking at.
      parentWindowOf: () =>
        (this.workspaceWindows.focusedWorkspace() ?? this.workspaceWindows.main()).windowHandle(),
    })
    // Here rather than in `initialize`: the flags decide what the updater does the first time
    // anything touches it, and the `error` listener is what keeps an emitted failure from throwing.
    this.updateManager.wire()
    const remoteIdentity = {
      configIdentity,
      runtimeChannel: channel,
      instanceId: randomUUID(),
      startedAt: Date.now(),
      applicationVersion: context.appVersion,
    }
    const remoteTerminal = new RemoteControlTerminal(this.sessions, {
      onError: (message) => this.report(message),
    })
    const remoteControl = new RemoteControl({
      system: { identity: () => remoteIdentity },
      projects: this.projects,
      sessions: this.sessions,
      tabs: this.tabControlBroker,
      terminal: remoteTerminal,
      transcript: transcriptAccess,
      // The answer is composed HERE, from this computer's settings and this computer's catalog: a
      // controller asking what to start an agent on is asking about the machine that will run it,
      // and its own list would name the CLI versions of the wrong one. Read per call for the same
      // reason `yoloFor` is - the settings tab reaches the next question without a notification.
      agents: {
        describe: () => {
          const settings = configStore.readSection(AgentSettingsSection.spec)
          return {
            agents: AppHub.describedAgentsConst.map((agentId) => ({
              agentId,
              configuredModel: AgentSettings.modelFor(settings, agentId) ?? null,
              models: AgentModels.optionsFor(agentId).map((option) => ({
                id: option.id,
                label: option.label,
                kind: option.kind,
                context: option.context,
                efforts: option.efforts,
                ...(option.note === undefined ? {} : { note: option.note }),
              })),
            })),
          }
        },
      },
      onError: (message) => this.report(message),
    })
    const credentials = RemotePeerCredentialStore.loadOrCreate(
      ClientStatePaths.remotePeerCredentialsFile(),
      ClientStatePaths.remoteMachineIdentityFile(),
    )
    const peerIdentity = RemoteEndpointIdentityStore.loadOrCreate(
      ClientStatePaths.remoteEndpointIdentityFile(configIdentity, channel),
      credentials.machineIdentity(),
      configIdentity,
      channel,
    ).identity(credentials.machineIdentity())
    this.remoteListenerSettings = () =>
      configStore.readSection(RemoteControlSettingsSection.spec).listener
    this.remotePairing = new RemoteControlPairingManager(
      configStore,
      credentials,
      peerIdentity,
      ClientStatePaths.remotePairingBundleFile(configIdentity, channel),
      (request) => this.dialogIpc.confirmPairing(
        this.workspaceWindows.main().windowHandle(),
        request,
      ),
    )
    const peerClient = new RemoteControlPeerClient(
      peerIdentity,
      (payload) => credentials.sign(payload),
      { onError: (message) => this.report(message) },
    )
    this.remoteConnections = new RemoteConnectionsManager({
      identity: peerIdentity,
      profiles: () => configStore.readSection(RemoteControlSettingsSection.spec).profiles,
      connect: (profile) => peerClient.connect(profile),
      onChanged: () => this.remoteChanged(),
      onError: (message) => this.report(message),
    })
    this.remoteInbound = new RemoteControlInboundRegistry({
      control: remoteControl,
      terminal: remoteTerminal,
      auditFile: ClientStatePaths.controlAuditFile(configIdentity, channel),
      onChanged: () => this.remoteChanged(),
      onError: (message) => this.report(message),
    })
    this.remoteInboundApproval = new RemoteInboundApprovalManager({
      credentials,
      confirm: (request) => this.dialogIpc.confirmInboundAccess(
        this.workspaceWindows.main().windowHandle(),
        request,
      ),
      onChanged: () => this.remoteChanged(),
      onError: (message) => this.report(message),
    })
    this.remoteListener = new RemotePeerListenerManager({
      serverFactory: () => new RemoteControlPeerServer({
        identity: peerIdentity,
        sign: (payload) => credentials.sign(payload),
        trustedInbound: (remoteComputerId, remoteEndpointId) =>
          credentials.trustedInbound(remoteComputerId, remoteEndpointId),
        onConnection: (connection) => this.remoteInbound.add(connection),
        onUnknownPeer: (claimant, remoteAddress) =>
          this.remoteInboundApproval.request(claimant, remoteAddress),
        pairingBundleText: () => {
          try { return JSON.stringify(this.remotePairing.bundle()) } catch { return null }
        },
        onError: (message) => this.report(message),
      }),
      onBound: (host, port) => this.publishPairingEndpoint(host, port),
      onChanged: () => this.remoteChanged(),
    })
    this.remoteControlServer = new RemoteControlServer({
      identity: remoteIdentity,
      control: remoteControl,
      terminal: remoteTerminal,
      descriptorFile: ClientStatePaths.controlInstanceDescriptorFile(
        configIdentity,
        channel,
        remoteIdentity.instanceId,
        remoteIdentity.startedAt,
      ),
      compatibilityDescriptorFile: ClientStatePaths.controlDescriptorFile(configIdentity, channel),
      instanceStore: new RemoteControlInstanceStore(
        RemoteControlInstanceRegistry.fileOf(
          configIdentity,
          channel,
          remoteIdentity.instanceId,
          remoteIdentity.startedAt,
        ),
      ),
      auditFile: ClientStatePaths.controlAuditFile(configIdentity, channel),
      onError: (message) => this.report(message),
      local: {
        snapshot: () => ({
          revision: this.remoteRevision,
          outbound: this.remoteConnections.snapshot().outbound,
          inbound: this.remoteInbound.snapshot(),
        }),
        execute: (remoteEndpointId, request) =>
          this.remoteConnections.execute(remoteEndpointId, request),
        pairingBundle: () => this.remotePairing.bundle(),
        importPairing: async (bundle) => {
          const imported = await this.remotePairing.import(bundle)
          if (imported.ok) {
            this.remoteConnections.reloadProfiles()
            return { ok: true, value: imported.value }
          } else if (imported.code === 'config-refused')
            return { ok: false, error: { code: 'operation-failed', detail: imported.detail } }
          else if (imported.code === 'invalid-bundle')
            return { ok: false, error: { code: 'invalid-request', detail: imported.detail } }
          else if (imported.code === 'identity-conflict')
            return { ok: false, error: { code: 'conflict', detail: imported.detail } }
          // Refused by the person at the machine, which is a refusal and not a fault: the CLI says
          // so plainly rather than reporting something that looks like a bug.
          else if (imported.code === 'not-confirmed')
            return { ok: false, error: { code: 'forbidden', detail: imported.detail } }
          // Not reachable over the control API, which takes a bundle and never an address; named
          // anyway, because a code with no arm here would reach the CLI as a thrown sentence.
          else if (imported.code === 'probe-failed')
            return { ok: false, error: { code: 'unavailable', detail: imported.detail } }
          else
            throw new Error(`Unknown pairing import result: ${JSON.stringify(imported)}`)
        },
      },
    })
    this.remoteIpc = new ServiceRemoteControlIpc(
      this.remoteConnections,
      this.remoteInbound,
      {
        revision: () => this.remoteRevision,
        acceptsRenderer: (sender) => this.workspaceWindows.acceptsRenderer(sender),
      },
    )
    this.remoteSettingsIpc = new ServiceRemoteSettingsIpc({
      configStore,
      identity: peerIdentity,
      listener: this.remoteListener,
      lifecycle: new RemoteProfileLifecycle({
        configStore,
        connections: this.remoteConnections,
      }),
      pairing: this.remotePairing,
      credentials,
      inbound: this.remoteInbound,
      connections: this.remoteConnections,
      onChanged: () => this.remoteChanged(),
    })
    this.skillLinks = new SkillLinkInstaller({
      repoRoot: applicationRoot,
      homeRoot: homedir(),
      ...(process.env.CODEX_HOME === undefined ? {} : { codexHome: process.env.CODEX_HOME }),
      report: (message) => this.report(`Skill link: ${message}`),
    })
  }

  initialize(): void {
    // Handlers before the window: the renderer's first call must not reach an empty channel.
    this.shellIpc.initialize()
    this.windowsIpc.initialize()
    this.dialogIpc.initialize()
    this.clipboardIpc.initialize()
    this.projectsIpc.initialize()
    this.sessionsIpc.initialize()
    this.remoteIpc.initialize()
    this.remoteSettingsIpc.initialize()
    this.tabsIpc.initialize()
    this.terminalsIpc.initialize()
    this.terminalMenuIpc.initialize()
    this.debugIpc.initialize()
    this.versioningSettingsIpc.initialize()
    this.versioningCommitIpc.initialize()
    this.worktreeSettingsIpc.initialize()
    this.fileChangesSettingsIpc.initialize()
    this.fileChangesIpc.initialize()
    this.fileViewerIpc.initialize()
    this.fileViewerProtocol.initialize()
    this.remarkableIpc.initialize()
    this.uiSettingsIpc.initialize()
    this.keyboardSettingsIpc.initialize()
    this.agentSettingsIpc.initialize()
    this.contextCompactionIpc.initialize()
    this.rateMonitorIpc.initialize()
    this.sessionModelIpc.initialize()
    this.sessionTranscriptIpc.initialize()
    this.menu.install()
    this.workspaceWindows.restoreAtStart()
    this.skillLinks.install()
    void this.remoteControlServer.start().catch((error: unknown) =>
      this.report(`Remote control server could not start: ${ErrorText.of(error)}`))
    this.remoteConnections.start()
    // Reports its own failure, the same as the three starts below it: a listener that cannot bind
    // leaves the client working and says so in its own state.
    void this.startRemoteListener()
    // Finishing an interrupted rename is not worth delaying the window for, and it reports its own
    // failures; a rejection here would only mean the sweep itself is broken.
    void this.projects.start()
    // Same reasoning, and the manager reports through the same channel: reaching the Host, reading
    // what it has and possibly starting one all take longer than a window should wait for.
    void this.sessions.start()
    // The cache first, and then a live read of whatever it could not answer for. The windows are
    // already up by this line, so a provider whose cached success is older than one interval is read
    // now, and on a machine with no cache at all that is both of them. The monitor reports its own
    // failures.
    void this.rateMonitor.start()
  }

  /**
   * Detach: the socket closes and the controller lease is released if it still can be. Nothing is
   * stopped and no record is rewritten, so a client killed hard is not a worse outcome - it only
   * leaves the lease to expire by its TTL, and every PTY belongs to the Host either way.
   */
  async dispose(): Promise<void> {
    this.remarkable.beginStop()
    this.fileDiffWorker.beginStop()
    this.remoteControlServer.beginStop()
    this.remoteListener.beginStop()
    this.remoteConnections.stop()
    // reMarkable first because it may be waiting for an atomic copy or a child; the monitor remains
    // before the two servers because it owns a Codex app-server child. Every step is guarded, so a
    // rejection costs its own step and no other.
    await this.settleStep('the reMarkable manager', () => this.remarkable.stop())
    await this.settleStep('the file diff worker', () => this.fileDiffWorker.stop())
    await this.settleStep('the rate monitor', () => { this.rateMonitor.stop() })
    await this.settleStep('the control server', () => this.remoteControlServer.stop())
    await this.settleStep('the peer listener', () => this.remoteListener.stop())
    await this.settleStep('the inbound registry', () => { this.remoteInbound.stop() })
    await this.settleStep('the session manager', () => this.sessions.stop())
  }

  private async settleStep(subject: string, run: () => void | Promise<void>): Promise<void> {
    try {
      await run()
    } catch (error) {
      AppClientUiReport.error(`${subject} did not stop cleanly: ${ErrorText.of(error)}`)
    }
  }

  beginQuit(): void {
    this.remarkable.beginStop()
    this.fileDiffWorker.beginStop()
    this.remoteControlServer.beginStop()
    this.remoteListener.beginStop()
    this.remoteConnections.stop()
    this.transferBroker.cancelAll()
    this.tabControlBroker.cancelAll()
    this.workspaceWindows.beginQuit()
  }

  /**
   * Spreading a tuple of table types gives their intersection, so the merged value carries a key for
   * every channel any service claims and `satisfies` can be read against the whole contract.
   *
   * It runs when this class is first loaded rather than at `initialize`, which is earlier than the
   * boot check it replaces: a duplicate is a programming mistake and there is nothing to be gained
   * from letting the process reach a window first.
   */
  private static mergedChannelsOf<T extends readonly Record<string, true>[]>(
    tables: T,
  ): MergedChannels<T> {
    const merged: Record<string, true> = {}
    for (const table of tables)
      for (const channel of Object.keys(table)) {
        if (channel in merged)
          throw new Error(`Two IPC services claim the same channel: ${channel}`)
        merged[channel] = true
      }
    return merged as MergedChannels<T>
  }

  /** What a second launch of the same {configIdentity, channel} gets instead of a second window. */
  focusWindow(): void {
    this.workspaceWindows.main().focus()
  }

  /**
   * Held for a moment because `list()` puts a snapshot into a store bounded at 32 that drops the
   * oldest first, and the one made for a detection is owned by nobody: without this, a run of right
   * clicks evicts the owner-bound snapshots that open File Changes and diff panels depend on.
   */
  private async changedPathHints(context: FileChangesContext): Promise<TerminalDetectorPathHints> {
    const now = Date.now()
    for (const [key, entry] of this.changedPathHintCache)
      if (entry.expiresAt <= now) this.changedPathHintCache.delete(key)
    const cacheKey = `${context.sessionId}\0${context.cwd}`
    const held = this.changedPathHintCache.get(cacheKey)
    if (held !== undefined) return await held.hints
    // The PROMISE is what is held, not its answer: a second right click while the first list is
    // still running would otherwise miss, call `list()` again and push a second snapshot into
    // the same bounded ring - the eviction this cache exists to prevent, from two clicks.
    const hints = this.readChangedPathHints(context)
    this.changedPathHintCache.set(cacheKey, { expiresAt: Number.POSITIVE_INFINITY, hints })
    // Dated when it settles rather than when it was asked for, or a slow list spends its whole
    // life before anyone can be handed it.
    void hints.then(
      () => this.dateChangedPathHints(cacheKey),
      () => this.changedPathHintCache.delete(cacheKey),
    )
    return await hints
  }

  private async readChangedPathHints(
    context: FileChangesContext,
  ): Promise<TerminalDetectorPathHints> {
    const snapshot = await this.fileChanges.list(context)
    if (!snapshot.ok) return []
    const historical = snapshot.value.history.groups.flatMap((group) => group.entries)
    return [...snapshot.value.entries, ...historical].map((entry) => ({ path: entry.path }))
  }

  private dateChangedPathHints(cacheKey: string): void {
    const entry = this.changedPathHintCache.get(cacheKey)
    if (entry === undefined) return
    entry.expiresAt = Date.now() + AppHub.changedPathHintTtlMillisecondsConst
  }

  /**
   * A state file this process cannot read is the user's problem, not only the log's: the renderer
   * puts it on the console of the window they are looking at, and the console of a packaged main
   * process is not.
   */
  private report(message: string): void {
    AppClientUiReport.error(`${message}`)
    this.broadcast('app:error', message)
  }

  /**
   * What every workspace and Debug are entitled to hear: the snapshot moved, the font scales moved,
   * and something failed. The scales are here rather than on one workspace because every document
   * draws text.
   * `menu:command` is not on this path - the Debug window registers no renderer command, and a role
   * command acts on whichever window has the focus by itself. Publishing into a closed window is a
   * no-op.
   */
  private broadcast<K extends keyof AppClientUiIpcEventMap>(
    channel: K,
    ...args: AppClientUiEventArgs<K>
  ): void {
    this.workspaceWindows.broadcast(channel, ...args)
    this.debugWindow.publish(channel, ...args)
  }

  /**
   * The cadence follows whether ANYTHING can be seen. A hidden workspace with the Debug window open
   * keeps the two-second poll, which is the whole reason that window exists; both out of sight is
   * fifteen seconds, exactly as before there was a second one.
   */
  private workspaceWindowCreated(windowId: string): void {
    this.visibleWorkspaceWindowIds.add(windowId)
    this.updateWindowMenu()
    this.refreshVisibilityConsumers()
  }

  private workspaceVisibilityChanged(windowId: string, visible: boolean): void {
    if (visible)
      this.visibleWorkspaceWindowIds.add(windowId)
    else
      this.visibleWorkspaceWindowIds.delete(windowId)
    this.refreshVisibilityConsumers()
  }

  private workspaceWindowClosed(windowId: string): void {
    this.commits.revokeOwner(windowId)
    this.visibleWorkspaceWindowIds.delete(windowId)
    this.transferBroker.rendererGone(windowId)
    this.tabControlBroker.rendererGone(windowId)
    this.panelIndex.releaseWindow(windowId)
    this.fileChangesIpc.revokeOwner(windowId)
    this.fileViewer.revokeOwner(windowId)
    this.updateWindowMenu()
    this.tabsPresenceChanged()
  }

  private workspaceRendererGone(windowId: string): void {
    this.transferBroker.rendererGone(windowId)
    this.tabControlBroker.rendererGone(windowId)
    this.panelIndex.releaseWindow(windowId)
    this.fileChangesIpc.revokeOwner(windowId)
    this.fileViewer.revokeOwner(windowId)
    this.tabsPresenceChanged()
  }

  private debugVisibilityChanged(visible: boolean): void {
    this.debugVisible = visible
    this.pingLoop.setWindowVisible(visible)
    this.refreshVisibilityConsumers()
  }

  private refreshVisibilityConsumers(): void {
    const anythingVisible = this.visibleWorkspaceWindowIds.size > 0 || this.debugVisible
    this.sessions.setWindowVisible(anythingVisible)
    // The same expression rather than the workspace alone: the Debug window draws the rate section,
    // so it is a surface these numbers are read on.
    this.rateMonitor.setWindowVisible(anythingVisible)
    // Every workspace window, not only main: since the marks moved out of the sessions tree,
    // each window computes its own and a holder that never heard this would keep a mark lit on
    // the tab it is showing. The payload already names the active panel of every visible window.
    this.workspaceWindows.broadcast(
      'tabs:visible-terminal-targets',
      this.panelIndex.visibleTerminalTargetKeys(this.visibleWorkspaceWindowIds),
    )
  }

  private sessionsChanged(): void {
    this.broadcast('sessions:changed')
    this.remoteControlServer.publishEvent('sessions.changed')
    this.remoteInbound.publishEvent('sessions.changed')
  }

  private remoteChanged(): void {
    this.remoteRevision += 1
    this.broadcast('remote:changed')
  }

  private async startRemoteListener(): Promise<void> {
    const listener = this.remoteListenerSettings()
    // The bundle file exists even when nothing is listening: `remote pairing export` has to answer
    // either way. A bind that succeeds rewrites it with the port that was really taken.
    this.publishPairingEndpoint(listener.advertisedHost, listener.port)
    const applied = await this.remoteListener.apply(listener)
    if (!applied.ok)
      this.report(`Remote peer listener could not start: ${applied.detail}`)
  }

  private publishPairingEndpoint(host: string, port: number): void {
    try {
      this.remotePairing.publish({ host, port })
    } catch (error) {
      // A bundle that could not be written costs pairing over the CLI, not the listener that is up.
      this.report(`Remote pairing bundle could not be published: ${ErrorText.of(error)}`)
    }
  }

  private tabsPresenceChanged(): void {
    this.refreshVisibilityConsumers()
    this.remoteControlServer.publishEvent('tabs.changed')
  }

  private updateWindowMenu(): void {
    this.menu.updateWindowEntries(this.workspaceWindows.namedWindows())
  }

  /**
   * Proves the whole composition boots, not just that its dependencies resolve. Waiting for
   * `did-finish-load` alone was not that proof: a preload that threw and a React tree that never
   * mounted both still finish loading. The renderer's own handshake is what closes the gap - it is
   * sent only after the bridge answered and the shell rendered, so it cannot arrive without both.
   * A run that hangs is a failure, so the timeout exits non-zero rather than leaving a headless
   * Electron behind in CI.
   */
  runSmoke(): void {
    const timer = setTimeout(() => {
      AppClientUiReport.error(`smoke timed out; state: ${this.smokeDiagnostics(null)}`)
      app.exit(1)
    }, AppHub.smokeTimeoutMillisecondsConst)
    void this.runSmokePhases()
      .then(() => {
        clearTimeout(timer)
        console.log('SMOKE OK')
        app.exit(0)
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        AppClientUiReport.error(`smoke failed: ${ErrorText.of(error)}`)
        app.exit(1)
      })
  }

  private async runSmokePhases(): Promise<void> {
    await Promise.all([
      this.workspaceWindows.main().whenLoaded(),
      this.workspaceWindows.whenRendererReady('main'),
    ])
    AppHub.assertSmokeIcon('default', WindowIcon.of(null))
    AppHub.assertSmokeIcon('tinted', WindowIcon.of('#336699'))
    await this.checkSmokeFileDiffWorker()
    await this.checkSmokeFileProtocol()

    const before = new Set(this.panelIndex.entries().map((entry) => entry.panelId))
    this.workspaceWindows.publishTo('main', 'menu:command', 'debug.newProbe')
    const created = await this.waitForSmoke(
      'probe creation',
      () => {
        const added = this.panelIndex.entries().filter((entry) => !before.has(entry.panelId))
        if (added.length > 1)
          throw new Error(`Smoke probe creation added several panels: ${JSON.stringify(added)}`)
        return added[0] ?? null
      },
      null,
    )
    if (created.windowId !== 'main')
      throw new Error(`Smoke probe was created outside main: ${JSON.stringify(created)}`)

    await this.waitForSmoke(
      'main durable add',
      () => this.smokeLayoutContains('main', created.panelId) ? true : null,
      created.panelId,
    )
    this.workspaceWindows.publishTo('main', 'menu:command', 'tab.moveToNewWindow')
    const owner = await this.waitForSmoke(
      'move to holder',
      () => {
        const current = this.panelIndex.ownerOf(created.panelId)
        if (current === null || current === 'main')
          return null
        if (!this.smokeLayoutContains(current, created.panelId))
          return null
        if (this.smokeLayoutContains('main', created.panelId))
          return null
        return current
      },
      created.panelId,
    )
    const mainRenderer = this.workspaceWindows.webContentsId('main')
    const holderRenderer = this.workspaceWindows.webContentsId(owner)
    if (mainRenderer === null || holderRenderer === null || mainRenderer === holderRenderer)
      throw new Error(`Smoke renderer identities are not distinct: ${this.smokeDiagnostics(created.panelId)}`)
  }

  private async checkSmokeFileDiffWorker(): Promise<void> {
    const before = Array.from({ length: 611 }, (_, index) => `before ${index + 1}`).join('\n')
    const after = Array.from({ length: 611 }, (_, index) => `after ${index + 1}`).join('\n')
    const startedAt = Date.now()
    let completed = false
    const execution = this.fileDiffWorker.execute({ before, after }).then((result) => {
      completed = true
      return result
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (completed)
      throw new Error('Smoke file diff completed on the main event-loop turn')
    const result = await execution
    const elapsedMilliseconds = Date.now() - startedAt
    if (result.kind === 'work-limit')
      throw new Error('Smoke file diff exceeded its work limit')
    else if (result.kind === 'computed') {
      if (result.hunks.length !== 1
        || result.hunks[0]?.beforeLines !== 611
        || result.hunks[0]?.afterLines !== 611)
        throw new Error(`Smoke file diff returned unexpected hunks: ${JSON.stringify(result.hunks)}`)
      if (elapsedMilliseconds >= 2_000)
        throw new Error(`Smoke file diff took ${elapsedMilliseconds} ms`)
    }
    else
      throw new Error(`Unknown smoke file diff result: ${JSON.stringify(result)}`)
  }

  private async checkSmokeFileProtocol(): Promise<void> {
    const path = process.env.JAMAT_V3_SMOKE_MEDIA_PATH
    if (!path)
      throw new Error('Smoke media path is missing')
    const opened = await this.fileViewer.openWorkspace('main', 'smoke', dirname(path), path)
    if (!opened.ok)
      throw new Error(`Smoke media could not be opened: ${JSON.stringify(opened)}`)
    try {
      const resource = await this.fileViewer.mediaResource('main', opened.value.documentId)
      if (!resource.ok)
        throw new Error(`Smoke media resource could not be issued: ${JSON.stringify(resource)}`)
      const response = await net.fetch(FileViewerProtocolUrl.resource(resource.value.resourceId), {
        headers: { Range: 'bytes=2-5' },
      })
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (response.status !== 206
        || response.headers.get('content-range') !== `bytes 2-5/${resource.value.size}`
        || response.headers.get('content-length') !== '4'
        || bytes.length !== 4)
        throw new Error(`Smoke media range response is invalid: ${JSON.stringify({
          status: response.status,
          contentRange: response.headers.get('content-range'),
          contentLength: response.headers.get('content-length'),
          bytes: [...bytes],
        })}`)
    } finally {
      this.fileViewer.release('main', opened.value.documentId)
    }
  }

  private async waitForSmoke<T>(
    phase: string,
    read: () => T | null,
    panelId: string | null,
  ): Promise<T> {
    const deadline = Date.now() + AppHub.smokePhaseTimeoutMillisecondsConst
    while (Date.now() < deadline) {
      const value = read()
      if (value !== null)
        return value
      await new Promise<void>((resolve) => setTimeout(resolve, AppHub.smokePollMillisecondsConst))
    }
    throw new Error(`Smoke phase ${JSON.stringify(phase)} timed out; state: ${
      this.smokeDiagnostics(panelId)}`)
  }

  private smokeLayoutContains(windowId: string, panelId: string): boolean {
    const loaded = this.store.loadLayout(windowId)
    if (loaded.failed)
      throw new Error(`Smoke cannot read layout for ${windowId}`)
    if (loaded.layout === null)
      return false
    const pending: unknown[] = [JSON.parse(loaded.layout)]
    while (pending.length > 0) {
      const value = pending.pop()
      if (value === panelId)
        return true
      if (Array.isArray(value))
        pending.push(...value)
      else if (typeof value === 'object' && value !== null)
        pending.push(...Object.values(value))
    }
    return false
  }

  private smokeDiagnostics(panelId: string | null): string {
    const windowIds = ['main', ...Object.keys(this.store.listExtraWindows())]
    return JSON.stringify({
      panelId,
      entries: this.panelIndex.entries(),
      windows: windowIds.map((windowId) => ({
        windowId,
        webContentsId: this.workspaceWindows.webContentsId(windowId),
        layout: this.store.loadLayout(windowId),
      })),
    })
  }

  private static assertSmokeIcon(label: string, icon: { isEmpty(): boolean }): void {
    if (icon.isEmpty())
      throw new Error(`Smoke ${label} window icon is empty`)
  }

  /**
   * The window in front, which is what Electron's own reload role would have done. This command
   * exists only because that role registers Ctrl+R, the shell's reverse-search, and it keeps the
   * role's meaning: a Debug window whose renderer has stopped answering is reloadable without
   * taking the workspace down with it. Neither in front - the menu was reached some other way - is
   * the workspace, which is the window this shell is for.
   */
  private reloadFocused(): void {
    if (this.debugWindow.focused()) this.debugWindow.reload()
    else (this.workspaceWindows.focusedWorkspace() ?? this.workspaceWindows.main()).reload()
  }

  private publishRendererCommand(id: CommandId): void {
    const descriptor = AppCommands.byId(id)
    if (descriptor.target !== 'renderer')
      throw new Error(`Command is not a renderer command: ${id}`)
    // The event carries an id and nothing else, so a command whose handler reads a required field
    // off its argument cannot travel on it. The catalog forbids such a command the `menu` surface;
    // this is the same rule where the send actually happens.
    if (AppCommands.carriesValue(id))
      throw new Error(`Command needs a value the menu cannot send: ${id}`)
    if (descriptor.windowScope === 'main')
      this.workspaceWindows.main().publish('menu:command', id)
    else if (descriptor.windowScope === 'any')
      (this.workspaceWindows.focusedWorkspace() ?? this.workspaceWindows.main())
        .publish('menu:command', id)
    else
      throw new Error(`Unknown renderer window scope: ${JSON.stringify(descriptor.windowScope)}`)
  }

  /**
   * The main-process half of the dispatch. A role command never arrives here: the menu hands it to
   * Electron whole, so anything else reaching this point is a command with no home.
   */
  /**
   * Guarded, because a menu click is the one way into these with no boundary above it: the IPC
   * path turns everything a handler throws into a refusal the renderer reports, and an exception
   * out of an Electron menu handler has no owner at all - this package installs no
   * `uncaughtException`. A refused extra window is a designed, reportable outcome of a state file
   * this process cannot write; through the menu it used to be a crash box instead.
   */
  private runMainCommand(id: CommandId): void {
    try {
      this.runMainCommandUnguarded(id)
    } catch (error) {
      this.report(`The ${id} command failed: ${ErrorText.of(error)}`)
    }
  }

  private runMainCommandUnguarded(id: CommandId): void {
    if (id === 'app.reload')
      this.reloadFocused()
    else if (id === 'app.restart')
      void this.appRestart.restart()
        .catch((error: unknown) => this.report(`The restart failed: ${ErrorText.of(error)}`))
    else if (id === 'window.new')
      this.workspaceWindows.createHolder()
    else if (id === 'debug.open')
      this.debugWindow.open()
    // Voided rather than awaited: this returns when a person has answered three dialogs, and it
    // reports its own failures rather than rejecting.
    else if (id === 'app.checkForUpdates')
      void this.updateManager.checkInteractive()
    else
      throw new Error(`Command has no main-process handler: ${id}`)
  }

  /**
   * Every session is attempted, and the refusals are collected rather than stopping the run.
   *
   * Stopping at the first one left the ones before it destroyed and the window open, showing tabs
   * for sessions that no longer exist - a state nothing can undo, because a discard is final. The
   * close goes ahead when anything at all was discarded: what could not be discarded is still the
   * Host's and can be reattached, which is the recoverable half of the two.
   */
  private async closePlainSessions(sessionIds: readonly string[]): Promise<boolean> {
    const refused: string[] = []
    for (const sessionId of sessionIds) {
      const answer = await this.sessions.discardPlainSession(sessionId)
      if (!answer.ok)
        refused.push(answer.detail)
    }
    if (refused.length === 0)
      return true
    this.report(refused.length === sessionIds.length
      ? refused[0]!
      : `${refused.length} of ${sessionIds.length} sessions could not be discarded: ${refused.join('; ')}`)
    // Nothing was discarded, so nothing is lost by leaving the window where it is.
    return refused.length !== sessionIds.length
  }
}
