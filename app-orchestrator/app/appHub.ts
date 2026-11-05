import { ServiceControlIpc } from './remoteControl/serviceControlIpc'
import { HostPingLoop } from './debug/hostPingLoop'
import { OriginalTreeRemoval } from './originalTreeRemoval'
import { FileViewerMediaView } from '../../lib-orchestrator/fileViewer/fileViewerMediaView'
import { SessionNotices } from './sessions/sessionNotices'
import { ServiceChannels } from '../../lib-orchestrator/clientApi/serviceChannels'
import { SessionEvents } from './sessions/sessionEvents'
import { SessionAttention } from './attention/sessionAttention'
import { ChangedPathHints } from './terminals/changedPathHints'
import { SessionSharedItems } from './tabs/sessionSharedItems'
import { RemoteSessionContent } from './remoteControl/remoteSessionContent'
import { PairingImport } from './remoteControl/pairingImport'
import { ServiceTabRequestsIpc } from './tabs/serviceTabRequestsIpc'
import type { RemoteControlListenerSettings } from '../../lib-orchestrator/remoteControl/remotePeerListener.types'
import { AccountProblem } from '../../lib-orchestrator/agentAccounts/accountProblem'
import { SessionTaskAccess } from './sessionTasks/sessionTaskAccess'

import { SessionViewItemsStore } from './tabs/sessionViewItemsStore'
import { RemoteContentPages } from './remoteControl/remoteContentPages'
import { RemoteChangesAccess } from './remoteControl/remoteChangesAccess'
import { RemoteSidebarAccess } from './remoteControl/remoteSidebarAccess'
import { RemoteContentAccess } from './remoteControl/remoteContentAccess'
import { RemoteReviewAccess } from './remoteControl/remoteReviewAccess'
import { RemoteSessionViews } from './remoteControl/remoteSessionViews'
import { RemoteSessionActions } from './remoteControl/remoteSessionActions'
import { CatalogSection } from '../../lib-orchestrator/projectManager/catalog/catalogSection'
import { AppClientUiReport } from '../../lib-orchestrator/shared/appClientUiReport'
import { DetectionRefusal } from '../../lib-orchestrator/terminalDetector/detectionRefusal'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ConfigStore } from '../../lib-orchestrator/configStore/configStore'
import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager'
import { VcsStatusView } from '../../lib-orchestrator/fileChangesManager/vcsStatusView'
import { GitCommitManager } from '../../lib-orchestrator/git/gitCommitManager'
import { GitInvoker } from '../../lib-orchestrator/git/gitInvoker'
import { SvnCommitManager } from '../../lib-orchestrator/svn/svnCommitManager'

