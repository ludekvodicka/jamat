/// <reference path="./processes/buildIdentity.d.ts" />
import { ElectronShellPort } from './shell/electronShellPort'
import { TabWindowRouter } from './shell/tabWindowRouter'
import { ServiceFileViewerShellIpc } from './shell/serviceFileViewerShellIpc'
import { DocumentExport } from './shell/documentExport'
import { DocumentPdfPrinter } from './shell/documentPdfPrinter'
import { FileViewerDragExport } from './fileViewer/fileViewerDragExport'
import { FileViewerExport } from './fileViewer/fileViewerExport'
import { LocalFileMediaSource } from './fileViewer/localFileMediaSource'
import { RemoteFileMediaSource } from './fileViewer/remoteFileMediaSource'
import { RemoteContentClient } from './remoteControl/remoteContentClient'
import { AppClientUiReport } from '../shared/appClientUiReport'

import { dirname, join } from 'node:path'
import { app, net, powerMonitor, utilityProcess, MessageChannelMain, type WebContents } from 'electron'
import clientBuild from 'virtual:jamat-client-build'
import { ChildProcessSupervisor } from './processes/childProcessSupervisor'
import { WindowPorts } from './processes/windowPorts'
import { GatewayChannelsConst, OrchestratorChannelsConst } from '../shared/appClientUiIpc'
import type { ChildProcessKind } from '../../lib-orchestrator/shared/processWire.types'
import { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import { ServicePerfIpc } from './perf/servicePerfIpc'
import { IpcServiceTransport } from './shared/ipcServiceTransport'
import { MachineLoadSampler } from './perf/machineLoadSampler'
import { PerfMonitor } from '../../lib-orchestrator/perfMonitor/perfMonitor'
import { PerfNames } from '../../lib-orchestrator/perfMonitor/perfNames'
import { PerfProfiler } from '../../lib-orchestrator/perfMonitor/perfProfiler'
import type { AppClientUiEventArgs, AppClientUiIpcEventMap, AppClientUiIpcInvokeMap } from '../shared/appClientUiIpc'
import { AppCommands, type CommandId } from '../shared/commands'
import { AutoUpdateMain } from '../shared/electron/autoUpdate/main/autoUpdateMain'
import { ErrorText } from '../shared/errorText'
import { FileViewerProtocolUrl } from '../shared/fileViewerProtocol'
import type { AppContext } from './appContext'
import { ServiceAutolauncherIpc } from './autolauncher/serviceAutolauncherIpc'
import { ClientStatePaths } from './clientState/clientStatePaths'
import { ClientStateStore } from './clientState/clientStateStore'
import { DebugSectionPresence } from './debug/debugSectionPresence'
import { ServiceDebugIpc } from './debug/serviceDebugIpc'
import { FileViewerProtocol } from './fileViewer/fileViewerProtocol'
import { RemoteClipboardPaste } from './remoteControl/remoteClipboardPaste'
import { RemoteNativeActions } from './remoteControl/remoteNativeActions'
import { ServiceRemoteControlIpc } from './remoteControl/serviceRemoteControlIpc'
import { AppMenu } from './shell/appMenu'
import { AppRestart } from './shell/appRestart'
import { ServiceClipboardIpc } from './shell/serviceClipboardIpc'
import { ServiceDialogIpc } from './shell/serviceDialogIpc'
import { ServiceShellIpc } from './shell/serviceShellIpc'
import { ServiceWindowsIpc } from './shell/serviceWindowsIpc'
import { WindowIcon } from './shell/windowIcon'
import { WorkspaceWindows } from './shell/workspaceWindows'
import { ServiceTabsIpc } from './tabs/serviceTabsIpc'
import { TabTransferBroker } from './tabs/tabTransferBroker'
import { WorkspacePanelIndex } from './tabs/workspacePanelIndex'
import { ServiceTerminalIpc } from './terminals/serviceTerminalIpc'
import { ServiceTerminalMenuIpc } from './terminals/serviceTerminalMenuIpc'
import { OrchestratorApiClient } from './processes/orchestratorApiClient'
import type { OrchestratorBootstrap, OrchestratorEvent, OrchestratorNativeApi, ShellSnapshot } from '../../lib-orchestrator/clientApi/orchestratorProcess.types'
import type { RemoteConnectionsSnapshot } from '../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { ConfigSectionsCache } from './shared/configSectionsCache'
import { ServiceChannels } from './shared/serviceChannels'

export class MainHub {
  private static readonly smokeTimeoutMillisecondsConst = 60_000
  private static readonly smokePhaseTimeoutMillisecondsConst = 15_000
  private static readonly smokePollMillisecondsConst = 25
  static readonly ipcChannelsConst = ServiceChannels.merge([
    OrchestratorChannelsConst,
    ServicePerfIpc.channelsConst,
    ServiceShellIpc.channelsConst,
    ServiceWindowsIpc.channelsConst,
    ServiceDialogIpc.channelsConst,
    ServiceClipboardIpc.channelsConst,
    ServiceRemoteControlIpc.channelsConst,
    ServiceTabsIpc.channelsConst,
    ServiceTerminalIpc.channelsConst,
    GatewayChannelsConst,
    ServiceTerminalMenuIpc.channelsConst,
    ServiceDebugIpc.channelsConst,
    ServiceAutolauncherIpc.channelsConst,
    ServiceFileViewerShellIpc.channelsConst,
  ] as const) satisfies Record<keyof AppClientUiIpcInvokeMap, true>
  private readonly orchestrator: OrchestratorNativeApi
  private readonly orchestratorClient: OrchestratorApiClient
  private readonly bootstrap: Omit<OrchestratorBootstrap, 'shell'>
  private privateChannel: MessageChannelMain | null
  private remoteState: RemoteConnectionsSnapshot
  private readonly configCache: ConfigSectionsCache
  private readonly perfIpc: ServicePerfIpc
  private readonly serviceTransport: IpcServiceTransport
  private readonly machineLoad: MachineLoadSampler
  private readonly perf: PerfMonitor
  private readonly children: ChildProcessSupervisor
  private readonly windowPorts: WindowPorts
  private readonly gatewayCalls: ProcessCalls
  private quitting: boolean
  private readonly store: ClientStateStore
  private readonly panelIndex: WorkspacePanelIndex
  private readonly workspaceWindows: WorkspaceWindows
  private readonly transferBroker: TabTransferBroker
  private readonly tabWindowRouter: TabWindowRouter
  private readonly shell: ElectronShellPort
  private readonly fileViewerShellIpc: ServiceFileViewerShellIpc
  private readonly debugSections: DebugSectionPresence
  private readonly shellIpc: ServiceShellIpc
  private readonly windowsIpc: ServiceWindowsIpc
  private readonly dialogIpc: ServiceDialogIpc
  private readonly clipboardIpc: ServiceClipboardIpc
  private readonly tabsIpc: ServiceTabsIpc
  private readonly terminalsIpc: ServiceTerminalIpc
  private readonly terminalMenuIpc: ServiceTerminalMenuIpc
  private readonly debugIpc: ServiceDebugIpc
  private readonly autolauncherIpc: ServiceAutolauncherIpc
  private readonly remoteIpc: ServiceRemoteControlIpc
  private readonly remoteDrag: FileViewerDragExport
  private readonly remoteMedia: RemoteFileMediaSource
  private readonly contentClient: RemoteContentClient
  private readonly fileViewerProtocol: FileViewerProtocol
  private menu: AppMenu | null
  private readonly appRestart: AppRestart
  private readonly autoUpdate: AutoUpdateMain
  private readonly visibleWorkspaceWindowIds: Set<string>
  private readonly workspaceWindowIds: Set<string>
  private readonly onSuspend: () => void
  private readonly onResume: () => void
  private powerEpoch: number
  constructor(context: AppContext, onChildExit: (kind: ChildProcessKind) => void) {
    this.quitting = false
    this.menu = null
    this.privateChannel = null
    this.remoteState = { revision: 0, outbound: [], inbound: [] }
    this.bootstrap = { config: context.config, smoke: context.smoke, appVersion: context.appVersion,
      privateStateRoot: context.privateStateRoot, applicationRoot: dirname(app.getAppPath()), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }
    this.clipboardIpc = new ServiceClipboardIpc()
    this.visibleWorkspaceWindowIds = new Set()
    this.workspaceWindowIds = new Set()
    this.configCache = new ConfigSectionsCache()
    this.serviceTransport = new IpcServiceTransport()
    this.powerEpoch = 0
    this.onSuspend = () => this.power('suspend')
    this.onResume = () => this.power('resume')
    powerMonitor.on('suspend', this.onSuspend)
    powerMonitor.on('resume', this.onResume)
    const configIdentity = context.config.identity.configIdentity
    const channel = context.config.runtimeChannel
    const perfNames = new PerfNames(Object.keys(MainHub.ipcChannelsConst))
    const build = clientBuild
    this.perf = new PerfMonitor({
      process: 'main', build,
      directory: ClientStatePaths.perfDirectory(configIdentity, channel),
      profiler: new PerfProfiler(join(ClientStatePaths.perfDirectory(configIdentity, channel), 'profiles'), 'main'),
      names: perfNames, report: message => this.report(message),
    })
    this.perfIpc = new ServicePerfIpc(this.perf, build)
    this.gatewayCalls = new ProcessCalls({ send: message => this.children.send('gateway', message),
      invoke: (target, method, args, context) => {
        if (target === 'outbound-work') {
          if (method !== 'clipboard') throw new Error(`Unknown outbound main operation: ${method}`)
          const [windowId, epoch, endpointId, privateId] = args as [string, string, string, string]
          const identity = { windowId, epoch }
          const sender = this.windowPorts.sender(identity)
          const signal = this.windowPorts.signal(identity)
          if (!sender || !signal || !this.workspaceWindows.acceptsRenderer(sender)) throw new Error('The workspace window is closing')
          context.pending()
          return new RemoteClipboardPaste({
            terminalPasteImage: (...values) => this.gatewayCalls.call('windows', 'remote-paste-image', [identity.windowId, identity.epoch, ...values], { signal: AbortSignal.any([context.signal, signal]) }),
            terminalPasteFile: (...values) => this.gatewayCalls.call('windows', 'remote-paste-file', [identity.windowId, identity.epoch, ...values], { signal: AbortSignal.any([context.signal, signal]) }),
          }).paste(endpointId, privateId, AbortSignal.any([context.signal, signal]))
        }
        throw new Error(`Unknown main call target: ${target}`)
      },
      event: (target, name, payload) => {
        if (target !== 'outbound-work') throw new Error('Unknown native gateway event: ' + target)
        if (name === 'release-media') {
          const value = payload as { endpointId: string; viewId: string; documentId?: string }
          this.remoteMedia.releaseView(value.endpointId, value.viewId, value.documentId)
        } else if (name === 'state') {
          this.remoteState = payload as RemoteConnectionsSnapshot
          this.remoteMedia.reconcile()
        } else throw new Error('Unknown outbound main event: ' + name)
      }, report: message => this.report(message) })
    this.children = new ChildProcessSupervisor({ build,
      smoke: context.smoke,
      identity: { configIdentity, channel, stateDirectory: ClientStatePaths.directory(configIdentity, channel) },
      initialization: kind => {
        const identity = { configIdentity, channel, stateDirectory: ClientStatePaths.directory(configIdentity, channel) }
        if (kind === 'gateway') return { message: { type: 'initialize', identity, smoke: context.smoke } }
        else if (kind === 'orchestrator') {
          if (!this.privateChannel) throw new Error('Orchestration channel is not brokered')
          return { message: { type: 'initialize', identity, bootstrap: { ...this.bootstrap, shell: this.shellSnapshot() } }, ports: [this.privateChannel.port2] }
        } else throw new Error('Unknown child process: ' + kind)
      },
      record: event => this.perf.event(event),
      fork: kind => {
        switch (kind) {
          case 'gateway': return utilityProcess.fork(context.gatewayBundlePath, [], { serviceName: 'Jamat gateway' })
          case 'orchestrator': {
            const child = utilityProcess.fork(context.orchestratorBundlePath, [], { serviceName: 'Jamat orchestrator', stdio: 'pipe' })
            child.stdout?.on('data', bytes => process.stdout.write(bytes))
            child.stderr?.on('data', bytes => process.stderr.write(bytes))
            return child
          }
          default: throw new Error(`Unknown child process: ${kind}`)
        }
      },
      onExit: onChildExit,
      onMessage: (kind, message) => {
        if (message.type === 'host-connection') throw new Error('Host connection belongs to the gateway-orchestrator port')
        if (kind === 'gateway') this.gatewayCalls.receive(message)
        else if (kind === 'orchestrator') this.orchestratorClient.receive(message)
        else throw new Error('Unknown child process: ' + kind)
      },
      onHeartbeat: kind => {
        if (kind === 'gateway') this.gatewayCalls.alive()
        else if (kind === 'orchestrator') this.orchestratorClient.alive()
        else throw new Error('Unknown child process: ' + kind)
      },
      onClosed: kind => {
        if (kind === 'gateway') { this.gatewayCalls.close(); this.remoteState = { revision: 0, outbound: [], inbound: [] }; this.remoteMedia.reconcile() }
        else if (kind === 'orchestrator') this.orchestratorClient.close()
        else throw new Error('Unknown child process: ' + kind)
      },
      report: message => this.report(message),
    })
    this.windowPorts = new WindowPorts({
      orchestration: { open: (caller, port, windowId) => this.children.orchestratorWindow(caller, port, windowId),
        close: (caller, reason, windowId) => this.children.closeOrchestratorWindow(caller, reason, windowId) },
      open: (windowId, epoch, port, accepting) => this.children.windowPort(windowId, epoch, port, accepting),
      close: (windowId, epoch) => this.children.closeWindow(windowId, epoch),
      setAccepting: (windowId, epoch, accepting) => this.children.setWindowAccepting(windowId, epoch, accepting),
      acceptsRenderer: sender => this.workspaceWindows.acceptsRenderer(sender),
      authorize: (windowId, epoch, attachId) => this.gatewayCalls.call('windows', 'authorize', [windowId, epoch, attachId]),
      report: message => this.report(message),
    })
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
      onAcceptingChanged: (windowId, accepting) => {
        const contents = this.workspaceWindows.window(windowId)?.windowHandle()?.webContents
        if (contents) this.windowPorts.setAccepting(contents, accepting)
        this.presentationChanged()
      },
      confirmMainWindowClose: (parent, holderCount) =>
        this.dialogIpc.confirmMainWindowClose(parent, holderCount),
      requestQuit: () => app.quit(),
      explicitlyClosing: (windowId) => this.transferBroker.cancelClosingWindow(windowId),
      onFocusChanged: () => this.presentationChanged(),
      onPersonActive: () => { this.presentationChanged(); this.orchestrator.personActive() },
      report: (message) => this.report(message),
    })
    this.tabWindowRouter = new TabWindowRouter(this.workspaceWindows, this.panelIndex)
    this.transferBroker = new TabTransferBroker(this.workspaceWindows, this.panelIndex)
    this.debugSections = new DebugSectionPresence((section) => this.orchestrator.setDebugSection(section))
    this.serviceTransport.onCaller('gone', (caller) => this.debugSections.forget(caller.id))
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
    this.shell = new ElectronShellPort({ dialogs: this.dialogIpc, parent: () => this.workspaceWindows.main().windowHandle(),
      tabs: this.tabWindowRouter, groups: this.store, restart: () => this.appRestart.restart(), quit: () => app.quit() })
    this.orchestratorClient = new OrchestratorApiClient({ send: message => this.children.send('orchestrator', message),
      shell: this.shell, shellSnapshot: () => this.shellSnapshot(), event: event => this.orchestratorEvent(event),
      publish: (channel, args) => this.serviceTransport.publish(channel, 'all', ...args as never), report: message => this.report(message) })
    this.orchestrator = this.orchestratorClient.api
    this.autolauncherIpc = new ServiceAutolauncherIpc({ get: () => this.orchestrator.autolauncherGet(), inspect: (...args) => this.orchestrator.autolauncherInspect(...args), enable: (...args) => this.orchestrator.autolauncherEnable(...args), disable: () => this.orchestrator.autolauncherDisable() }, sender => this.workspaceWindows.acceptsRenderer(sender))
    const localMedia = new LocalFileMediaSource({
      mediaMetadata: resourceId => this.orchestrator.mediaMetadata(resourceId),
      mediaOpen: request => this.orchestrator.mediaOpen(request),
      mediaCancel: requestId => this.orchestrator.mediaCancel(requestId),
    })
    this.contentClient = new RemoteContentClient((endpointId, request) => this.gatewayCalls.call('outbound', 'session-view', [endpointId, request]))
    this.remoteMedia = new RemoteFileMediaSource(this.contentClient, (endpointId, epoch) => this.remoteState.outbound.some(endpoint => endpoint.remoteEndpointId === endpointId && endpoint.status === 'connected' && endpoint.connectionId === epoch))
    this.remoteDrag = new FileViewerDragExport(join(ClientStatePaths.directory(configIdentity, channel), 'drag-exports'), this.remoteMedia)
    this.fileViewerProtocol = new FileViewerProtocol({
      metadata: (token) => (this.remoteMedia.owns(token) ? this.remoteMedia : localMedia).metadata(token),
      read: (token, version, offset, length, signal) => (this.remoteMedia.owns(token) ? this.remoteMedia : localMedia).read(token, version, offset, length, signal),
    })
    this.machineLoad = new MachineLoadSampler({
      emit: (event, at) => this.perf.record([{ ...event, v: 1, at, process: 'machine', pid: process.pid, build }]),
      roots: () => this.orchestrator.processTree().roots,
      ownPids: () => {
        const hostPid = this.orchestrator.processTree().hostPid
        return [...app.getAppMetrics().map(metric => metric.pid), ...(hostPid === null ? [] : [hostPid])]
      },
      power: powerMonitor, notify: row => this.orchestrator.runaway(row), report: message => this.report(message),
    })
    const workspaceOwnerIdOf = (sender: WebContents): string | null =>
      this.workspaceWindows.acceptsRenderer(sender)
        ? this.workspaceWindows.windowIdOf(sender)
        : null
    this.fileViewerShellIpc = new ServiceFileViewerShellIpc({ path: (...args) => this.orchestrator.viewerPath(...args), imageDragPath: (...args) => this.orchestrator.viewerImageDragPath(...args) }, workspaceOwnerIdOf,
      new DocumentExport(new DocumentPdfPrinter()))
    this.tabsIpc = new ServiceTabsIpc(
      this.workspaceWindows,
      this.panelIndex,
      this.transferBroker,
      this.tabWindowRouter,
      () => this.tabsPresenceChanged(),
    )
    this.terminalsIpc = new ServiceTerminalIpc(
      this.windowPorts,
      { saveImage: (...args) => this.orchestrator.saveImage(...args) },
      this.shell,
    )
    this.terminalMenuIpc = new ServiceTerminalMenuIpc(
      { detect: (...args) => this.orchestrator.detect(...args), pathOf: (...args) => this.orchestrator.detectionPath(...args), markOpened: (...args) => this.orchestrator.markOpened(...args) },
      { openDetected: (...args) => this.orchestrator.viewerOpenDetected(...args), releaseGrant: (...args) => this.orchestrator.viewerReleaseGrant(...args) },
      { workingContext: (...args) => this.orchestrator.workingContext(...args), conflictRootOf: (...args) => this.orchestrator.conflictRoot(...args), snapshot: () => this.orchestrator.sessionsSnapshot() },
      this.terminalsIpc,
      workspaceOwnerIdOf,
    )
    this.debugIpc = new ServiceDebugIpc({
      smoke: context.smoke,
      block: request => this.orchestratorClient.block(request),
      sectionActive: (callerId, section) => this.debugSections.report(callerId, section),
    })
    this.appRestart = new AppRestart({
      devRendererUrl: context.rendererDevUrl,
      // Electron's app path is this package, which is where the dev pipeline must start.
      packageDir: app.getAppPath(),
      logFile: join(app.getPath('userData'), 'restart-dev.log'),
      report: (message) => this.report(message),
      relaunch: () => app.relaunch(),
      quit: () => app.quit(),
    })
    this.autoUpdate = new AutoUpdateMain({
      releasePageUrl: (version) => version
        ? `https://github.com/ludekvodicka/jamat/releases/tag/v${version}`
        : 'https://github.com/ludekvodicka/jamat/releases',
    })
    const remoteNative = new RemoteNativeActions({
      content: this.contentClient, media: this.remoteMedia, drag: this.remoteDrag,
      icon: path => app.getFileIcon(path, { size: 'normal' }),
      selectFile: async defaultPath => {
        const filePath = await this.shell.saveDialog({ title: 'Save source file copy', defaultPath })
        return { canceled: filePath === null, filePath: filePath ?? undefined }
      },
      save: (resourceId, path, signal) => new FileViewerExport(this.remoteMedia).save(resourceId, path, signal),
      accepts: sender => this.workspaceWindows.acceptsRenderer(sender),
    })
    this.remoteIpc = new ServiceRemoteControlIpc({
        authorizeView: async (sender, endpointId, viewId) => {
          const identity = this.windowPorts.identity(sender)
          if (!identity) return null
          const signal = this.windowPorts.signal(identity)
          if (!signal) return null
          const view = await this.gatewayCalls.call<import('../../lib-orchestrator/remoteControl/remoteSessionApi.types').RemoteSessionView | null>('windows', 'remote-view', [identity.windowId, identity.epoch, endpointId, viewId], { signal })
          return view && !signal.aborted && this.windowPorts.sender(identity) === sender ? { view, signal } : null
        },
        startImageDrag: remoteNative.startImageDrag.bind(remoteNative),
        exportFile: remoteNative.exportFile.bind(remoteNative),
        mediaResource: remoteNative.mediaResource.bind(remoteNative),
        acceptsRenderer: (sender) => this.workspaceWindows.acceptsRenderer(sender),
    })
  }
  async initialize(): Promise<void> {
    this.perf.start()
    await this.children.start('gateway')
    if (this.quitting) return
    this.privateChannel = new MessageChannelMain()
    this.children.orchestrationPort(this.privateChannel.port1)
    await this.children.start('orchestrator')
    this.orchestratorClient.initialized()
    if (this.quitting) return
    this.menu = new AppMenu(
      (id) => this.runMainCommand(id),
      (id) => this.publishRendererCommand(id),
      (windowId) => this.workspaceWindows.focusOrRecreate(windowId),
      this.orchestrator.snapinDefinitions(),
      (kind) => this.orchestrator.openSnapin(kind),
    )
    this.machineLoad.start()
    this.perfIpc.setTransport(this.serviceTransport).setCallerAccess(this.serviceTransport)
    this.perfIpc.initialize()
    for (const service of [this.shellIpc, this.windowsIpc, this.dialogIpc, this.clipboardIpc,
      this.remoteIpc, this.tabsIpc, this.fileViewerShellIpc, this.terminalsIpc, this.terminalMenuIpc,
      this.debugIpc, this.autolauncherIpc]) {
      service.setTransport(this.serviceTransport)
      service.setPerfSpans(this.perf)
    }
    for (const service of [this.shellIpc, this.windowsIpc, this.dialogIpc, this.remoteIpc,
      this.tabsIpc, this.terminalsIpc, this.terminalMenuIpc, this.autolauncherIpc, this.fileViewerShellIpc])
      service.setCallerAccess(this.serviceTransport)
    // Handlers before the window: the renderer's first call must not reach an empty channel.
    this.shellIpc.initialize()
    this.windowsIpc.initialize()
    this.dialogIpc.initialize()
    this.clipboardIpc.initialize()
    this.remoteIpc.initialize()
    this.tabsIpc.initialize()
    this.fileViewerShellIpc.initialize()
    this.terminalsIpc.initialize()
    this.terminalMenuIpc.initialize()
    this.debugIpc.initialize()
    this.autolauncherIpc.initialize()
    this.fileViewerProtocol.initialize()
    // Its channels return raw values rather than IpcResult, so they sit outside the contract above.
    this.autoUpdate.start()
    this.menu.install()
    this.workspaceWindows.restoreAtStart()
    this.orchestrator.startBackground()
  }
  async dispose(): Promise<void> {
    this.orchestratorClient.beginQuit()
    const native = Promise.all([
      this.settleStep('the machine load sampler', () => this.machineLoad.stop()),
      this.settleStep('the remote image exports', () => this.remoteDrag.dispose()),
      this.settleStep('the updater', () => this.autoUpdate.stop()),
      this.settleStep('the performance monitor', () => this.perf.stop()),
    ])
    let timer!: ReturnType<typeof setTimeout>
    const boundedNative = Promise.race([native, new Promise<void>(resolve => { timer = setTimeout(() => {
      this.report('Native disposal exceeded 15000 ms; cleanup remains unsettled')
      resolve()
    }, 15_000) })]).finally(() => clearTimeout(timer))
    await this.settleStep('the client child processes', () => this.children.stopAll())
    this.orchestratorClient.close()
    this.gatewayCalls.close()
    await boundedNative
    powerMonitor.removeListener('suspend', this.onSuspend)
    powerMonitor.removeListener('resume', this.onResume)
  }
  beginQuit(): void {
    this.quitting = true
    this.orchestratorClient.beginQuit()
    this.children.beginQuit()
    this.windowPorts.stop()
    this.transferBroker.cancelAll()
    this.tabWindowRouter.cancelAll()
    this.shell.dispose()
    this.workspaceWindows.beginQuit()
  }
  private orchestratorEvent(event: OrchestratorEvent): void {
    switch (event.kind) {
      case 'projection': return
      case 'host-ping-result': this.workspaceWindows.broadcast('debug:host-ping-result', event.value); return
      case 'config': this.configCache.update(event.value); return
      case 'remote-changed': this.remoteMedia.reconcile(); return
      case 'session-items-changed': this.workspaceWindows.broadcast('tabs:open-terminal-targets', this.panelIndex.openTerminalTargetKeys()); return
      case 'close-terminal': this.tabsIpc.closeTerminalPanels(event.key); return
      case 'script-collapsed': this.tabsIpc.scriptRunCollapsed(...event.args); return
      default: throw new Error(`Unknown orchestration event: ${JSON.stringify(event satisfies never)}`)
    }
  }
  private shellSnapshot(): ShellSnapshot {
    return { groups: this.shell.sessionGroups.assignments(), lastFocusedWindowId: this.shell.tabs.lastFocusedWindowId(),
      panels: this.shell.tabs.snapshot().map(panel => ({ ...panel, terminalTargetKey: WorkspacePanelIndex.terminalTargetKeyOf(panel) })) }
  }
  private presentationChanged(): void {
    this.orchestratorClient.shellChanged()
    const focused = this.workspaceWindows.focusedWorkspace()
    const last = this.workspaceWindows.lastFocusedWorkspace()
    this.orchestrator.setPresentation({
      anythingVisible: this.visibleWorkspaceWindowIds.size > 0,
      accepting: [...this.workspaceWindowIds].filter(windowId => this.workspaceWindows.acceptsWindow(windowId)),
      seen: this.panelIndex.snapshot().flatMap(panel => panel.active && panel.sessionId !== null && this.visibleWorkspaceWindowIds.has(panel.windowId) ? [panel.sessionId] : []),
      front: focused === null ? null : { panelId: this.activePanelOf(focused.windowId) },
      lastActivePanel: last === null ? null : this.activePanelOf(last.windowId),
    })
  }
  private power(event: 'suspend' | 'resume'): void {
    const message = { type: 'power' as const, epoch: ++this.powerEpoch, event }
    this.gatewayCalls.power(message)
    this.orchestratorClient.power(message)
    this.children.power(message)
    this.windowPorts.power(message)
  }

  private async settleStep(subject: string, run: () => void | Promise<void>): Promise<void> {
    try {
      await run()
    } catch (error) {
      AppClientUiReport.error(`${subject} did not stop cleanly: ${ErrorText.of(error)}`)
    }
  }

  restart(): Promise<boolean> { return this.shell.restart('requested') }

  focusWindow(): void {
    this.workspaceWindows.main().focus()
  }

  private report(message: string): void {
    AppClientUiReport.error(`${message}`)
    this.broadcast('app:error', message)
  }

  private broadcast<K extends keyof AppClientUiIpcEventMap>(
    channel: K,
    ...args: AppClientUiEventArgs<K>
  ): void {
    this.serviceTransport.publish(channel, 'all', ...args)
  }

  private workspaceWindowCreated(windowId: string): void {
    this.workspaceWindowIds.add(windowId)
    const contents = this.workspaceWindows.window(windowId)?.windowHandle()?.webContents
    if (contents) {
      this.windowPorts.watch(contents, { windowId, role: windowId === 'main' ? 'main' : 'workspace' })
      this.serviceTransport.watch(contents, { windowId, role: windowId === 'main' ? 'main' : 'workspace' })
    }
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
    this.workspaceWindowIds.delete(windowId)
    this.orchestrator.revokeCommitOwner(windowId)
    this.visibleWorkspaceWindowIds.delete(windowId)
    this.transferBroker.rendererGone(windowId)
    this.tabWindowRouter.rendererGone(windowId)
    this.panelIndex.releaseWindow(windowId)
    this.orchestrator.revokeOwner(windowId)
    this.updateWindowMenu()
    this.tabsPresenceChanged()
  }

  private workspaceRendererGone(windowId: string): void {
    this.transferBroker.rendererGone(windowId)
    this.tabWindowRouter.rendererGone(windowId)
    this.panelIndex.releaseWindow(windowId)
    this.orchestrator.revokeOwner(windowId)
    this.tabsPresenceChanged()
  }

  private refreshVisibilityConsumers(): void {
    this.presentationChanged()
    // The Debug tab reports its node only while it is the visible tab of a visible document; this
    // half closes the ping gate when every workspace window is hidden.
    this.orchestrator.setDebugVisible(this.visibleWorkspaceWindowIds.size > 0)
    // Every workspace window, not only main: since the marks moved out of the sessions tree,
    // each window computes its own and a holder that never heard this would keep a mark lit on
    // the tab it is showing. The payload already names the active panel of every visible window.
    this.workspaceWindows.broadcast(
      'tabs:visible-terminal-targets',
      this.panelIndex.visibleTerminalTargetKeys(this.visibleWorkspaceWindowIds),
    )
  }

  private activePanelOf(windowId: string): string | null {
    return this.panelIndex.snapshot().find((panel) => panel.windowId === windowId && panel.active)?.panelId ?? null
  }

  private tabsPresenceChanged(): void {
    this.refreshVisibilityConsumers()
    // To every workspace window, because the sessions tree keeps a row for as long as its session
    // has a tab open somewhere and a holder's tabs count too. Finalizing a session does not close
    // its tab, so without this the tree drops the row of a session the person can still see.
    this.workspaceWindows.broadcast(
      'tabs:open-terminal-targets',
      this.panelIndex.openTerminalTargetKeys(),
    )
    this.orchestrator.tabsChanged()
  }

  private updateWindowMenu(): void {
    this.menu?.updateWindowEntries(this.workspaceWindows.namedWindows())
  }

  runSmoke(): void {
    const timer = setTimeout(() => {
      AppClientUiReport.error(`smoke timed out; state: ${this.smokeDiagnostics(null)}`)
      app.exit(1)
    }, MainHub.smokeTimeoutMillisecondsConst)
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
    MainHub.assertSmokeIcon('default', WindowIcon.of(null))
    MainHub.assertSmokeIcon('tinted', WindowIcon.of('#336699'))
    await this.checkSmokeFileDiffWorker()
    await this.checkSmokeFileProtocol()
    await this.orchestrator.checkTreeRemoval(MainHub.smokePhaseTimeoutMillisecondsConst)

    const before = new Set(this.panelIndex.entries().map((entry) => entry.panelId))
    this.workspaceWindows.publishTo('main', 'menu:command', 'tools.usage')
    const created = await this.waitForSmoke(
      'usage tab creation',
      () => {
        const added = this.panelIndex.entries().filter((entry) => !before.has(entry.panelId))
        if (added.length > 1)
          throw new Error(`Smoke usage tab creation added several panels: ${JSON.stringify(added)}`)
        return added[0] ?? null
      },
      null,
    )
    if (created.windowId !== 'main')
      throw new Error(`Smoke usage tab was created outside main: ${JSON.stringify(created)}`)

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
    const execution = this.orchestrator.executeDiff({ before, after }).then((result) => {
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
    const opened = await this.orchestrator.viewerOpenWorkspace('main', 'smoke', dirname(path), path)
    if (!opened.ok)
      throw new Error(`Smoke media could not be opened: ${JSON.stringify(opened)}`)
    try {
      const resource = await this.orchestrator.viewerMediaResource('main', opened.value.documentId)
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
      this.orchestrator.viewerRelease('main', opened.value.documentId)
    }
  }

  private async waitForSmoke<T>(
    phase: string,
    read: () => T | null,
    panelId: string | null,
  ): Promise<T> {
    const deadline = Date.now() + MainHub.smokePhaseTimeoutMillisecondsConst
    while (Date.now() < deadline) {
      const value = read()
      if (value !== null)
        return value
      await new Promise<void>((resolve) => setTimeout(resolve, MainHub.smokePollMillisecondsConst))
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

  private reloadFocused(): void {
    const target = this.workspaceWindows.focusedWorkspace() ?? this.workspaceWindows.main()
    target.reload()
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
      void this.shell.restart('menu')
        .catch((error: unknown) => this.report(`The restart failed: ${ErrorText.of(error)}`))
    else if (id === 'window.new')
      this.workspaceWindows.createHolder()
    // The result is drawn by the status bar's update item, so the menu asks no question of its own.
    else if (id === 'app.checkForUpdates')
      void this.autoUpdate.check()
    else
      throw new Error(`Command has no main-process handler: ${id}`)
  }

}