import { FileViewer } from '../../lib-orchestrator/fileViewer/fileViewer'
import { PastedFileStore } from '../../lib-orchestrator/pastedFiles/pastedFileStore'
import { ProjectManager } from '../../lib-orchestrator/projectManager/projectManager'
import { RateMonitor } from '../../lib-orchestrator/rateMonitor/rateMonitor'
import { AgentCliUpdates } from '../../lib-orchestrator/agentCliUpdates/agentCliUpdates'
import { AgentCliUpdateSources } from '../../lib-orchestrator/agentCliUpdates/agentCliUpdateSources'
import { ServiceAgentCliUpdatesIpc } from './agentCliUpdates/serviceAgentCliUpdatesIpc'
import { RateMonitorSources } from '../../lib-orchestrator/rateMonitor/rateMonitorSources'
import { RemoteControl } from '../../lib-orchestrator/remoteControl/remoteControl'
import { RemoteControlInstanceRegistry } from '../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry'
import { RemoteControlTerminal } from '../../lib-orchestrator/remoteControl/remoteControlTerminal'
import { SessionManager, SessionNotifier } from '../../lib-orchestrator/sessionManager/sessionManager'
import { SessionModelReader } from '../../lib-orchestrator/sessionModelReader/sessionModelReader'
import { SessionTasks } from '../../lib-orchestrator/sessionTasks/sessionTasks'
import { SessionTranscriptReader } from '../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReader'
import { OrchestratorPaths } from '../../lib-orchestrator/shared/orchestratorPaths'
import { FedHostConnection, type HostConnectionSnapshot } from '../../lib-orchestrator/hostClient/hostConnection'
import { TerminalPortClient } from '../../lib-orchestrator/sessionManager/terminalPortClient'
import type { TerminalProcessEvent } from '../../lib-orchestrator/sessionManager/terminalProcess.types'
import type { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths'
import type { ServiceCaller } from '../../lib-orchestrator/clientApi/serviceTransport.types'
import { RunawayTracker } from '../../lib-orchestrator/perfMonitor/runawayTracker'
import type { WorkerPerfSample } from './perf/workerPerfSampler'
import type { PerfMonitor } from '../../lib-orchestrator/perfMonitor/perfMonitor'
import type { PerfNames } from '../../lib-orchestrator/perfMonitor/perfNames'
import type { PerfWorkerName } from '../../lib-orchestrator/perfMonitor/perfRecord.types'
import { SnapinsManager } from '../../lib-orchestrator/snapins/snapinsManager'
import { BuiltInSnapins } from '../../lib-orchestrator/snapins/builtInSnapinsView'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker'
import { SvnWorktreeManager } from '../../lib-orchestrator/svn/svnWorktreeManager'
import { SnapinsOperations } from './snapins/snapinsOperations'
import { SnapinsPorts } from './snapins/snapinsPorts'
import { SnapinsSettingsSection } from './snapins/snapinsSettingsSection'
import { TortoiseCommitDialog } from '../../lib-orchestrator/shared/tortoiseCommitDialog'
import { OpenedPathsStore } from '../../lib-orchestrator/terminalDetector/register/openedPathsStore'
import { TerminalDetector } from '../../lib-orchestrator/terminalDetector/terminalDetector'
import type { AppClientUiEventArgs, AppClientUiIpcEventMap } from '../../lib-orchestrator/clientApi/appClientUiIpc'
import { AgentModels } from '../../lib-orchestrator/clientApi/agentModels'
import { AgentSettings, type AgentSettingsAgentId } from '../../lib-orchestrator/clientApi/agentSettings'
import { ErrorText } from '../../lib-orchestrator/shared/errorText'
import { TerminalTargetCodec } from '../../lib-orchestrator/clientApi/terminalTarget'
import { AgentSettingsSection } from './agents/agentSettingsSection'
import { AgentSettingsOperations } from './agents/agentSettingsOperations'
import { AgentAccounts } from '../../lib-orchestrator/agentAccounts/agentAccounts'
import { builtInAccountProfiles } from '../../lib-orchestrator/agentAccounts/builtInAccountsView'
import { AccountsSection } from './accounts/accountsSection'
import { AccountsOperations } from './accounts/accountsOperations'
import { AutolauncherConnection } from './autolauncher/autolauncherConnection'
import { AutolauncherManager } from './autolauncher/autolauncherManager'
import { AutolauncherTarget } from './autolauncher/autolauncherTarget'
import { WindowsLauncherSetup } from './autolauncher/windowsLauncherSetup'
import { ClientStatePaths } from '../../lib-orchestrator/shared/clientStatePaths'
import { ReviewInteractionAccess } from './versioning/reviewInteractionAccess'
import { VersioningReviewStore } from './versioning/versioningReviewStore'
import { VersioningCommitMessageStore } from './versioning/versioningCommitMessageStore'
import { FinishAttention } from './sessions/finishAttention'
import { AttentionQueue } from './attention/attentionQueue'
import { ServiceAttentionIpc } from './attention/serviceAttentionIpc'
import { SessionMarksAttention } from './attention/sessionMarksAttention'
import { MainCopyUpdateNotice } from './sessions/mainCopyUpdateNotice'
import { ServiceContextCompactionIpc } from './contextCompaction/serviceContextCompactionIpc'
import { DirectoryNotesOperations } from './directoryNotes/directoryNotesOperations'
import { FileDiffWorker } from './fileChanges/diff/fileDiffWorker'
import { FileChangesSettingsOperations } from './fileChanges/fileChangesSettingsOperations'
import { VersioningSettingsOperations } from './versioning/versioningSettingsOperations'
import { ServiceVersioningCommitIpc } from './versioning/serviceVersioningCommitIpc'
import { ExternalDiffLauncher } from './versioning/externalDiffLauncher'
import { VersioningCommitManager } from './versioning/versioningCommitManager'
import { VersioningWorkflowAccess } from './versioning/versioningWorkflowAccess'
import { SessionReviewPortAdapter } from './versioning/sessionReviewPortAdapter'
import { WorktreeSettingsOperations } from './worktrees/worktreeSettingsOperations'
import { VersioningSettings } from '../../lib-orchestrator/versioning/versioningSettings'
import { VersioningSettingsSection } from './versioning/versioningSettingsSection'
import { WorktreeSettingsSection } from './worktrees/worktreeSettingsSection'
import { FileChangesAccess } from './fileChanges/fileChangesAccess'
import { ServiceFileChangesIpc } from './fileChanges/serviceFileChangesIpc'
import { FileViewerAccess } from './fileViewer/fileViewerAccess'
import { ServiceFileViewerIpc } from './fileViewer/serviceFileViewerIpc'
import { TokenUsageWorker } from './tokenUsage/tokenUsageWorker'
import { SvnAssemblyWorker } from './worktrees/svnAssemblyWorker'
import { TokenUsageOperations } from './tokenUsage/tokenUsageOperations'
import { RateMonitorOperations } from './rateMonitor/rateMonitorOperations'
import { SessionNotifyDelivery } from './sessions/sessionNotifyDelivery'
import { RemarkableManager } from './remarkable/remarkableManager'
import { ServiceRemarkableIpc } from './remarkable/serviceRemarkableIpc'
import { RemarkableSettingsSection } from './remarkable/settings/remarkableSettingsSection'
import { RemarkableStorageSection } from './remarkable/settings/remarkableStorageSection'
import { RemarkableCli } from './remarkable/sidecar/remarkableCli'
import { RemarkableSidecarInstaller } from './remarkable/sidecar/remarkableSidecarInstaller'
import { RemarkableSidecarSource } from './remarkable/sidecar/remarkableSidecarSource'
import { RemarkableCredentialStore } from './remarkable/storage/remarkableCredentialStore'
import { RemarkableRunStore } from './remarkable/storage/remarkableRunStore'
import { GatewayOutboundClient } from './remoteControl/gatewayOutboundClient'
import { GatewayPeerClient } from './remoteControl/gatewayPeerClient'
import { PeerWorkService } from './remoteControl/peerWorkService'
import { RemoteControlAudit } from './remoteControl/remoteControlAudit'
import type { PeerProcessIdentity } from '../../lib-orchestrator/remoteControl/peerProcess.types'
import { RemoteSessionSnapshots } from './remoteControl/remoteSessionSnapshots'
import { RemoteControlPairingManager } from './remoteControl/remoteControlPairingManager'
import { RemoteControlServer } from './remoteControl/remoteControlServer'
import { RemoteControlInstanceStore } from './remoteControl/remoteControlInstanceStore'
import { RemoteControlSettingsSection } from './remoteControl/remoteControlSettingsSection'
import { RemoteEndpointIdentityStore } from './remoteControl/remoteEndpointIdentityStore'
import { RemoteInboundApprovalManager } from './remoteControl/remoteInboundApprovalManager'
import { RemotePeerCredentialStore } from './remoteControl/remotePeerCredentialStore'
import { RemoteProfileLifecycle } from './remoteControl/remoteProfileLifecycle'
import { ServiceRemoteSettingsIpc } from './remoteControl/serviceRemoteSettingsIpc'
import { SessionModelOperations } from './sessionModel/sessionModelOperations'
import { SessionTasksOperations } from './sessionTasks/sessionTasksOperations'
import { SessionTranscriptAccess } from './sessionTranscript/sessionTranscriptAccess'
import { HistoricSessionsOperations } from './sessions/historicSessionsOperations'
import { HistoricSessions } from './sessions/history/historicSessions'
import { SkillLinkInstaller } from './skills/skillLinkInstaller'
import type { ScriptRunCollapsed } from '../../lib-orchestrator/clientApi/scriptRunHandOff.types'
import { TabControlBroker } from './tabs/tabControlBroker'
import { TabFileOpenResolver } from './tabs/tabFileOpenResolver'
import { RemoteSessionGroups } from './sessionGroups/remoteSessionGroups'
import { SessionGroupsOperations } from './sessionGroups/sessionGroupsOperations'
import { SessionGroupsSection } from './sessionGroups/sessionGroupsSection'
import { UiSettingsOperations } from './uiSettings/uiSettingsOperations'
import { UiSettingsSection } from './uiSettings/uiSettingsSection'
import type { ShellPort } from '../../lib-orchestrator/shared/shellPort.types'
import type { ServiceTransport } from '../../lib-orchestrator/clientApi/serviceTransport.types'
import type { OrchestratorApi, OrchestratorPresentation } from '../../lib-orchestrator/clientApi/orchestratorApi.types'
import type { ConfigSections } from '../../lib-orchestrator/clientApi/configSections.types'
import type { ProcessCallContext } from '../../lib-orchestrator/shared/processCalls'

import type { OrchestratorRuntime, OrchestratorEvent } from '../../lib-orchestrator/clientApi/orchestratorProcess.types'
export interface OrchestratorTransport { invoke(method: string, args: unknown[], context: ProcessCallContext): Promise<unknown>; event(target: string, name: string, payload: unknown): void }

export class OrchestratorHub {
  private readonly controlIpc: ServiceControlIpc
  private quitting: boolean
  private disposal: Promise<boolean> | null
  private readonly pingLoop: HostPingLoop
  private readonly fileMedia: FileViewerMediaView
  static readonly ipcChannelsConst = ServiceChannels.merge([
    ServiceControlIpc.channelsConst, ServiceRemoteSettingsIpc.channelsConst, ServiceTabRequestsIpc.channelsConst,
    ServiceVersioningCommitIpc.channelsConst, ServiceFileChangesIpc.channelsConst,
    ServiceFileViewerIpc.channelsConst, ServiceRemarkableIpc.channelsConst,
    ServiceContextCompactionIpc.channelsConst, ServiceAgentCliUpdatesIpc.channelsConst,
    ServiceAttentionIpc.channelsConst,
  ] as const)
  private static readonly describedAgentsConst: readonly AgentSettingsAgentId[] = ['claude', 'codex']

  private readonly notices: SessionNotices
  private readonly sessionEvents: SessionEvents
  private readonly sessionAttention: SessionAttention
  readonly api: OrchestratorApi
  readonly transport: OrchestratorTransport
  private readonly shell: ShellPort
  private readonly serviceTransport: ServiceTransport
  private readonly gatewayCalls: ProcessCalls
  private readonly perf: PerfMonitor
  private readonly configStore: ConfigStore
  private readonly pastedFiles: PastedFileStore
  private readonly autolauncher: AutolauncherManager
  private readonly event: (event: OrchestratorEvent) => void
  private presentation: OrchestratorPresentation
  private readonly gatewayTerminals: TerminalPortClient
  private readonly hostConnection: FedHostConnection
  private hostConnectionDebug: HostConnectionSnapshot['debug'] | null
  private readonly sessionGroups: RemoteSessionGroups
  private readonly tabRequestsIpc: ServiceTabRequestsIpc
  private readonly tabControlBroker: TabControlBroker
  private readonly projects: ProjectManager
  private readonly sessions: SessionManager
  private readonly remoteControlServer: RemoteControlServer
  private readonly remoteControl: RemoteControl
  private readonly remoteConnections: GatewayOutboundClient
  private readonly remoteInbound: GatewayPeerClient
  private readonly peerWork: PeerWorkService
  private readonly peerProcessIdentity: () => PeerProcessIdentity
  private readonly remoteSettingsIpc: ServiceRemoteSettingsIpc
  private readonly remotePairing: RemoteControlPairingManager
  private readonly remoteInboundApproval: RemoteInboundApprovalManager
  private readonly remoteListener: GatewayPeerClient
  private readonly remoteListenerSettings: () => RemoteControlListenerSettings
  private readonly skillLinks: SkillLinkInstaller
  private readonly terminalDetector: TerminalDetector
  private readonly commits: VersioningCommitManager
  private readonly versioningCommitIpc: ServiceVersioningCommitIpc
  private readonly fileDiffWorker: FileDiffWorker
  private readonly svnAssemblyWorker: SvnAssemblyWorker
  private readonly fileChanges: FileChangesManager
  private readonly fileViewer: FileViewer
  private readonly fileChangesAccess: FileChangesAccess
  private readonly fileChangesIpc: ServiceFileChangesIpc
  private readonly remoteChangesAccess: RemoteChangesAccess
  private readonly remoteContentAccess: RemoteContentAccess
  private readonly fileViewerAccess: FileViewerAccess
  private readonly fileViewerIpc: ServiceFileViewerIpc
  private readonly remarkable: RemarkableManager
  private readonly remarkableIpc: ServiceRemarkableIpc
  private readonly settingsOperations: readonly { register(registry: RemoteControl['registry']): void }[]
  private readonly contextCompactionIpc: ServiceContextCompactionIpc
  private readonly directoryNotes: DirectoryNotesOperations
  private readonly rateMonitor: RateMonitor
  private readonly cliUpdates: AgentCliUpdates
  private readonly cliUpdatesIpc: ServiceAgentCliUpdatesIpc
  private readonly tokenUsage: TokenUsageWorker
  private readonly sessionNotifier: SessionNotifier
  private readonly snapins: SnapinsManager
  private readonly finishAttention: FinishAttention
  private readonly attention: AttentionQueue
  private readonly attentionIpc: ServiceAttentionIpc
  private readonly sessionMarks: SessionMarksAttention

  private remoteRevision: number
  private readonly accounts: AgentAccounts

  constructor(runtime: OrchestratorRuntime, shell: ShellPort, transport: ServiceTransport, gatewayCalls: ProcessCalls, perf: PerfMonitor, names: PerfNames, event: (event: OrchestratorEvent) => void) {
    this.presentation = { anythingVisible: false, accepting: [], seen: [], front: null, lastActivePanel: null }
    this.remoteRevision = 0
    this.shell = shell
    this.quitting = false
    this.disposal = null
    this.serviceTransport = transport
    this.gatewayCalls = gatewayCalls
    this.perf = perf
    this.event = event
    const context = runtime
    const applicationRoot = runtime.applicationRoot
    const build = runtime.build
    const configIdentity = runtime.config.identity.configIdentity
    const channel = runtime.config.runtimeChannel
    const perfNames = names

    this.notices = new SessionNotices(shell, id => this.tabTitleOf(id), (...args) => this.tabControlBroker.openWorkflow(...args), message => this.report(message))
    this.sessionEvents = new SessionEvents({
      refreshCommits: () => this.commits?.workflowChanged(),
      wakeSnapins: () => this.snapins?.wake(),
      noticeWaits: () => this.sessionAttention.noticeWaits(),
      attentionSeen: () => this.sessionAttention.seen(this.presentation.seen),
      publishSessions: () => { this.broadcast('sessions:changed'); this.publishProjection() },
      publishControl: () => this.remoteControlServer.publishEvent('sessions.changed'),
      publishInbound: () => this.remoteInbound.publishEvent('sessions.changed'),
      publishActivity: () => this.remoteControl.activity.publish('sessions.changed'),
      titleOf: id => this.tabTitleOf(id), scriptRunCollapsed: (...args) => this.scriptRunCollapsed(...args), report: message => this.report(message),
    })
    this.finishAttention = new FinishAttention({ show: (notice) => {
      this.notices.show(notice)
      this.sessionAttention.queueFinishWait(notice)
    } })
    const workerPerf = (name: PerfWorkerName) => (sample: WorkerPerfSample): void => {
      this.perf.record([{ ...sample, v: 1, at: Date.now(), process: `worker:${name}`, pid: process.pid, build }])
    }
    this.hostConnection = new FedHostConnection()
    this.hostConnectionDebug = null
    this.gatewayTerminals = new TerminalPortClient(this.gatewayCalls, {
      userInput: marks => this.sessions.terminalActivity.userInput(marks),
      pendingInputHint: counts => this.sessions.terminalActivity.pendingInputHint(counts),
    })

    const configStore = this.configStore = ConfigStore.load(context.config.configDir, {
      // Without a snapshots directory the store is read-only and every save throws.
      snapshotsDirectory: OrchestratorPaths.configSnapshotsDirectory(configIdentity, channel),
      report: (message) => this.report(message),
      // Whose the key-less snapshots are is the consumer's to say, and on this machine they are the
      // catalog's: it was the only writer of config.json until `ui` arrived.
      legacySnapshotSection: CatalogSection.spec.key,
    })
    this.projects = new ProjectManager({
      claudeHomes: () => accounts.homesOf('claude'),
      configStore,
      configIdentity,
      channel,
      onError: (message) => this.report(message),
      removeTree: (path, onProgress) => OriginalTreeRemoval.remove(path, onProgress),
    })
    const launcherDirectory = join(dirname(OrchestratorPaths.defaultMachineRoot()), 'JamatLauncher')
    this.autolauncher = new AutolauncherManager({
      configDir: context.config.configDir, configIdentity, runtimeChannel: channel,
      ...AutolauncherTarget.recipe(runtime.isPackaged, applicationRoot, process.execPath,
        process.env.JAMAT_V3_SOURCE_CHECKOUT),
    }, launcherDirectory, process.platform === 'win32', new WindowsLauncherSetup(
      runtime.isPackaged ? join(runtime.resourcesPath, 'launcher') : join(applicationRoot, 'out', 'launcher'),
      launcherDirectory,
    ), new AutolauncherConnection(), snapshot => this.broadcast('autolauncher:changed', snapshot),
    runtime.isPackaged ? join(runtime.resourcesPath, 'launcher', 'node.exe') : join(applicationRoot, 'out', 'launcher', 'node.exe'))
    this.fileDiffWorker = new FileDiffWorker(context.fileDiffWorkerPath, undefined, workerPerf('fileDiff'))
    this.svnAssemblyWorker = new SvnAssemblyWorker(context.svnAssemblyWorkerPath, undefined, workerPerf('svnAssembly'))
    this.fileChanges = new FileChangesManager({
      perf: this.perf,
      diffExecutor: this.fileDiffWorker,
      transcriptResolver: this.projects.transcripts,
    })
    this.fileViewer = new FileViewer()
    this.fileMedia = new FileViewerMediaView(this.fileViewer)
    const sessionGroupsOperations = new SessionGroupsOperations(configStore, this.shell.sessionGroups, () => this.broadcast('state:session-groups-changed'))
    this.settingsOperations = [
      new UiSettingsOperations(configStore,
        () => { this.publishConfigSections(); this.broadcast('ui:settings-changed') },
        ui => this.event({ kind: 'config', value: { ui } })),
      // The same event an assignment sends, because a tree reads both back together: which sections
      // exist and which session is in one are two halves of one picture, and a window that learned
      // about the first alone would redraw with rows still filed under a section it just lost.
      sessionGroupsOperations,
      new AgentSettingsOperations(configStore, () => this.broadcast('agents:settings-changed')),
      new WorktreeSettingsOperations(configStore, (projectPath) => this.projects.authorizeProjectPath(projectPath)),
      new FileChangesSettingsOperations(configStore),
      new VersioningSettingsOperations(configStore),
    ]
    const accounts = new AgentAccounts({
      ...builtInAccountProfiles(process.env),
      accountsRoot: join(context.config.configDir, 'accounts'),
      rates: () => this.rateMonitor?.snapshot().accounts ?? [],
      stored: () => configStore.readSection(AccountsSection.spec),
      store: value => {
        const result = configStore.saveSection(AccountsSection.spec, value)
        if (!result.ok) throw new Error(result.detail)
      },
      login: {
        open: async request => {
          const created = await this.sessions.createCommandSession({ directory: { mode: 'adHoc', path: request.home },
            account: { agentId: request.agentId, accountId: request.accountId }, title: `Login: ${request.label}` }, request.command, request.prepare)
          if (!created.ok) throw new AccountProblem(created.detail)
          await this.tabControlBroker.openTab(created.value.sessionId, created.value.tabTitle, { activate: true })
          return { sessionId: created.value.sessionId }
        },
        result: id => this.sessions.terminalResult(id),
        stop: async id => {
          const stopped = await this.sessions.stopSession(id)
          if (!stopped.ok) throw new AccountProblem(stopped.detail)
        },
      },
      hasRunningSession: (agentId, accountId) => this.sessions.hasAccountSession(agentId, accountId),
      onChanged: () => { this.broadcast('agents:settings-changed'); this.broadcast('usage:changed'); this.rateMonitor?.accountsChanged() },
    })
    this.accounts = accounts
    this.cliUpdates = new AgentCliUpdates(
      AgentCliUpdateSources.create(process.env, join(accounts.homeOf('claude', 'main'), 'settings.json')),
      () => this.broadcast('agentCliUpdates:changed'),
    )
    this.cliUpdatesIpc = new ServiceAgentCliUpdatesIpc(this.cliUpdates)
    const statusLineRates = RateMonitorSources.statusLine(join(OrchestratorPaths.directory(configIdentity, channel), 'rates'),
      (sessionId, launchId, at) => this.sessions.accountForLaunch(sessionId, launchId, at))
    const rolloutRates = RateMonitorSources.rollouts(accounts.homeOf('codex', 'main'), () => accounts.list())
    this.rateMonitor = new RateMonitor({
      perf: this.perf,
      readings: async () => [...await statusLineRates.read(), ...await rolloutRates.read()],
      accounts: () => accounts.list(),
      sourceForAccount: (account, hooks) => RateMonitorSources.forAccount(account,
        accounts.homeOf(account.agentId, account.accountId), hooks, accounts.homeOf(account.agentId, 'main'),
        undefined, read => accounts.withProfile(account.agentId, account.accountId, read)),
      configIdentity,
      channel,
      // The same path the session snapshot takes: every workspace window draws the widget and the
      // Debug tab draws the section, and the monitor only says this when the content moved.
      onChanged: () => { this.broadcast('rate:changed'); this.broadcast('usage:changed'); this.sessions?.ratesChanged() },
      onError: (message) => this.report(message),
    })
    const remoteIdentity = {
      configIdentity,
      runtimeChannel: channel,
      instanceId: randomUUID(),
      startedAt: Date.now(),
      applicationVersion: context.appVersion,
    }
    this.sessions = new SessionManager({
      connection: this.hostConnection,
      connectionDebug: () => {
        if (!this.hostConnectionDebug) throw new Error('Gateway connection diagnostics are not ready')
        return this.hostConnectionDebug
      },
      terminals: this.gatewayTerminals,
      terminalsFeed: this.gatewayTerminals,
      closeTerminals: () => this.gatewayTerminals.close(),
      perf: this.perf,
      accounts,
      rates: () => this.rateMonitor.snapshot().accounts ?? [],
      instanceId: remoteIdentity.instanceId,
      skillRoots: () => this.skillLinks.roots(),
      // Electron's app path is this package; `app-host` stands beside it. It is named here rather
      // than measured in the library, which is bundled into `out/main` and can only measure that.
      applicationRoot,
      // The other place a Host can come from, and the only composer that has one: an installed
      // client ships the Host as a bundle under `resources/host`. In a development run there is no
      // such bundle - `runtime.resourcesPath` then names Electron's own resources - so it is `null`
      // and the source entry beside `applicationRoot` is what starts.
      resourcesRoot: runtime.isPackaged ? runtime.resourcesPath : null,
      configDir: context.config.configDir,
      configIdentity,
      channel,
      autoStartHost: !context.smoke,
      onChanged: () => { accounts.sessionsChanged(); this.sessionEvents.changed() },
      onError: (message) => this.report(message),
      // A session whose worktree ended goes as Remove takes it, and Remove's caller closes the tab.
      onRemovedItself: (sessionId) =>
        this.closeTerminalPanels(TerminalTargetCodec.key({ kind: 'local', sessionId })),
      onMainCopyUpdated: (update) => this.notices.update(MainCopyUpdateNotice.of(update)),
      onScriptCollapsed: (event) => this.sessionEvents.scriptCollapsed(event),
      removeTree: (path, onProgress) => OriginalTreeRemoval.remove(path, onProgress),
      svnAssembly: this.svnAssemblyWorker,
      // Read per launch rather than captured once: `readSection` re-reads whenever the file's mtime
      // moved, so the switch in the tab reaches the next launch without a notification of its own.
      // The same shape and the same reason as `yoloFor` below: read per operation, so switching
      // the mode in the tab reaches the next one without a notification of its own.
      versioningModeOf: () => configStore.readSection(VersioningSettingsSection.spec).mode,
      processPriorityOf: () => AgentSettings.processPriorityOf(configStore.readSection(AgentSettingsSection.spec)),
      platformSettingsOf: () => configStore.readSection(WorktreeSettingsSection.spec),
      yoloFor: (agentId) =>
        AgentSettings.yoloFor(configStore.readSection(AgentSettingsSection.spec), agentId),
      modelFor: (agentId) =>
        AgentSettings.modelFor(configStore.readSection(AgentSettingsSection.spec), agentId),
      effortFor: (agentId) =>
        AgentSettings.effortFor(configStore.readSection(AgentSettingsSection.spec), agentId),
      // The same view the two transcript readers below take, for the same reason: resolving a Codex
      // rollout is not free, and a view of one's own has no memo behind its index.
      transcripts: this.projects.transcripts,
    })
    const modelReader = new SessionModelReader({
      transcripts: this.projects.transcripts,
      claudeContextSnapshots: OrchestratorPaths.claudeContextSnapshotsDirectory(configIdentity, channel),
    })
    const historicSessions = new HistoricSessions(this.projects, this.sessions, modelReader)
    const sessionModel = new SessionModelOperations(modelReader, this.sessions)
    const sessionTasks = new SessionTasksOperations(new SessionTasks(this.projects.transcripts), this.sessions,
      {
        openTask: (tabTitle, item, intentId) => this.tabControlBroker.openTask(tabTitle, item, intentId),
        openWorkflow: (sessionId, tabTitle, intentId) => this.tabControlBroker.openWorkflow(sessionId, tabTitle, intentId),
      })
    const transcriptReader = new SessionTranscriptReader({ transcripts: this.projects.transcripts })
    const transcriptAccess = new SessionTranscriptAccess(this.sessions, transcriptReader)
    const workspaceCallerOwnerIdOf = (caller: ServiceCaller): string | null =>
      this.serviceTransport.isCurrent(caller) && (caller.role === 'main' || caller.role === 'workspace')
        && this.presentation.accepting.includes(caller.windowId) ? caller.windowId : null
    const remarkableCredentialStore = new RemarkableCredentialStore(
      ClientStatePaths.remarkableCredentialFile(configIdentity, channel),
      configIdentity,
      channel,
      this.shell.cipher,
    )
    const remarkableInstaller = new RemarkableSidecarInstaller({
      sourceDirectory: RemarkableSidecarSource.resolve(
        runtime.isPackaged,
        applicationRoot,
        runtime.resourcesPath,
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
      workspaceCallerOwnerIdOf,
    )
    this.fileChangesAccess = new FileChangesAccess(
      this.fileChanges,
      this.fileViewer,
      this.sessions,
      configStore,
    )
    this.fileChangesIpc = new ServiceFileChangesIpc(this.fileChangesAccess, workspaceCallerOwnerIdOf)
    const commitGit = new GitInvoker({ perf: this.perf })
    const reviewInteractions = new ReviewInteractionAccess()
    const externalDiff = new ExternalDiffLauncher({
      readBaseline: (request) => this.fileChanges.readBaseline(request),
      fileAccess: (owner, snapshot, file) => this.fileChangesAccess.ownedFileAccess(owner, snapshot, file),
      toolOf: () => configStore.readSection(VersioningSettingsSection.spec).diffTool,
      reportError: (detail) => AppClientUiReport.error(detail),
    })
    this.commits = new VersioningCommitManager({
      workflow: new VersioningWorkflowAccess(this.sessions, this.sessions.worktreeResultsStore()),
      interactions: reviewInteractions,
      splitReview: async (sessionId, vcs, scopeRoot, operationId) => {
      const title = this.sessions.snapshot().sessions.find((session) => session.sessionId === sessionId)?.tabTitle ?? 'Commit review'
      const answer = await this.tabControlBroker.openCommit(sessionId, title, vcs, scopeRoot, null, { intentId: operationId })
      if (!answer.ok) throw new Error(answer.error.detail)
      if (!answer.value.commitSessionId) throw new Error('The source did not create a separate review')
      return answer.value.commitSessionId
    },
      externalDiff: (owner, request) => externalDiff.launch(owner, request),
      externalDiffAvailable: () => {
        const tool = configStore.readSection(VersioningSettingsSection.spec).diffTool
        return tool.kind === 'external' && VersioningSettings.isDiffTool(tool)
      },
      reviews: new VersioningReviewStore(join(ClientStatePaths.directory(configIdentity, channel), 'commit-reviews.json'), (message) => this.report(message)),
      messages: new VersioningCommitMessageStore(ClientStatePaths.commitMessagesFile(configIdentity, channel), (message) => this.report(message)),
      sessions: this.sessions,
      vcsStatus: new VcsStatusView(),
      fileAccess: (owner, snapshot, file) => this.fileChangesAccess.ownedFileAccess(owner, snapshot, file),
      snapshotOf: (owner, snapshot) => this.fileChangesAccess.ownedWorkingTreeSnapshot(owner, snapshot),
      git: new GitCommitManager(commitGit),
      svn: new SvnCommitManager(this.sessions.svnCommands, (root, paths, work) => this.sessions.withinSvnWrite(root, paths, work)),
      tortoise: new TortoiseCommitDialog(),
      onChanged: () => {
        this.broadcast('versioning:commit-changed')
        this.tabControlBroker.commitsChanged()
        this.remoteControl.activity.publish('commits.changed')
        this.remoteInbound?.publishEvent('sessions.changed')
      },
      committed: (receipt) => this.sessions.noteCommitted(receipt),
    })
    this.versioningCommitIpc = new ServiceVersioningCommitIpc(this.commits, workspaceCallerOwnerIdOf, this.fileChangesAccess, async (sessionId, vcs, scope) => {
      const info = this.sessions.snapshot().sessions.find((session) => session.sessionId === sessionId)
      if (info?.life !== 'live') return { ok: false, error: { code: 'not-found', detail: 'The session is not live' } }
      return this.tabControlBroker.openCommit(sessionId, info.tabTitle, vcs, scope ?? null, null, { showRefusal: true })
    }, reviewInteractions)
    const changedPathHints = new ChangedPathHints(this.fileChanges)
    this.terminalDetector = new TerminalDetector({
      workingContext: (sessionId) => this.sessions.workingContext(sessionId),
      // Names only. What an agent wrote about narrows which file a half-written token means, and it
      // authorizes opening none of them: every open still goes the file viewer's proven way.
      changedPaths: (context) => changedPathHints.read(context),
      register: OpenedPathsStore.load(
        OrchestratorPaths.terminalOpenedPathsFile(configIdentity, channel),
        (message) => this.report(message),
      ),
    })
    const sessionViewItems = new SessionViewItemsStore(join(ClientStatePaths.directory(configIdentity, channel), 'session-view-items.json'), (message) => this.report(message))
    const itemPages = new RemoteContentPages()
    sessionViewItems.subscribe(() => {
      this.event({ kind: 'session-items-changed' })
      this.remoteInbound.publishEvent('tabs.changed')
    })
    const tabFileResolver = new TabFileOpenResolver(this.sessions, this.fileViewer, this.terminalDetector)
    this.attention = new AttentionQueue({
      front: () => this.presentation.front,
      lastActivePanel: () => this.presentation.lastActivePanel,
      focus: async (panelId) => {
        const focused = await this.tabControlBroker.focus(panelId)
        if (!focused.ok) this.report(`The tab before the attention queue could not be brought back: ${focused.error.detail}`)
      },
      idleMilliseconds: () => VersioningSettings.idleMilliseconds(configStore.readSection(VersioningSettingsSection.spec)),
      returnEnabled: () => configStore.readSection(VersioningSettingsSection.spec).returnToPreviousSessionAfterCommit !== false,
      returnWindowMilliseconds: () => VersioningSettings.returnWindowMilliseconds(configStore.readSection(VersioningSettingsSection.spec)),
      onChanged: () => this.broadcast('attention:changed'),
      report: (message) => this.report(message),
    })
    this.attentionIpc = new ServiceAttentionIpc(this.attention)
    this.tabControlBroker = new TabControlBroker(
      this.shell.tabs,
      tabFileResolver,
      this.commits,
      this.attention,
      {
        recordOpen: (open) => sessionViewItems.record(open),
        reportError: (message) => this.report(message),
        activateSessionOnCommit: () => configStore.readSection(VersioningSettingsSection.spec).activateSessionOnCommit !== false,
        activateSessionOnDocument: () => configStore.readSection(UiSettingsSection.spec).activateSessionOnDocument === true,
      },
    )
    this.sessionMarks = new SessionMarksAttention(this.attention, (sessionId, tabTitle) => this.tabControlBroker.showSession(sessionId, tabTitle))
    this.sessionAttention = new SessionAttention(() => this.sessions.snapshot(), this.finishAttention, this.sessionMarks, this.attention, (...args) => this.tabControlBroker.openWorkflow(...args), message => this.report(message))
    this.sessions.setReviewPort(new SessionReviewPortAdapter(this.commits))
    this.fileViewerAccess = new FileViewerAccess({
      viewer: this.fileViewer,
      sessions: this.sessions,
      restoreExternal:
      (ownerId, source, supportsDiff) =>
        this.fileChangesAccess.restoreExternal(ownerId, source, supportsDiff),
      // A detected panel proves itself again out of the register of opens, which main alone writes
      // and keeps across restarts for a week: a stored layout path that it never proved still
      // refuses rather than reopening itself unchecked.
      restoreDetected: (ownerId, source, supportsDiff) =>
        this.terminalDetector.wasOpened(source.path)
          ? this.fileViewer.openDetected(ownerId, source.sessionId, null, source.path, supportsDiff)
          : Promise.resolve({
            ok: false as const,
            code: 'proof-expired' as const,
            detail: DetectionRefusal.detailOf('file'),
          }),
      allowsDetected: (path) => this.terminalDetector.wasOpened(path),
      restoreWorkingTree: (ownerId, source) => this.fileChangesAccess.restoreWorkingTree(ownerId, source),
    })
    const sharedItems = new SessionSharedItems(this.sessions, this.fileViewer, sessionTasks, sessionViewItems)
    this.remoteContentAccess = new RemoteContentAccess(this.fileViewerAccess, this.fileViewer, tabFileResolver, this.sessions)
    this.remoteChangesAccess = new RemoteChangesAccess(this.fileChangesAccess,
      (view, source) => this.remoteContentAccess.allowsSource(view, source),
      (view, source) => this.remoteContentAccess.admitSource(view, source))
    this.fileViewerIpc = new ServiceFileViewerIpc(this.fileViewer, this.fileViewerAccess, workspaceCallerOwnerIdOf)
    this.tabRequestsIpc = new ServiceTabRequestsIpc(this.tabControlBroker, workspaceCallerOwnerIdOf,
      { page: (sessionId, cursor) => sessionViewItems.page(sessionId, cursor),
        open: (owner, sessionId, body) => sharedItems.open(owner, sessionId, body) },
    )
    const pastedFiles = this.pastedFiles = new PastedFileStore(OrchestratorPaths.pastedFilesDirectory(configIdentity, channel))
    const remoteTerminal = new RemoteControlTerminal(this.sessions, this.sessions.terminals, {
      onError: (message) => this.report(message),
      files: pastedFiles,
    })
    this.contextCompactionIpc = new ServiceContextCompactionIpc(remoteTerminal, transcriptAccess)
    this.directoryNotes = new DirectoryNotesOperations(
      configStore,
      this.sessions,
      remoteTerminal,
      (directory) => this.broadcast('directoryNotes:changed', directory),
    )
    const sessionGroups = this.sessionGroups = new RemoteSessionGroups(
      () => configStore.readSection(SessionGroupsSection.spec),
      this.shell.sessionGroups,
      () => this.broadcast('state:session-groups-changed'),
    )
    this.snapins = new SnapinsManager({ definitions: BuiltInSnapins.all({ clientBuild: build,
      directories: [OrchestratorPaths.clientPerfDirectory(configIdentity, channel), HostDescriptorPaths.perfDirectory(configIdentity, channel)],
      hostProcess: () => {
        const { hostPid, hostStartedAt } = this.sessions.processTree()
        return hostPid !== null && hostStartedAt !== null ? { pid: hostPid, startedAt: hostStartedAt } : null
      },
    }), perf: this.perf,
      ports: SnapinsPorts.of({ sessions: this.sessions, svn: new SvnWorktreeManager(new SvnInvoker({ perf: this.perf })),
        projects: this.projects, tabs: this.tabControlBroker,
        versioningMode: () => configStore.readSection(VersioningSettingsSection.spec).mode }),
      settings: () => configStore.readSection(SnapinsSettingsSection.spec),
      presentation: SnapinsPorts.presentation({ groups: sessionGroups, groupsOperations: sessionGroupsOperations, sessions: this.sessions }),
      directory: OrchestratorPaths.snapinsDirectory(configIdentity, channel),
      onChanged: (kind) => this.broadcast('snapins:changed', { kind }), report: (message) => this.report(message),
    })
    this.sessionNotifier = new SessionNotifier({
      sources: [this.sessions.worktreeResultsStore().notifySource(), this.sessions.sessionNotifyStore(), this.sessions.svnWaitNotices(), this.sessions.workerHandoffs(),
        this.commits.notifySource()],
      watch: this.sessions.sessionNotifyStore(),
      sessions: () => this.sessions.snapshot().sessions,
      groups: (sessions) => sessionGroups.read(sessions),
      port: new SessionNotifyDelivery(this.sessions, remoteTerminal, transcriptAccess),
      now: () => Date.now(),
      report: (message) => this.report(message),
    })
    const remoteControl = new RemoteControl({
      perf: this.perf, onRegistered: name => perfNames.registerOperations([name]),
      accounts,
      system: { identity: () => remoteIdentity },
      projects: this.projects,
      sessions: this.sessions,
      host: this.sessions,
      // A create or a repaint may name the section its session is filed under. Read per call, like
      // every other section of the config this object takes: a person may have just edited it.
      groups: sessionGroups,
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
            agents: OrchestratorHub.describedAgentsConst.map((agentId) => ({
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
    this.remoteControl = remoteControl
    this.controlIpc = new ServiceControlIpc(remoteControl.registry)
    HistoricSessionsOperations.register(remoteControl.registry, historicSessions)
    for (const operations of this.settingsOperations) operations.register(remoteControl.registry)
    new SnapinsOperations(this.snapins, configStore).register(remoteControl.registry)
    this.tokenUsage = new TokenUsageWorker(context.tokenUsageWorkerPath, async rescan => ({
      kind: 'scan', rescan, cacheFile: join(OrchestratorPaths.directory(configIdentity, channel), 'token-usage.json'),
      configDir: context.config.configDir, claudeHome: accounts.homeOf('claude', 'main'), codexHome: accounts.homeOf('codex', 'main'),
      records: this.sessions.usageRecords(), accounts: await accounts.list(),
    }), () => this.broadcast('usage:changed'), workerPerf('tokenUsage'))
    new TokenUsageOperations(this.tokenUsage, accounts).register(remoteControl.registry)
    new RateMonitorOperations(this.rateMonitor, this.accounts).register(remoteControl.registry)
    new AccountsOperations(accounts).register(remoteControl.registry)
    sessionModel.register(remoteControl.registry)
    sessionTasks.register(remoteControl.registry)
    this.directoryNotes.register(remoteControl.registry)
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
      this.shell,
    )
    this.remoteConnections = new GatewayOutboundClient(this.gatewayCalls,
      () => configStore.readSection(RemoteControlSettingsSection.spec).profiles,
      () => this.remoteChanged(false),
      (remoteEndpointId, sessionId) =>
        this.closeTerminalPanels(TerminalTargetCodec.key({ kind: 'remote', remoteEndpointId, sessionId })),
    )
    const taskAccess = new SessionTaskAccess(sessionTasks)
    const sessionActions = new RemoteSessionActions(() => this.sessions.snapshot(), remoteControl.registry)
    let sourceViews: RemoteSessionViews
    const sidebarAccess = new RemoteSidebarAccess(remoteControl.registry, transcriptAccess, (view) => sourceViews.isActive(view), this.contextCompactionIpc)
    const reviewAccess = new RemoteReviewAccess(this.commits, reviewInteractions, this.fileChangesAccess, (view) => sourceViews.isActive(view), (view, source) => this.remoteContentAccess.admitSource(view, source),
      async (sessionId, vcs, result, openId) => {
        await sessionViewItems.record({ sessionId, openId, key: result.value.draftId, title: result.value.title,
          item: { kind: 'review', reviewId: result.value.draftId, vcs, scopeRoot: result.value.scopeRoot } })
      })
    const content = new RemoteSessionContent(sidebarAccess, reviewAccess, taskAccess, itemPages, sessionViewItems, sharedItems, this.remoteContentAccess, this.remoteChangesAccess, RemoteContentAccess.owner)
    sourceViews = new RemoteSessionViews({
        read: (view, request) => content.read(view, request),
        release: view => content.release(view),
        exists: (sessionId) => this.sessions.snapshot().sessions.some((session) => session.sessionId === sessionId),
        press: (view, body, operationId) => sessionActions.press(view, body, operationId),
      })
    this.peerWork = new PeerWorkService({
      views: sourceViews,
      snapshots: new RemoteSessionSnapshots(() => this.sessions.snapshot(), () => this.commits.discovery()),
      control: remoteControl, files: pastedFiles,
      audit: new RemoteControlAudit(ClientStatePaths.controlAuditFile(configIdentity, channel), message => this.report(message)),
      unknownPeer: (claimant, remoteAddress) => this.remoteInboundApproval.request(claimant, remoteAddress),
      bound: (host, port) => {
        this.publishPairingEndpoint(host, port)
        try { return JSON.stringify(this.remotePairing.bundle()) } catch { return null }
      },
    })
    this.remoteInbound = new GatewayPeerClient(this.gatewayCalls, () => this.remoteChanged(false), () => this.peerWork.flush())
    this.remoteListener = this.remoteInbound
    this.peerProcessIdentity = () => ({ identity: peerIdentity, ...credentials.privateProcessCredentials(),
      bundleText: (() => { try { return JSON.stringify(this.remotePairing.bundle()) } catch { return null } })() })
    this.remoteInboundApproval = new RemoteInboundApprovalManager({
      credentials,
      shell: this.shell,
      onChanged: async () => {
        await this.remoteInbound.updateTrust(credentials.inboundPeers().map(peer => peer.identity))
        this.remoteChanged()
      },
      onError: (message) => this.report(message),
    })
    const pairingImport = new PairingImport(this.remotePairing, () => this.remoteConnections.reloadProfiles())
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
        importPairing: bundle => pairingImport.run(bundle),
      },
    })
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
      networkState: () => this.remoteConnections.networkState(),
      onChanged: () => this.remoteChanged(),
    })
    this.skillLinks = new SkillLinkInstaller({
      repoRoot: applicationRoot,
      homeRoot: homedir(),
      skip: process.env.JAMAT_V3_SKIP_SKILL_LINKS === '1',
      privateStateRoot: context.privateStateRoot,
      ...(process.env.CODEX_HOME === undefined ? {} : { codexHome: process.env.CODEX_HOME }),
      report: (message) => this.report(`Skill link: ${message}`),
    })
    this.pingLoop = new HostPingLoop({
      ping: () => this.sessions.pingHost(),
      publish: value => this.event({ kind: 'host-ping-result', value }),
    })
    this.publishConfigSections()
    this.api = {
      viewerPath: (...args) => this.fileViewer.path(...args),
      viewerImageDragPath: (...args) => this.fileViewer.imageDragPath(...args),
      viewerOpenDetected: (...args) => this.fileViewer.openDetected(...args),
      viewerReleaseGrant: (...args) => this.fileViewer.releaseGrant(...args),
      mediaMetadata: resourceId => this.fileMedia.metadata(resourceId),
      mediaOpen: request => this.fileMedia.open(request),
      mediaCancel: requestId => this.fileMedia.cancel(requestId),
      stopMedia: () => this.fileMedia.stop(),
      viewerOpenWorkspace: (...args) => this.fileViewer.openWorkspace(...args),
      viewerMediaResource: (...args) => this.fileViewer.mediaResource(...args),
      viewerRelease: (...args) => this.fileViewer.release(...args),
      detect: (...args) => this.terminalDetector.detect(...args),
      detectionPath: (...args) => this.terminalDetector.pathOf(...args),
      markOpened: (...args) => this.terminalDetector.markOpened(...args),
      workingContext: (...args) => this.sessions.workingContext(...args),
      conflictRoot: (...args) => this.sessions.conflictRootOf(...args),
      sessionsSnapshot: () => this.sessions.snapshot(),
      processTree: (...args) => this.sessions.processTree(...args),
      pingHost: (...args) => this.sessions.pingHost(...args),
      setDebugVisible: visible => this.pingLoop.setWindowVisible(visible),
      setDebugSection: section => this.pingLoop.setActiveSection(section),
      stopDebugPing: () => this.pingLoop.stop(),
      saveImage: (...args) => this.pastedFiles.saveImage(...args),
      remoteSessionView: (...args) => this.remoteConnections.sessionView(...args),
      remoteViewEpoch: (...args) => this.remoteConnections.viewEpoch(...args),
      remoteAuthorizeView: (...args) => this.remoteConnections.authorizeView(...args),
      remotePasteImage: (...args) => this.remoteConnections.pasteImage(...args),
      remotePasteFile: (...args) => this.remoteConnections.pasteFile(...args),
      controlIsWrite: (...args) => this.remoteControl.registry.isWrite(...args),
      controlNames: (...args) => this.remoteControl.registry.names(...args),
      autolauncherGet: (...args) => this.autolauncher.get(...args),
      autolauncherInspect: (...args) => this.autolauncher.inspect(...args),
      autolauncherEnable: (...args) => this.autolauncher.enable(...args),
      autolauncherDisable: (...args) => this.autolauncher.disable(...args),
      checkTreeRemoval: milliseconds => OriginalTreeRemoval.check(milliseconds),
      executeDiff: input => this.fileDiffWorker.execute(input),
      controlExecute: (...args) => this.remoteControl.registry.execute(...args),
      initializeInbound: () => this.remoteInbound.initialize(this.peerProcessIdentity()),
      initializeOutbound: () => { const identity = this.peerProcessIdentity(); return this.remoteConnections.initialize({ identity: identity.identity, privateKey: identity.privateKey }) },
      configureServices: () => { for (const service of [this.controlIpc, this.remoteSettingsIpc, this.tabRequestsIpc, this.versioningCommitIpc, this.fileChangesIpc, this.fileViewerIpc, this.remarkableIpc, this.contextCompactionIpc, this.cliUpdatesIpc, this.attentionIpc]) { service.setTransport(this.serviceTransport); service.setPerfSpans(this.perf) } },
      initializeRemoteSettingsIpc: () => this.remoteSettingsIpc.initialize(),
      initializeTabRequestsIpc: () => this.tabRequestsIpc.initialize(),
      initializeVersioningCommitIpc: () => this.versioningCommitIpc.initialize(),
      initializeFileChangesIpc: () => this.fileChangesIpc.initialize(),
      initializeFileViewerIpc: () => this.fileViewerIpc.initialize(),
      initializeRemarkableIpc: () => this.remarkableIpc.initialize(),
      initializeContextCompactionIpc: () => this.contextCompactionIpc.initialize(),
      initializeCliUpdatesIpc: () => this.cliUpdatesIpc.initialize(),
      initializeAttentionIpc: () => this.attentionIpc.initialize(),
      beginStopRemarkable: () => this.remarkable.beginStop(),
      beginStopFileDiffWorker: () => this.fileDiffWorker.beginStop(),
      beginStopTokenUsage: () => this.tokenUsage.beginStop(),
      beginStopRemoteControlServer: () => this.remoteControlServer.beginStop(),
      beginStopPeerWork: () => this.peerWork.beginStop(),
      beginStopRemoteListener: () => this.remoteListener.beginStop(),
      stopRemarkable: () => this.remarkable.stop(),
      stopFileDiffWorker: () => this.fileDiffWorker.stop(),
      stopTokenUsage: () => this.tokenUsage.stop(),
      stopRemoteControlServer: () => this.remoteControlServer.stop(),
      stopPeerWork: () => this.peerWork.stop(),
      stopRemoteListener: () => this.remoteListener.stop(),
      stopInbound: () => this.remoteInbound.stop(),
      stopRemoteConnections: () => this.remoteConnections.stop(),
      stopCliUpdates: () => this.cliUpdates.stop(),
      stopAccounts: () => this.accounts.stop(),
      stopRateMonitor: () => this.rateMonitor.stop(),
      stopSessionNotifier: () => this.sessionNotifier.stop(),
      stopSnapins: () => this.snapins.stop(),
      stopSessions: () => this.sessions.stop(),
      stopSvnAssemblyWorker: () => this.svnAssemblyWorker.stop(),
      cancelTabs: () => this.tabControlBroker.cancelAll(),
      disposeGroups: () => this.sessionGroups.dispose(),
      disposeNotices: () => this.notices.dispose(),
      stopAttention: () => this.attention.stop(),
      personActive: () => this.attention.personActive(),
      openSnapin: kind => this.openSnapin(kind),
      tabsChanged: () => { this.remoteControlServer.publishEvent('tabs.changed'); this.remoteControl.activity.publish('tabs.changed') },
      revokeCommitOwner: windowId => this.commits.revokeOwner(windowId),
      revokeOwner: windowId => { this.fileChangesAccess.revokeOwner(windowId); this.fileViewer.revokeOwner(windowId) },
      setPresentation: value => { this.presentation = structuredClone(value); this.sessions.setWindowVisible(value.anythingVisible); this.rateMonitor.setWindowVisible(value.anythingVisible); this.sessionAttention.seen(this.presentation.seen) },
      startBackground: () => this.startBackground(),
      runaway: row => { const notice = RunawayTracker.notice(row, async sessionId => { const opened = await this.tabControlBroker.open(sessionId, this.tabTitleOf(sessionId) ?? `Session ${row.session}`, 'person'); if (!opened.ok) throw new Error(`The session could not be opened: ${opened.error.detail}`) }); this.notices.show(notice, notice.click) },
      hostConnection: value => { this.hostConnectionDebug = value.debug; this.hostConnection.update(value.descriptor, value.leaseId) },
      hostClosed: () => this.hostConnection.update(null, null),
      snapinDefinitions: () => BuiltInSnapins.all().map(({ kind, title }) => ({ kind, title }))
    }
    this.transport = { invoke: (method, args, context) => this.peerWork.invoke(method, args, context), event: (target, name, payload) => this.gatewayEvent(target, name, payload) }
  }

  async initialize(): Promise<void> {
    await this.api.initializeInbound()
    if (this.quitting) return
    await this.api.initializeOutbound()
    if (this.quitting) return
    this.api.configureServices()
    this.controlIpc.initialize()
    for (const initialize of [this.api.initializeRemoteSettingsIpc, this.api.initializeTabRequestsIpc,
      this.api.initializeVersioningCommitIpc, this.api.initializeFileChangesIpc, this.api.initializeFileViewerIpc,
      this.api.initializeRemarkableIpc, this.api.initializeContextCompactionIpc, this.api.initializeCliUpdatesIpc,
      this.api.initializeAttentionIpc]) initialize()
    this.publishProjection()
  }

  publishProjection(): void {
    if (this.sessions) this.event({ kind: 'projection', value: { processTree: this.sessions.processTree(), snapins: this.api.snapinDefinitions() } })
  }

  beginQuit(): void {
    if (this.quitting) return
    this.quitting = true
    this.api.stopDebugPing()
    this.api.stopMedia()
    this.api.beginStopRemarkable()
    this.api.beginStopFileDiffWorker()
    this.api.beginStopTokenUsage()
    this.api.beginStopRemoteControlServer()
    this.api.beginStopPeerWork()
    this.api.beginStopRemoteListener()
    this.api.stopRemoteConnections()
    this.api.cancelTabs()
    this.api.disposeGroups()
    this.api.disposeNotices()
    this.api.stopAttention()
  }

  dispose(): Promise<boolean> {
    return this.disposal ??= this.drain()
  }

  private async drain(): Promise<boolean> {
    this.beginQuit()
    let recordsSettled = false
    const steps: { subject: string; run: () => void | Promise<void> }[] = [
      { subject: 'the agent CLI updater', run: () => this.api.stopCliUpdates() },
      { subject: 'the reMarkable manager', run: () => this.api.stopRemarkable() },
      { subject: 'the file diff worker', run: () => this.api.stopFileDiffWorker() },
      { subject: 'the token usage worker', run: () => this.api.stopTokenUsage() },
      { subject: 'the accounts manager', run: () => this.api.stopAccounts() },
      { subject: 'the rate monitor', run: () => this.api.stopRateMonitor() },
      { subject: 'the session notifier', run: () => this.api.stopSessionNotifier() },
      { subject: 'the snap-ins manager', run: () => this.api.stopSnapins() },
      { subject: 'the control server', run: () => this.api.stopRemoteControlServer() },
      { subject: 'the peer listener', run: () => this.api.stopRemoteListener() },
      { subject: 'the inbound registry', run: () => this.api.stopInbound() },
      { subject: 'the session manager', run: async () => {
        await this.api.stopSessions()
        recordsSettled = this.sessions.recordsSettled()
        if (recordsSettled) console.log('Orchestrator session records settled commit confirmed')
        else AppClientUiReport.error('Orchestrator session records settlement is unconfirmed')
      } },
      { subject: 'the accepted peer work', run: () => this.api.stopPeerWork() },
      { subject: 'the svn assembly worker', run: () => this.api.stopSvnAssemblyWorker() },
    ]
    const settle = async (step: typeof steps[number]): Promise<void> => {
      try { await step.run() }
      catch (error) { AppClientUiReport.error(step.subject + ' did not stop cleanly: ' + ErrorText.of(error)) }
    }
    // Leave one second inside the utility's fifteen-second stop budget for its perf writer.
    let expired = false
    let timer!: ReturnType<typeof setTimeout>
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        expired = true
        AppClientUiReport.error('Orchestration disposal exceeded 14000 ms; work remains unsettled. Session records settlement ' + (recordsSettled ? 'was confirmed' : 'is unconfirmed') + '.')
        for (const step of steps.splice(0)) void settle(step)
        resolve()
      }, 14_000)
    })
    const drain = async (): Promise<void> => {
      while (!expired && steps.length > 0) await settle(steps.shift()!)
    }
    try { await Promise.race([drain(), deadline]) }
    finally { clearTimeout(timer) }
    return recordsSettled
  }

  private gatewayEvent(target: string, name: string, payload: unknown): void {
    if (target === 'peers') this.remoteInbound.event(name, payload)
    else if (target === 'outbound') this.remoteConnections.event(name, payload)
    else if (target === 'peer-work') this.peerWork.event(name, payload)
    else if (target === 'terminals') this.gatewayTerminals.receive({ name, payload } as TerminalProcessEvent)
    else if (target === 'diagnostics') {
      if (typeof payload !== 'string') throw new Error('Invalid gateway diagnostic')
      if (name === 'host-error') this.sessions.noteHostError(payload)
      else if (name === 'terminal-error') this.report(payload)
      else throw new Error(`Unknown gateway diagnostic: ${name}`)
    } else throw new Error(`Unknown main event target: ${target}`)
  }
  private configSections(): ConfigSections { return { ui: this.configStore.readSection(UiSettingsSection.spec) } }
  private publishConfigSections(): void { this.event({ kind: 'config', value: this.configSections() }) }
  private closeTerminalPanels(key: string): void { this.event({ kind: 'close-terminal', key }) }
  private scriptRunCollapsed(...args: Parameters<ScriptRunCollapsed>): void { this.event({ kind: 'script-collapsed', args }) }

  private report(message: string): void { AppClientUiReport.error(message); this.broadcast('app:error', message) }
  private broadcast<K extends keyof AppClientUiIpcEventMap>(
    channel: K,
    ...args: AppClientUiEventArgs<K>
  ): void {
    this.serviceTransport.publish(channel, 'all', ...args)
  }
  private startBackground(): void {
    if (this.quitting) return
    const skipSkillLinks = this.skillLinks.skipReason()
    if (skipSkillLinks !== null) this.report(`skill links skipped: ${skipSkillLinks}`)
    else this.skillLinks.install()
    void this.remoteControlServer.start().catch((error: unknown) =>
      this.report(`Remote control server could not start: ${ErrorText.of(error)}`))
    // Reports its own failure, the same as the three starts below it: a listener that cannot bind
    // leaves the client working and says so in its own state.
    void this.startRemoteListener().catch(error => this.report(`Remote peer listener failed: ${ErrorText.of(error)}`))
    // Finishing an interrupted rename is not worth delaying the window for, and it reports its own
    // failures; a rejection here would only mean the sweep itself is broken.
    void this.projects.start()
    // Same reasoning, and the manager reports through the same channel: reaching the Host, reading
    // what it has and possibly starting one all take longer than a window should wait for.
    void this.sessions.start().then(() => this.tokenUsage.start())
    // The cache first, and then a live read of whatever it could not answer for. The windows are
    // already up by this line, so a provider whose cached success is older than one interval is read
    // now, and on a machine with no cache at all that is both of them. The monitor reports its own
    // failures.
    void this.rateMonitor.start()
    this.cliUpdates.start()
    this.sessionNotifier.start()
    this.snapins.wake()
  }

  private openSnapin(kind: string): void {
    const definition = BuiltInSnapins.all().find((entry) => entry.kind === kind)
    if (!definition) { this.report(`Unknown snap-in ${kind}`); return }
    void this.tabControlBroker.openSnapin(kind, definition.title).then((answer) => {
      if (!answer.ok) this.report(answer.error.detail)
    }).catch((error: unknown) => this.report(ErrorText.of(error)))
  }

  private tabTitleOf(sessionId: string): string | null {
    return this.sessions.snapshot().sessions.find((session) => session.sessionId === sessionId)?.tabTitle ?? null
  }

  private remoteChanged(notifyGateway = true): void {
    this.event({ kind: 'remote-changed' })
    this.remoteRevision += 1
    if (notifyGateway) this.remoteConnections.notifyChanged()
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

  
}
