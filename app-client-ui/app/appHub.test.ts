import { OrchestratorHub } from '../../app-orchestrator/app/appHub'
import { OrchestratorRequestMethodsConst, OrchestratorNoticeMethodsConst } from '../../lib-orchestrator/clientApi/orchestratorProcess'
import type { OrchestratorNativeApi } from '../../lib-orchestrator/clientApi/orchestratorProcess.types'
import { OrchestratorApiClient } from './processes/orchestratorApiClient'
import { PerfNames } from '../../lib-orchestrator/perfMonitor/perfNames'
import { ServiceTabRequestsIpc } from '../../app-orchestrator/app/tabs/serviceTabRequestsIpc'
import { ServiceFileViewerIpc } from '../../app-orchestrator/app/fileViewer/serviceFileViewerIpc'
import { ServiceFileViewerShellIpc } from './shell/serviceFileViewerShellIpc'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { IpcServiceTransport } from './shared/ipcServiceTransport'
import type { WebContents, MenuItemConstructorOptions } from 'electron'
import { readFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileChangesContext } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  TerminalDetector,
  TerminalDetectorDeps,
} from '../../lib-orchestrator/terminalDetector/terminalDetector'
import { AppClientUiBridgeEventsConst, AppClientUiChannelOwnersConst, GatewayChannelsConst } from '../shared/appClientUiIpc'
import type { CommandId } from '../shared/commands'
import { AutoUpdateConst } from '../shared/electron/autoUpdate/common/autoUpdateApi'
import type { AppContext } from './appContext'
import { MainHub } from './appHub'
import { ServiceChannels } from './shared/serviceChannels'
import type { ConfigSectionsCache } from './shared/configSectionsCache'
import type { OrchestratorApi } from './shared/orchestratorApi.types'
import type { ConfigStore } from '../../lib-orchestrator/configStore/configStore'
import type { RemoteControl } from '../../lib-orchestrator/remoteControl/remoteControl'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { UiSettings } from '../shared/uiSettings'
import { ClipboardAccess } from './shared/clipboardAccess'
import { WindowPeers } from '../../app-gateway/app/peers/windowPeers'
import { ViewerBuffer } from '../../app-gateway/app/terminals/viewerBuffer'
import type { RemoteOutboundPort } from '../../lib-orchestrator/remoteControl/remoteOutbound.types'
import type { ProcessCallContext } from '../../lib-orchestrator/shared/processCalls'
import { ServiceRemarkableIpc } from '../../app-orchestrator/app/remarkable/serviceRemarkableIpc'
import { ServiceShellIpc } from './shell/serviceShellIpc'
import { ServiceTabsIpc } from './tabs/serviceTabsIpc'
import { SessionReviewPortAdapter } from '../../app-orchestrator/app/versioning/sessionReviewPortAdapter'
import type { VersioningCommitManagerDeps } from '../../app-orchestrator/app/versioning/versioningCommitManager'

/** Hoisted with the mock factories: `vi.mock` runs before any top-level statement of this file. */
const { FakeWindow, captured, updaterMock } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class FakeWindow {
    static created: FakeWindow[] = []
    /** Every `webContents.send` this window received, as `[channel, ...args]`. */
    readonly sent: unknown[][] = []
    readonly listeners = new Map<string, Listener[]>()
    destroyed = false
    visible = true
    minimized = false
    focus_ = false
    reloads = 0
    title = ''
    icon: unknown = null
    readonly webContents = {
      mainFrame: {},
      on: () => {},
      once: () => {},
      setWindowOpenHandler: () => {},
      reload: () => {
        this.reloads += 1
      },
      isDestroyed: () => this.destroyed,
      send: (channel: string, ...args: unknown[]) => {
        this.sent.push([channel, ...args])
      },
    }

    constructor(readonly options: Record<string, unknown>) {
      FakeWindow.created.push(this)
    }

    /** What the shared updater broadcasts its status to. */
    static getAllWindows(): FakeWindow[] {
      return FakeWindow.created.filter((window) => !window.destroyed)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    isVisible(): boolean {
      return this.visible
    }

    isMinimized(): boolean {
      return this.minimized
    }

    isMaximized(): boolean {
      return false
    }

    isFocused(): boolean {
      return this.focus_
    }

    getBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 1200, height: 800 }
    }

    getNormalBounds(): { x: number; y: number; width: number; height: number } {
      return this.getBounds()
    }

    on(event: string, listener: Listener): void {
      const existing = this.listeners.get(event) ?? []
      existing.push(listener)
      this.listeners.set(event, existing)
    }

    maximize(): void {}
    show(): void {}
    focus(): void {}
    restore(): void {}
    setTitle(title: string): void { this.title = title }
    setIcon(icon: unknown): void { this.icon = icon }

    close(): void {
      this.destroyed = true
      this.emitWindow('close')
      this.emitWindow('closed')
    }

    loadFile(): Promise<void> {
      return Promise.resolve()
    }

    loadURL(): Promise<void> {
      return Promise.resolve()
    }

    emitWindow(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener()
    }
  }

  const captured = {
    orchestrator: null as unknown,
    processInvoke: null as null | ((target: string, method: string, args: unknown[], context: ProcessCallContext) => Promise<unknown>),
    processEvent: null as null | ((target: string, name: string, payload: unknown) => void),
    hostErrors: [] as string[],
    sessionDeps: null as null | {
      onChanged: () => void
      onError: (message: string) => void
      onScriptCollapsed?: (event: { runId: string; parentId: string; handoff: 'parent-tab' | 'close'; handoffTo: string }) => void
      onMainCopyUpdated?: (update: { sessionId: string; title: string; mainCopy: string; revision: number; by: 'person' | 'agent'; log: string | null }) => void
      svnAssembly?: unknown
      processPriorityOf?: () => string
    },
    reviewPort: null as unknown,
    receipts: [] as unknown[],
    rateDeps: null as null | {
      onChanged: () => void
      onError: (message: string) => void
    },
    visible: [] as boolean[],
    rateVisible: [] as boolean[],
    rateSessionChanges: 0,
    /** Both managers write their name here, so the order they are ended in is readable. */
    disposeOrder: [] as string[],
    menuTemplate: [] as MenuItemConstructorOptions[],
    menuBuilds: 0,
    ipcHandlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
    /** One worktree entry and one entry out of the history, which are two different code paths. */
    changedFilesConst: { worktree: 'C:/work/app/main.ts', history: 'C:/work/app/retired.ts' },
    changeListCalls: [] as FileChangesContext[],
    fileChangesExecutor: null as unknown,
    /** Which transcript view each reader was built with, in construction order. */
    transcriptViews: [] as [string, unknown][],
    remoteStarts: 0,
    remoteBeginStops: 0,
    remoteEvents: [] as string[],
    skillInstalls: 0,
    remarkableActions: [] as string[],
    remarkableInstallerOptions: null as null | { sourceDirectory: string; toolsDirectory: string },
    safeStorageCalls: [] as string[],
    appPath: 'C:/tmp/app/resources',
    /** The sessions the snapshot answers; null: the one parent to fork. */
    snapshotSessions: null as unknown[] | null,
    /** Every Windows notification shown, with its click. */
    notices: [] as { title: string; body: string; click: () => void }[],
    /** Every path handed to the desktop's own opener. */
    openedPaths: [] as string[],
  }

  /** How often anything read `autoUpdater`: reading it is what builds the platform updater. */
  const updaterMock = { reads: 0 }

  return { FakeWindow, captured, updaterMock }
})

vi.mock('electron', () => ({
  MessageChannelMain: class { port1 = {}; port2 = {} },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  app: {
    getAppMetrics: () => [],
    getAppPath: () => captured.appPath,
    getPath: () => 'C:/tmp/app/state',
    getVersion: () => '0.0.0',
    isPackaged: false,
    exit: () => {},
    relaunch: () => {},
    quit: () => {},
  },
  BrowserWindow: FakeWindow,
  Notification: class {
    static isSupported(): boolean { return true }
    private readonly options: { title: string; body: string }
    private readonly handlers = new Map<string, () => void>()
    constructor(options: { title: string; body: string }) {
      this.options = options
    }

    on(event: string, handler: () => void): void {
      this.handlers.set(event, handler)
    }

    show(): void {
      captured.notices.push({ ...this.options, click: () => this.handlers.get('click')?.() })
    }
  },
  nativeImage: {
    createFromDataURL: () => ({ isEmpty: () => false }),
    createFromBuffer: () => ({ isEmpty: () => false }),
  },
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      captured.ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => captured.ipcHandlers.delete(channel),
  },
  shell: { openExternal: () => Promise.resolve(), openPath: (path: string) => { captured.openedPaths.push(path); return Promise.resolve('') } },
  protocol: { handle: () => {} },
  Menu: {
    setApplicationMenu: () => {},
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      captured.menuBuilds += 1
      captured.menuTemplate = template
      return template
    },
  },
  safeStorage: {
    isAsyncEncryptionAvailable: () => {
      captured.safeStorageCalls.push('available')
      return Promise.resolve(true)
    },
    encryptStringAsync: () => {
      captured.safeStorageCalls.push('encrypt')
      return Promise.resolve(Buffer.from('encrypted'))
    },
    decryptStringAsync: () => {
      captured.safeStorageCalls.push('decrypt')
      return Promise.resolve({ result: 'password', shouldReEncrypt: false })
    },
  },
}))

// Never the real one: reaching `autoUpdater` builds the platform updater, which reads a version, a
// name and a userData path off an Electron `app` this mock does not have.
vi.mock('electron-updater', () => {
  const module = {
    get autoUpdater(): never {
      updaterMock.reads += 1
      throw new Error('A development run must never build the platform updater')
    },
  }
  // The member reads it through the default import, as CommonJS interop hands it over.
  return { default: module }
})

vi.mock('../../app-orchestrator/app/remarkable/sidecar/remarkableSidecarInstaller', () => ({
  RemarkableSidecarInstaller: class {
    constructor(options: { sourceDirectory: string; toolsDirectory: string }) {
      captured.remarkableInstallerOptions = options
    }

    status(): Promise<unknown> {
      captured.remarkableActions.push('installer:status')
      return Promise.resolve({ kind: 'missing', detail: 'not installed' })
    }

    install(): Promise<unknown> {
      captured.remarkableActions.push('installer:install')
      return Promise.resolve({
        ok: false,
        code: 'install-failed',
        detail: 'not installed',
        retryable: false,
      })
    }

    executable(): Promise<unknown> {
      captured.remarkableActions.push('installer:executable')
      return Promise.resolve({
        ok: false,
        code: 'sidecar-not-installed',
        detail: 'not installed',
        retryable: false,
      })
    }
  },
}))

vi.mock('../../app-orchestrator/app/remarkable/sidecar/remarkableCli', () => ({
  RemarkableCli: class {
    private call(method: string): Promise<unknown> {
      captured.remarkableActions.push(`cli:${method}`)
      return Promise.resolve({
        ok: false,
        code: 'sidecar-not-installed',
        detail: 'not installed',
        retryable: false,
      })
    }

    detectFingerprint(): Promise<unknown> { return this.call('detectFingerprint') }
    status(): Promise<unknown> { return this.call('status') }
    currentDocument(): Promise<unknown> { return this.call('currentDocument') }
    listPages(): Promise<unknown> { return this.call('listPages') }
    renderCurrent(): Promise<unknown> { return this.call('renderCurrent') }
    renderArchive(): Promise<unknown> { return this.call('renderArchive') }
  },
}))

vi.mock('../../lib-orchestrator/sessionManager/sessionManager', async (importOriginal) => ({
  SessionNotifier: (await importOriginal<typeof import('../../lib-orchestrator/sessionManager/sessionManager')>()).SessionNotifier,
  SessionManager: class {
    noteHostError(message: string): void { captured.hostErrors.push(message); captured.sessionDeps?.onError(message) }
    ratesChanged(): void { captured.rateSessionChanges += 1 }
    constructor(deps: {
      onChanged: () => void
      onError: (message: string) => void
    }) {
      captured.sessionDeps = deps
    }

    setWindowVisible(visible: boolean): void {
      captured.visible.push(visible)
    }

    // No session exists here, so nothing a detected restore is handed can lean on a session root.
    workingContext(): Promise<{ ok: false; code: string; detail: string }> {
      return Promise.resolve({ ok: false, code: 'unknown-session', detail: 'no session under test' })
    }

    /** One session to fork: the control API names a session by the snapshot before it acts on it. */
    processTree() { return { roots: [], sampledAt: 0 } }
    snapshot(): unknown {
      return {
        revision: 1, reconciled: true, categories: [], orphans: [],
        host: { presence: 'running', hostVersion: null, hostInstanceId: null, liveCount: 0, lastStartError: null },
        sessions: captured.snapshotSessions ?? [{
          sessionId: 'parent-1', kind: 'shell', title: 'Work - 014', tabTitle: 'Work - 014',
          titleParts: { number: '014', name: 'Work' }, directory: { mode: 'default' },
          project: { kind: 'none' }, life: 'ended', activity: null, admits: [],
        }],
      }
    }

    /** The one operation whose answer the hub reads rather than forwards; see the fork case below. */
    forkSession(): Promise<{ ok: true; value: { sessionId: string; tabTitle: string } }> {
      return Promise.resolve({ ok: true, value: { sessionId: 'fork-1', tabTitle: 'Work - 014-015' } })
    }

    setReviewPort(port: unknown): void {
      captured.reviewPort = port
    }

    noteCommitted(receipt: unknown): void {
      captured.receipts.push(receipt)
    }

    worktreeResultsStore(): unknown {
      return { notifySource: () => ({ pending: () => [], note: async () => undefined }) }
    }

    sessionNotifyStore(): unknown {
      return { pending: () => [], note: async () => undefined, watched: () => [], observe: async () => [] }
    }

    svnWaitNotices(): unknown {
      return { pending: () => [], note: async () => undefined }
    }

    workerHandoffs(): unknown {
      return { pending: () => [], note: async () => undefined }
    }

    async start(): Promise<void> {}
    recordsSettled(): boolean { return true }
    async stop(): Promise<void> {
      captured.disposeOrder.push('sessions')
    }
  },
}))

/** The tier-2 source, stubbed at the seam the hub calls: one worktree entry and one historical. */
vi.mock('../../lib-orchestrator/fileChangesManager/fileChangesManager', () => ({
  FileChangesManager: class {
    constructor(deps: { diffExecutor: unknown }) {
      captured.fileChangesExecutor = deps.diffExecutor
    }

    list(context: FileChangesContext): Promise<unknown> {
      captured.changeListCalls.push(context)
      return Promise.resolve({
        ok: true,
        value: {
          entries: [{ path: captured.changedFilesConst.worktree, nodeKind: 'file' }],
          history: {
            groups: [{
              entries: [{ path: captured.changedFilesConst.history, nodeKind: 'file' }],
            }],
          },
        },
      })
    }
  },
}))

vi.mock('../../lib-orchestrator/rateMonitor/rateMonitor', () => ({
  RateMonitor: class {
    constructor(deps: { onChanged: () => void; onError: (message: string) => void }) {
      captured.rateDeps = deps
    }

    setWindowVisible(visible: boolean): void {
      captured.rateVisible.push(visible)
    }

    async start(): Promise<void> {}

    stop(): void {
      captured.disposeOrder.push('rate')
    }
  },
}))

vi.mock('../../lib-orchestrator/agentCliUpdates/agentCliUpdates', () => ({
  AgentCliUpdates: class {
    snapshot(): { revision: number; agents: never[] } { return { revision: 0, agents: [] } }
    start(): void {}
    async stop(): Promise<void> {}
  },
}))

vi.mock('../../lib-orchestrator/projectManager/projectManager', () => ({
  ProjectManager: class {
    /** The memo-carrying view. Resolving a Codex rollout is not free, and this pair is POLLED. */
    readonly transcripts = { owner: 'the project manager' }

    async start(): Promise<void> {}
  },
}))

vi.mock('../../lib-orchestrator/sessionModelReader/sessionModelReader', () => ({
  SessionModelReader: class {
    constructor(deps: { transcripts: unknown }) {
      captured.transcriptViews.push(['model', deps.transcripts])
    }
  },
}))

vi.mock('../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReader', () => ({
  SessionTranscriptReader: class {
    constructor(deps: { transcripts: unknown }) {
      captured.transcriptViews.push(['transcript', deps.transcripts])
    }
  },
}))

vi.mock('../../app-orchestrator/app/remoteControl/remoteControlServer', () => ({
  RemoteControlServer: class {
    start(): Promise<Record<string, never>> {
      captured.remoteStarts += 1
      return Promise.resolve({})
    }

    beginStop(): void {
      captured.remoteBeginStops += 1
    }

    async stop(): Promise<void> {
      captured.disposeOrder.push('control')
    }

    publishEvent(kind: string): void {
      captured.remoteEvents.push(kind)
    }
  },
}))

vi.mock('../../app-orchestrator/app/skills/skillLinkInstaller', () => ({
  SkillLinkInstaller: class {
    skipReason(): null { return null }
    install(): readonly [] {
      captured.skillInstalls += 1
      return []
    }
  },
}))

vi.mock('../../app-orchestrator/app/tokenUsage/tokenUsageWorker', () => ({ TokenUsageWorker: class {
  start(): void {}
  beginStop(): void {}
  async stop(): Promise<void> {}
  async refresh(): Promise<void> {}
  snapshot() { return { buckets: [], labels: {}, accountLabels: {}, progress: { running: false, completed: 0, total: 0, error: null, scannedAt: null } } }
} }))

vi.mock('../../app-orchestrator/app/remoteControl/gatewayPeerClient', () => ({ GatewayPeerClient: class {
  async initialize(): Promise<void> {}
  runtime() { return { status: 'disabled' as const } }
  snapshot() { return [] }
  async apply() { return { ok: true as const } }
  async updateTrust(): Promise<void> {}
  async closeEndpoint(): Promise<void> {}
  publishEvent(): void {}
  beginStop(): void {}
  async stop(): Promise<void> {}
  event(): void {}
} }))

vi.mock('./processes/childProcessSupervisor', () => ({ ChildProcessSupervisor: class {
  async start(kind: string): Promise<void> { if (kind === 'orchestrator') await (captured.orchestrator as OrchestratorHub).initialize() }
  orchestrationPort(): void {}
  beginQuit(): void {}
  async stopAll(): Promise<void> { await (captured.orchestrator as OrchestratorHub).dispose() }
} }))

vi.mock('../../lib-orchestrator/shared/processCalls', () => ({ ProcessCalls: class {
  constructor(deps: { event: (target: string, name: string, payload: unknown) => void; invoke: NonNullable<typeof captured.processInvoke> }) { captured.processEvent = deps.event; captured.processInvoke = deps.invoke }
  async call(target: string, method: string): Promise<unknown> {
    if (target === 'outbound' && method === 'initialize') return
    if (target === 'outbound' && method === 'network-state') return { listener: { status: 'disabled' }, connections: { revision: 0, outbound: [], inbound: [] } }
    throw new Error(`Unexpected fixture call: ${target}/${method}`)
  }
  emit(target: string, name: string): boolean {
    if (target === 'outbound' && ['profiles', 'retry', 'changed', 'stop'].includes(name)) return true
    throw new Error(`Unexpected fixture event: ${target}/${name}`)
  }
  close(): void {}
} }))

vi.mock('./processes/orchestratorApiClient', () => ({ OrchestratorApiClient: class {
  readonly api = {} as OrchestratorNativeApi
  readonly deps: ConstructorParameters<typeof OrchestratorApiClient>[0]
  constructor(deps: ConstructorParameters<typeof OrchestratorApiClient>[0]) { this.deps = deps }
  initialized(): void {}
  beginQuit(): void { (captured.orchestrator as OrchestratorHub).beginQuit() }
  shellChanged(): void {}
  close(): void {}
} }))

describe('app-client-ui/app/appHub', () => {
  const orchestrators = new WeakMap<MainHub, object>()
  function orchestratorOf(hub: MainHub): object {
    const owner = orchestrators.get(hub)
    if (!owner) throw new Error('No orchestration owner was composed')
    return owner
  }
  let stateRoot: string

  function hubUnderTest(): MainHub {
    const context = {
      appName: 'Jamat V3',
      smoke: true,
      appVersion: '0.0.0',
      fileDiffWorkerPath: 'fileDiffWorker.js',
      svnAssemblyWorkerPath: 'svnAssemblyWorker.js',
      tokenUsageWorkerPath: 'tokenUsageWorker.js',
      preloadPath: 'preload.js',
      rendererPath: 'index.html',
      rendererDevUrl: undefined,
      appInfo: {},
      config: {
        configDir: join(stateRoot, 'config'),
        runtimeChannel: 'development',
        identity: { configIdentity: 'app-hub-test' },
      },
    } as unknown as AppContext
    const hub = new MainHub(context, vi.fn())
    const native = hub as unknown as { shell: ConstructorParameters<typeof OrchestratorHub>[1]; serviceTransport: IpcServiceTransport;
      gatewayCalls: ConstructorParameters<typeof OrchestratorHub>[3]; perf: ConstructorParameters<typeof OrchestratorHub>[4]; orchestratorClient: OrchestratorApiClient }
    const client = native.orchestratorClient as unknown as { deps: ConstructorParameters<typeof OrchestratorApiClient>[0] }
    const owner = new OrchestratorHub({ config: context.config, appVersion: context.appVersion, smoke: true, privateStateRoot: true,
      applicationRoot: '.', resourcesPath: '.', isPackaged: false, fileDiffWorkerPath: 'fileDiffWorker.cjs',
      tokenUsageWorkerPath: 'tokenUsageWorker.cjs', svnAssemblyWorkerPath: 'svnAssemblyWorker.cjs',
      build: { version: 'test', inputHash: 'test', builtAt: 'test' } }, native.shell, native.serviceTransport, native.gatewayCalls,
      native.perf, new PerfNames(Object.keys(MainHub.ipcChannelsConst)), event => client.deps.event(event))
    captured.orchestrator = owner
    captured.processEvent = (target, name, payload) => owner.transport.event(target, name, payload)
    const api: Record<string, unknown> = { processTree: () => owner.api.processTree(), snapinDefinitions: () => owner.api.snapinDefinitions() }
    for (const name of OrchestratorRequestMethodsConst) api[name] = async (...args: unknown[]) => (owner.api[name] as (...values: unknown[]) => unknown)(...args)
    for (const name of OrchestratorNoticeMethodsConst) api[name] = (...args: unknown[]) => (owner.api[name] as (...values: unknown[]) => unknown)(...args)
    Object.assign(hub, { orchestrator: api as unknown as OrchestratorNativeApi })
    orchestrators.set(hub, owner)
    return hub
  }

  /** The menu is the only way in to the commands, and the mocked Menu is where its template lands. */
  function clickMenuItem(label: string): void {
    for (const section of captured.menuTemplate)
      for (const item of (section.submenu ?? []) as MenuItemConstructorOptions[])
        if (item.label === label) {
          item.click?.(
            undefined as never,
            undefined as never,
            undefined as never,
          )
          return
        }
    throw new Error(`no menu item labelled ${label}`)
  }

  type OpenWindow = InstanceType<typeof FakeWindow>

  interface RoutedWindow {
    sent: unknown[][]
    reloads: number
    publish(channel: string, ...args: unknown[]): void
    reload(): void
  }

  function routedWindow(): RoutedWindow {
    return {
      sent: [],
      reloads: 0,
      publish(channel, ...args) {
        this.sent.push([channel, ...args])
      },
      reload() {
        this.reloads += 1
      },
    }
  }

  function replaceWorkspaceRegistry(
    hub: MainHub,
    main: RoutedWindow,
    holder: RoutedWindow,
    focused: () => RoutedWindow | null,
  ): void {
    const registry = {
      main: () => main,
      focusedWorkspace: focused,
      broadcast: (channel: string, ...args: unknown[]) => {
        main.publish(channel, ...args)
        holder.publish(channel, ...args)
      },
    }
    Object.assign(hub, { workspaceWindows: registry })
    const transport = (hub as unknown as { serviceTransport: IpcServiceTransport }).serviceTransport
    for (const [windowId, window] of [['main', main], ['holder', holder]] as const)
      transport.watch({ on: () => undefined, isDestroyed: () => false,
        send: (channel: string, ...args: unknown[]) => window.publish(channel, ...args),
      } as unknown as WebContents, { windowId, role: windowId === 'main' ? 'main' : 'workspace' })
  }

  function mainWindow(): OpenWindow {
    const [main] = FakeWindow.created
    if (!main) throw new Error('the main window has to be open for this')
    return main
  }

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-app-hub-test-'))
    process.env.JAMAT_V3_LOCAL_STATE_DIR = stateRoot
    FakeWindow.created = []
    captured.sessionDeps = null
    captured.processEvent = null
    captured.hostErrors = []
    captured.reviewPort = null
    captured.receipts = []
    captured.rateDeps = null
    captured.visible = []
    captured.rateVisible = []
    captured.disposeOrder = []
    captured.menuTemplate = []
    captured.menuBuilds = 0
    captured.ipcHandlers.clear()
    captured.changeListCalls = []
    captured.fileChangesExecutor = null
    captured.remoteStarts = 0
    captured.remoteBeginStops = 0
    captured.remoteEvents = []
    captured.skillInstalls = 0
    captured.remarkableActions = []
    captured.remarkableInstallerOptions = null
    captured.safeStorageCalls = []
    captured.appPath = join(stateRoot, 'application', 'resources')
    captured.snapshotSessions = null
    captured.notices = []
    updaterMock.reads = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    rmSync(stateRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /*
   * The mock's `app.isPackaged` is false, which is a development run: the updater answers its
   * channels with "off" and never builds the platform updater, and the menu's check asks nothing.
   */
  it('answers the update channels at boot without building the updater in a development run', async () => {
    const hub = hubUnderTest()

    await hub.initialize()
    const status = await captured.ipcHandlers.get(AutoUpdateConst.channelStatus)?.()
    ;(hub as unknown as { runMainCommand(id: string): void }).runMainCommand('app.checkForUpdates')

    expect(status).toMatchObject({ running: '0.0.0', mode: 'off', releasePage: true, state: { kind: 'off' } })
    expect(updaterMock.reads).toBe(0)
  })

  it('routes gateway diagnostics to Host recording and the existing app error broadcast once', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    captured.processEvent?.('diagnostics', 'host-error', 'Host fixture failure')
    captured.processEvent?.('diagnostics', 'terminal-error', 'Terminal fixture failure')
    expect(captured.hostErrors).toEqual(['Host fixture failure'])
    expect(FakeWindow.created[0].sent.filter(message => message[0] === 'app:error')).toEqual([
      ['app:error', 'Host fixture failure'], ['app:error', 'Terminal fixture failure'],
    ])
  })

  it('installs the AppJamatV3 skill links during initialization', async () => {
    const hub = hubUnderTest()

    await hub.initialize()

    expect(captured.skillInstalls).toBe(1)
  })

  // Debug and Usage are workspace tabs, so a visible workspace window is the whole question.
  it('keeps the cadence while a workspace window can be seen', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = FakeWindow.created[0]
    const visibility = hub as unknown as { visibleWorkspaceWindowIds: Set<string> }

    expect(visibility.visibleWorkspaceWindowIds).toEqual(new Set(['main']))

    main.visible = false
    main.emitWindow('hide')
    expect(captured.visible.at(-1)).toBe(false)
    expect(visibility.visibleWorkspaceWindowIds).toEqual(new Set())

    main.visible = true
    main.emitWindow('show')
    expect(captured.visible.at(-1)).toBe(true)
    expect(visibility.visibleWorkspaceWindowIds).toEqual(new Set(['main']))
  })

  it('gives the rate monitor the visibility of the workspace windows', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = FakeWindow.created[0]

    expect(captured.rateVisible.at(-1)).toBe(true)

    main.visible = false
    main.emitWindow('hide')
    expect([captured.visible.at(-1), captured.rateVisible.at(-1)]).toEqual([false, false])

    main.visible = true
    main.emitWindow('show')
    expect([captured.visible.at(-1), captured.rateVisible.at(-1)]).toEqual([true, true])
  })

  it('tells every workspace window that the rate limits moved and that reading them failed', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = routedWindow()
    const holder = routedWindow()
    replaceWorkspaceRegistry(hub, main, holder, () => holder)

    const before = captured.rateSessionChanges
    captured.rateDeps?.onChanged()
    expect(captured.rateSessionChanges).toBe(before + 1)
    captured.rateDeps?.onError('the usage endpoint answered 429')

    for (const window of [main, holder])
      expect(window.sent).toContainEqual(['rate:changed'])
    expect(main.sent).toContainEqual(['app:error', 'the usage endpoint answered 429'])
  })

  // reMarkable may own an active child or a noninterruptible atomic copy, so it is aborted and
  // awaited before the other child owners. The diff worker is next because it may be terminating.
  it('awaits reMarkable before the other child owners and removes control discovery immediately', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    Object.assign(orchestratorOf(hub), {remarkable: {
        beginStop: () => undefined,
        stop: () => {
          captured.disposeOrder.push('remarkable')
          return Promise.resolve()
        },
      },
fileDiffWorker: {
        beginStop: () => undefined,
        stop: () => {
          captured.disposeOrder.push('diff')
          return Promise.resolve()
        },
      },
svnAssemblyWorker: {
        stop: () => {
          captured.disposeOrder.push('assembly')
          return Promise.resolve()
        },
      }})

    await hub.dispose()

    expect(captured.disposeOrder).toEqual(['remarkable', 'diff', 'rate', 'control', 'sessions', 'assembly'])
    expect(captured.remoteBeginStops).toBe(1)
  })

  it.each(['initializeInbound', 'initializeOutbound'] as const)('does not register late domain services after quit during %s', async stage => {
    const hub = hubUnderTest(), orchestration = orchestratorOf(hub) as OrchestratorHub
    let release!: () => void
    const held = vi.spyOn(orchestration.api, stage).mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const configure = vi.spyOn(orchestration.api, 'configureServices')
    const services = vi.spyOn(orchestration.api, 'initializeFileViewerIpc')
    try {
      const initializing = orchestration.initialize()
      await vi.waitFor(() => expect(held).toHaveBeenCalledOnce())
      orchestration.beginQuit()
      release()
      await initializing
      expect(configure).not.toHaveBeenCalled()
      expect(services).not.toHaveBeenCalled()
      await orchestration.dispose()
    } finally { held.mockRestore(); configure.mockRestore(); services.mockRestore() }
  })

  it.each(['sessions', 'early-worker'] as const)('bounds unresolved %s disposal before the independent gateway stop', async stalled => {
    vi.useFakeTimers()
    const hub = hubUnderTest(), reports = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    const hanging = () => { calls.push('hung'); return new Promise<void>(() => {}) }
    if (stalled === 'sessions') Object.assign(orchestratorOf(hub), {sessions: { stop: hanging }})
    else if (stalled === 'early-worker') Object.assign(orchestratorOf(hub), {remarkable: { beginStop() {}, stop: hanging }})
    else throw new Error('Unknown stalled owner')
    Object.assign(orchestratorOf(hub), {svnAssemblyWorker: { stop: async () => { calls.push('assembly') } },
tokenUsage: { beginStop() {}, stop: async () => { calls.push('token') } }})
    Object.assign(hub, {perf: { stop: async () => { calls.push('perf') } },
children: { stopAll: async () => { await (orchestratorOf(hub) as OrchestratorHub).dispose(); calls.push('gateway'); await new Promise<void>(resolve => setTimeout(resolve, 3_000)) } }})
    try {
      let settled = false
      const work = hub.dispose().then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(13_999)
      expect(calls).not.toContain('gateway')
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toContain('assembly')
      expect(calls).toContain('token')
      expect(calls).toContain('perf')
      expect(calls.at(-1)).toBe('gateway')
      expect(settled).toBe(false)
      expect(reports.mock.calls.flat().join(' ')).toContain('Session records settlement is unconfirmed')
      await vi.advanceTimersByTimeAsync(2_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await work
      expect(calls).toContain('perf')
      expect(settled).toBe(true)
    } finally { vi.useRealTimers(); reports.mockRestore() }
  })

  it('keeps both authorized clipboard hops pending through healthy sequential file chunks beyond 30 seconds', async () => {
    const { ProcessCalls } = await vi.importActual<typeof import('../../lib-orchestrator/shared/processCalls')>('../../lib-orchestrator/shared/processCalls')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    const hub = hubUnderTest(), invoke = captured.processInvoke!
    const source = join(stateRoot, 'clipboard-file.bin')
    writeFileSync(source, Buffer.alloc(1_100_000, 7))
    const clipboard = vi.spyOn(ClipboardAccess, 'readText').mockReturnValue(source)
    const lifetime = new AbortController(), chunks: { offset: number; bytes: number }[] = [], pending: string[] = []
    const arrivals = Array.from({ length: 3 }, () => {
      let ready!: () => void
      const promise = new Promise<void>(resolve => { ready = resolve })
      return { promise, ready }
    })
    const delays = new Set<() => void>()
    let work: Promise<unknown> | undefined, settled: Promise<void> | undefined, nativeSettled: Promise<void> | undefined
    const outbound = {
      attachTerminal: async (_endpoint: string, id: string) => ({ ok: true, value: { attachId: id, sessionId: 'session' } }),
      detachTerminal: async () => ({ ok: true, value: {} }),
      terminalPasteFile: async (_endpoint: string, _id: string, chunk: { offset: number; data: string; size: number }) => {
        const bytes = Buffer.from(chunk.data, 'base64').length
        chunks.push({ offset: chunk.offset, bytes })
        await new Promise<void>(resolve => {
          const finish = (): void => { clearTimeout(timer); delays.delete(finish); resolve() }
          const timer = setTimeout(finish, 11_000)
          delays.add(finish)
          arrivals[chunks.length - 1]!.ready()
        })
        return { ok: true, value: { path: chunk.offset + bytes === chunk.size ? 'D:/remote/clipboard-file.bin' : null } }
      },
    } as unknown as RemoteOutboundPort
    const output = new ViewerBuffer({ bytesOf: () => 1, send() {}, truncate() {}, resume() {} })
    const owner = new WindowPeers('window', true, { outbound: () => outbound,
      snapshot: () => ({ revision: 0, outbound: [], inbound: [] }), releaseMedia() {},
      clipboard: (endpoint, id, signal) => gateway.call('outbound-work', 'clipboard', ['window', 'epoch', endpoint, id], { signal }),
    }, output, { span: (_name, run) => run() }, message => { throw new Error(message) }, () => { throw new Error('Unexpected window failure') })
    const unused = async () => { throw new Error('Unexpected reverse call') }
    const report = (message: string) => { throw new Error(message) }
    const gateway = new ProcessCalls({ send: message => main.receive(message), invoke: unused, event() {}, report })
    const main = new ProcessCalls({ send: message => { if (message.type === 'pending') pending.push('main'); gateway.receive(message) },
      invoke: (...args) => {
        const operation = invoke(...args)
        nativeSettled = operation.then(() => {}, () => {})
        return operation
      }, event() {}, report })
    const renderer = new ProcessCalls({ send: message => windowCalls.receive(message), invoke: unused, event() {}, report })
    const windowCalls = new ProcessCalls({ send: message => { if (message.type === 'pending') pending.push('window'); renderer.receive(message) },
      invoke: (_target, method, args, context) => owner.invoke({ method, args } as never, context), event() {}, report })
    Object.assign(hub, { gatewayCalls: { call: (target: string, method: string, args: unknown[]) => {
      expect([target, method]).toEqual(['windows', 'remote-paste-file'])
      expect(args.slice(0, 2)).toEqual(['window', 'epoch'])
      return owner.pasteFile(args[2] as string, args[3] as string, args[4] as never)
    } } })
    Object.assign(hub, {windowPorts: { sender: () => ({}), signal: () => lifetime.signal },
workspaceWindows: { acceptsRenderer: () => true }})
    const heartbeat = setInterval(() => { renderer.alive(); gateway.alive() }, 1_000)
    try {
      await renderer.call('remote', 'remote:terminal-attach', ['endpoint', 'attach', { sessionId: 'session', size: null }])
      work = renderer.call('remote', 'remote:terminal-clipboard-paste', ['endpoint', 'attach'])
      settled = work.then(() => {}, () => {})
      for (let index = 0; index < 3; index++) {
        await Promise.race([arrivals[index]!.promise,
          work.then(() => { throw new Error(`Clipboard transfer ended before chunk ${index + 1}`) })])
        expect(chunks).toHaveLength(index + 1)
        await vi.advanceTimersByTimeAsync(11_000)
      }
      expect(await work).toEqual({ ok: true, value: { kind: 'text', text: 'D:/remote/clipboard-file.bin' } })
      expect(performance.now()).toBeGreaterThan(30_000)
      expect(pending).toEqual(['window', 'main'])
      expect(chunks.map(chunk => chunk.offset)).toEqual([0, 524_288, 1_048_576])
    } finally {
      clearInterval(heartbeat)
      owner.close(); output.close()
      for (const calls of [renderer, windowCalls, gateway, main]) calls.close()
      for (const finish of delays) finish()
      await settled
      await nativeSettled
      clipboard.mockRestore(); vi.useRealTimers()
    }
  })

  it('gives the sessions the commit dialog once its broker exists', () => {
    hubUnderTest()

    expect(captured.reviewPort).toBeInstanceOf(SessionReviewPortAdapter)
  })

  it('hands every receipt of the commit dialog to the sessions', () => {
    const hub = orchestratorOf(hubUnderTest()) as unknown as { commits: { deps: VersioningCommitManagerDeps } }
    const receipt = { sessionId: 'parent-1', scopes: [{ scopeRoot: 'C:/work/app', revision: 12 }], paths: ['C:/work/app/main.ts'] }

    hub.commits.deps.committed?.(receipt)

    expect(captured.receipts).toEqual([receipt])
  })

  it('gives the sessions the process priority of the agents settings, below normal by default', () => {
    hubUnderTest()

    expect(captured.sessionDeps?.processPriorityOf?.()).toBe('below-normal')
  })

  it('gives the sessions one svn assembly worker', () => {
    const hub = hubUnderTest()

    expect(captured.sessionDeps?.svnAssembly).toBe((orchestratorOf(hub) as unknown as { svnAssemblyWorker: unknown }).svnAssemblyWorker)
  })

  it('owns one lazy diff worker and gives it to the file changes manager', () => {
    const hub = hubUnderTest()
    const worker = (orchestratorOf(hub) as unknown as { fileDiffWorker: unknown }).fileDiffWorker

    expect(captured.fileChangesExecutor).toBe(worker)
  })

  it('boots without a sidecar seed, CLI call, install call or secure-storage prompt', async () => {
    const hub = hubUnderTest()
    const sourceDirectory = captured.remarkableInstallerOptions?.sourceDirectory
    if (sourceDirectory === undefined) throw new Error('The hub did not construct the installer')
    expect(existsSync(sourceDirectory)).toBe(false)

    await hub.initialize()

    expect(captured.remarkableActions).toEqual([])
    expect(captured.safeStorageCalls).toEqual([])
  })

  /*
   * The half `preload/index.test.ts` cannot see. It proves every event channel has a SUBSCRIBER;
   * this proves every one has a PUBLISHER, which is the only thing that makes a subscription worth
   * having. Read off the source because an event is published from wherever it happens - the shell,
   * the tab brokers, the rate monitor - and no runtime seam collects them.
   */
  it('publishes every event channel from its main or window-port owner', () => {
    const mainProcessDir = join(dirname(fileURLToPath(import.meta.url)))
    const sources: string[] = []
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
          sources.push(readFileSync(path, 'utf8'))
      }
    }
    walk(mainProcessDir)
    walk(join(mainProcessDir, '../../app-orchestrator/app'))
    const mainSources = [...sources]
    sources.length = 0
    walk(join(mainProcessDir, '../preload'))
    const portSources = [...sources]

    const unpublished = Object.values(AppClientUiBridgeEventsConst)
      .filter(channel => {
        const owner = AppClientUiChannelOwnersConst[channel] ?? 'main'
        if (owner === 'main') return !mainSources.some(source => source.includes(`'${channel}'`))
        else if (owner === 'gateway') return !portSources.some(source => source.includes(`'${channel}'`))
        else if (owner === 'orchestrator') return !mainSources.some(source => source.includes("'" + channel + "'"))
        else throw new Error(`Unknown channel owner: ${owner}`)
      })

    expect(unpublished).toEqual([])
  })

  /*
   * Both readers over ONE view, and the project manager's own. A view of their own would have no
   * memo behind its index, and resolving a Codex rollout means walking a directory - which this
   * pair does on every poll, for every session on screen.
   */
  it('gives both transcript readers the project manager’s memo-carrying view', async () => {
    // Every hub this file builds writes here, so only THIS hub's pair is read.
    captured.transcriptViews.length = 0
    const hub = hubUnderTest()
    await hub.initialize()
    const projects = (orchestratorOf(hub) as unknown as { projects: { transcripts: unknown } }).projects

    expect(captured.transcriptViews.map(([reader]) => reader)).toEqual(['model', 'transcript'])
    for (const [reader, view] of captured.transcriptViews)
      expect(view, reader).toBe(projects.transcripts)
  })

  /*
   * Compaction and the control API already share one terminal and its one-delivery-at-a-time guard.
   * An import with a terminal of its own could erase a prompt a compact is typing into.
   */
  it('gives the Notes import the terminal compaction delivers through', () => {
    const hub = hubUnderTest()
    const services = orchestratorOf(hub) as unknown as {
      contextCompactionIpc: { terminal: unknown }
      directoryNotes: { terminal: unknown }
    }

    expect(services.directoryNotes.terminal).toBeDefined()
    expect(services.directoryNotes.terminal).toBe(services.contextCompactionIpc.terminal)
  })

  it('wakes coordinators through the terminal the control API delivers through, and stops with the hub', async () => {
    const hub = hubUnderTest()
    const services = orchestratorOf(hub) as unknown as {
      directoryNotes: { terminal: unknown }
      sessionNotifier: { port: { terminal: unknown }; started: boolean; sources: readonly unknown[] }
    }

    expect(services.sessionNotifier.port.terminal).toBe(services.directoryNotes.terminal)
    expect(services.sessionNotifier.sources).toHaveLength(5)
    await hub.initialize()
    expect(services.sessionNotifier.started).toBe(true)
    await hub.dispose()
    expect(services.sessionNotifier.started).toBe(false)
  })

  it('holds the final IPC parity counts', () => {
    expect(Object.keys(MainHub.ipcChannelsConst)).toHaveLength(181)
    expect(Object.keys(GatewayChannelsConst)).toHaveLength(41)
    expect(Object.keys(MainHub.ipcChannelsConst).filter(channel => !(channel in GatewayChannelsConst))).toHaveLength(140)
    expect(Object.keys(AppClientUiBridgeEventsConst)).toHaveLength(28)
    expect(AppClientUiBridgeEventsConst).toHaveProperty('onUsageChanged', 'usage:changed')
    expect(AppClientUiBridgeEventsConst).toHaveProperty('onSnapinsChanged')
    expect(Object.keys({ ...ServiceTabsIpc.channelsConst, ...ServiceTabRequestsIpc.channelsConst })).toHaveLength(19)
    expect(Object.keys(ServiceTabsIpc.channelsConst)).toHaveLength(13)
    expect(Object.keys(ServiceTabRequestsIpc.channelsConst)).toHaveLength(6)
    expect(Object.keys({ ...ServiceFileViewerIpc.channelsConst, ...ServiceFileViewerShellIpc.channelsConst })).toHaveLength(20)
    expect(Object.keys(ServiceFileViewerIpc.channelsConst)).toHaveLength(16)
    expect(Object.keys(ServiceFileViewerShellIpc.channelsConst)).toHaveLength(4)
    expect(Object.keys(ServiceRemarkableIpc.channelsConst)).toHaveLength(16)
  })

  /*
   * The third gate, measured at the boot it protects: `satisfies` proves the subsets cover the
   * contract and the merge proves no two claim a channel, but neither proves anybody
   * handled one. A service constructed and never initialized passes both and leaves its channels
   * empty for the renderer's first call.
   */
  it('leaves no channel of the contract without a handler once it has booted', async () => {
    const hub = hubUnderTest()
    // Read at the first window rather than after the boot: a renderer calls as soon as it loads.
    const workspace = (hub as unknown as {
      workspaceWindows: { restoreAtStart(): void }
    }).workspaceWindows
    const restore = workspace.restoreAtStart.bind(workspace)
    let handledAtRestore: string[] = []
    workspace.restoreAtStart = () => {
      handledAtRestore = [...captured.ipcHandlers.keys()]
      restore()
    }

    await hub.initialize()

    expect([...handledAtRestore, ...Object.keys(GatewayChannelsConst)])
      .toEqual(expect.arrayContaining(Object.keys(MainHub.ipcChannelsConst)))

    // The updater's channels return raw values rather than IpcResult, so they are not in the contract.
    const updateChannels = [
      AutoUpdateConst.channelStatus,
      AutoUpdateConst.channelCheck,
      AutoUpdateConst.channelInstall,
      AutoUpdateConst.channelOpenReleasePage,
    ]
    expect([...captured.ipcHandlers.keys(), ...Object.keys(GatewayChannelsConst)].sort())
      .toEqual([...Object.keys(MainHub.ipcChannelsConst), ...updateChannels].sort())
    for (const channel of Object.keys(GatewayChannelsConst)) expect(captured.ipcHandlers.has(channel)).toBe(false)
  })

  /*
   * The detector's second tier, which is what a half-written path in a terminal is matched against,
   * and the reason it is held for a moment: `list()` files a snapshot nobody owns into a store
   * bounded at 32, so a run of right clicks would evict the ones open diff panels are drawn from.
   */
  it('hands the detector every changed path, and lists them once for a burst of clicks', async () => {
    const hub = hubUnderTest()
    const detector = (orchestratorOf(hub) as unknown as {
      terminalDetector: { deps: TerminalDetectorDeps }
    }).terminalDetector.deps
    const context: FileChangesContext = { sessionId: 's-1', cwd: 'C:/work', agent: null }

    const first = await detector.changedPaths(context)
    const second = await detector.changedPaths(context)

    expect(first).toEqual([
      { path: captured.changedFilesConst.worktree },
      { path: captured.changedFilesConst.history },
    ])
    expect(first.every((hint) => isAbsolute(hint.path))).toBe(true)
    expect(second).toEqual(first)
    expect(captured.changeListCalls).toEqual([context])
  })

  /*
   * The whole `proof-expired` decision, taken against the detector's real register: a stored layout
   * naming a path outside the session's own filesystem root reopens nothing until this run of the
   * app proved that path itself.
   */
  it('restores a detected file only once the detector has recorded the open', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const file = join(stateRoot, 'report.md')
    writeFileSync(file, '# Report\n')
    // `realpathSync` is the JS resolver and keeps an 8.3 short name; the native one, like the
    // promise API the service uses, expands it.
    const real = realpathSync.native(file)
    const restore = captured.ipcHandlers.get('fileViewer:restore')
    if (!restore)
      throw new Error('The hub registered no file viewer restore handler')
    const sender = FakeWindow.created[0].webContents
    const source = { kind: 'detected', sessionId: 's-1', path: file }

    expect(await restore({ sender, senderFrame: sender.mainFrame }, source, false)).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'proof-expired',
        detail: 'The terminal detection behind this file is gone; open it from the terminal again',
      },
    })

    ;(orchestratorOf(hub) as unknown as { terminalDetector: TerminalDetector }).terminalDetector
      .markOpened(real, 'file')
    const allowed = await restore({ sender, senderFrame: sender.mainFrame }, source, false) as {
      ok: true
      value: { ok: true; value: { source: unknown } }
    }

    expect(allowed.value.value.source).toEqual({ kind: 'detected', sessionId: 's-1', path: real })
  })

  it('finds an exact panel id in a durable layout rather than a prefix', () => {
    const hub = hubUnderTest()
    const internals = hub as unknown as {
      store: { saveLayout(windowId: string, layout: string): boolean }
      smokeLayoutContains(windowId: string, panelId: string): boolean
    }
    internals.store.saveLayout('main', JSON.stringify({ grid: [{ id: 'probe:10' }] }))

    expect(internals.smokeLayoutContains('main', 'probe:10')).toBe(true)
    expect(internals.smokeLayoutContains('main', 'probe:1')).toBe(false)
  })

  it('publishes active sessions from visible workspace windows to main', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const internals = hub as unknown as {
      panelIndex: {
        claimOpen(windowId: string, panel: {
          panelId: string
          key: string
          title: string
          params: Record<string, unknown>
          sessionId: string | null
        }): unknown
        setActivePanel(windowId: string, panelId: string | null): void
      }
      refreshVisibilityConsumers(): void
    }
    internals.panelIndex.claimOpen('main', {
      panelId: 'terminal:{"sessionId":"s1"}',
      key: 'terminal',
      title: 'Session One',
      params: { sessionId: 's1' },
      sessionId: 's1',
    })
    internals.panelIndex.setActivePanel('main', 'terminal:{"sessionId":"s1"}')

    internals.refreshVisibilityConsumers()

    expect(FakeWindow.created[0].sent.at(-1))
      .toEqual(['tabs:visible-terminal-targets', ['s1']])
    FakeWindow.created[0].visible = false
    FakeWindow.created[0].emitWindow('hide')
    expect(FakeWindow.created[0].sent.at(-1)).toEqual(['tabs:visible-terminal-targets', []])
  })

  it('marks a prepared source gone before releasing its panel ownership', () => {
    const hub = hubUnderTest()
    const order: string[] = []
    Object.assign(orchestratorOf(hub), {sessions: { setWindowVisible: () => undefined, snapshot: () => ({ sessions: [] }) }})
    Object.assign(hub, {transferBroker: {
        rendererGone: (windowId: string) => order.push(`broker:${windowId}`),
      },
panelIndex: {
        releaseWindow: (windowId: string) => order.push(`index:${windowId}`),
        visibleTerminalTargetKeys: () => [],
        openTerminalTargetKeys: () => [],
        snapshot: () => [],
      },
workspaceWindows: { publishTo: () => undefined, broadcast: () => undefined, focusedWorkspace: () => null, lastFocusedWorkspace: () => null, acceptsWindow: () => false }})
    const lifecycle = hub as unknown as { workspaceRendererGone(windowId: string): void }

    lifecycle.workspaceRendererGone('holder')

    expect(order).toEqual(['broker:holder', 'index:holder'])
  })

  // An exception out of an Electron menu handler has no owner: this package installs no
  // `uncaughtException`, so a refused extra window - the designed outcome of a state file this
  // process cannot write - reached the user as a crash box instead of the report it already had.
  it('reports a main-process command that throws instead of letting it escape the menu', () => {
    const hub = hubUnderTest()
    const reports: string[] = []
    Object.assign(hub, {
      workspaceWindows: {
        createHolder: () => { throw new Error('Client state refused extra window "h-1"') },
      },
      report: (message: string) => reports.push(message),
    })
    const run = hub as unknown as { runMainCommand(id: string): void }

    expect(() => run.runMainCommand('window.new')).not.toThrow()

    expect(reports).toEqual([
      'The window.new command failed: Client state refused extra window "h-1"',
    ])
  })

  it('cancels every transfer before workspace shutdown begins', () => {
    const hub = hubUnderTest()
    const order: string[] = []
    Object.assign(orchestratorOf(hub), {remarkable: { beginStop: () => order.push('remarkable') },
fileDiffWorker: { beginStop: () => order.push('diff') }})
    Object.assign(hub, {transferBroker: { cancelAll: () => order.push('broker') },
workspaceWindows: { beginQuit: () => order.push('windows') }})

    hub.beginQuit()

    expect(order).toEqual(['remarkable', 'diff', 'broker', 'windows'])
  })

  it('tells the workspace that the snapshot moved and that something failed', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = mainWindow()

    captured.sessionDeps?.onChanged()
    captured.sessionDeps?.onError('the state file is unreadable')

    expect(main.sent).toContainEqual(['sessions:changed'])
    expect(main.sent).toContainEqual(['app:error', 'the state file is unreadable'])
    expect(captured.remoteEvents).toContain('sessions.changed')
  })

  it('hands a collapsed run tab to its parent, and closes it when nobody can take it', () => {
    hubUnderTest()
    const collapsed = vi.spyOn(ServiceTabsIpc.prototype, 'scriptRunCollapsed').mockImplementation(() => {})

    captured.sessionDeps?.onScriptCollapsed?.({ runId: 'run-1', parentId: 'parent-1', handoff: 'parent-tab', handoffTo: 'parent-1' })
    captured.sessionDeps?.onScriptCollapsed?.({ runId: 'run-2', parentId: 'parent-1', handoff: 'close', handoffTo: 'parent-1' })
    // The snapshot no longer names the parent, so there is no title to open its tab under.
    captured.sessionDeps?.onScriptCollapsed?.({ runId: 'run-3', parentId: 'gone', handoff: 'parent-tab', handoffTo: 'gone' })

    expect(collapsed.mock.calls).toEqual([
      ['run-1', { target: { kind: 'local', sessionId: 'parent-1' }, title: 'Work - 014' }],
      ['run-2', null],
      ['run-3', null],
    ])
  })

  it('opens a runaway notice as a person-requested terminal tab while leaving workflow notices unchanged', async () => {
    const hub = hubUnderTest()
    const ports = hub as unknown as {
      machineLoad: { deps: { notify: (row: import('../../lib-orchestrator/perfMonitor/runawayTracker').RunawayProcess) => void } }
      tabControlBroker: { open: (id: string, title: string, by: string) => Promise<unknown> }
    }
    const broker = (orchestratorOf(hub) as { tabControlBroker: typeof ports.tabControlBroker }).tabControlBroker
    const open = vi.spyOn(broker, 'open').mockResolvedValue({ ok: true })
    ports.machineLoad.deps.notify({ pid: 99, startedAt: 1, image: 'node.exe', cores: 0.9,
      sessionId: 's1', session: '093', sessionKind: 'agent', idle: true, minutes: 10 })
    expect(captured.notices).toHaveLength(1)
    expect(open).not.toHaveBeenCalled()
    captured.notices[0]!.click()
    await Promise.resolve()
    expect(open).toHaveBeenCalledExactlyOnceWith('s1', 'Session 093', 'person')
  })

  it('shows a Windows notification when a local Finish starts to wait, once, and its click opens the workflow tab', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const openWorkflow = vi.spyOn((orchestratorOf(hub) as unknown as { tabControlBroker: { openWorkflow: (sessionId: string, title: string) => Promise<unknown> } })
      .tabControlBroker, 'openWorkflow').mockResolvedValue({ ok: true, value: { windowId: 'w', panelId: 'p' } })
    captured.snapshotSessions = []
    captured.sessionDeps?.onChanged()
    captured.snapshotSessions = [{
      sessionId: 's1', kind: 'agent', title: '014 - trail', tabTitle: 'Work - 014', titleParts: { number: '014', name: 'Work' },
      directory: { mode: 'default' }, project: { kind: 'none' }, life: 'ended', activity: null, admits: [],
      svnAction: { kind: 'finish', stage: 'fixing', needs: '2 conflicts need you: a, b', needsKind: 'conflict', review: null, summary: '2 conflicts need you' },
    }]
    captured.sessionDeps?.onChanged()
    captured.sessionDeps?.onChanged()

    expect(captured.notices.map(({ title, body }) => ({ title, body }))).toEqual([{ title: 'Finish waits: 014 - trail', body: '2 conflicts need you' }])
    captured.notices[0]?.click()
    await Promise.resolve()
    expect(openWorkflow).toHaveBeenCalledWith('s1', 'Work - 014')
  })

  it('tells an UPDATE of a landed row once with its revision, and its click opens the kept update log', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    captured.notices = []
    captured.openedPaths = []
    captured.sessionDeps?.onMainCopyUpdated?.({ sessionId: 's1', title: '001 - J01 W1', mainCopy: 'Q:/Work/App', revision: 1481, by: 'person',
      log: 'C:/state/worktree-results/a1/run.log' })

    expect(captured.notices.map(({ title, body }) => ({ title, body }))).toEqual([{ title: 'Main copy updated: 001 - J01 W1',
      body: 'Q:/Work/App is at r1481. Click to open the update log, kept with the worktree result.' }])
    captured.notices[0]?.click()
    await Promise.resolve()
    expect(captured.openedPaths).toEqual(['C:/state/worktree-results/a1/run.log'])
  })

  it('broadcasts session changes to every workspace window', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = routedWindow()
    const holder = routedWindow()
    replaceWorkspaceRegistry(hub, main, holder, () => holder)

    captured.sessionDeps?.onChanged()

    expect(main.sent).toContainEqual(['sessions:changed'])
    expect(holder.sent).toContainEqual(['sessions:changed'])
  })

  it('routes Remarkable to the focused holder with main fallback', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = routedWindow()
    const holder = routedWindow()
    let focused: RoutedWindow | null = holder
    replaceWorkspaceRegistry(hub, main, holder, () => focused)

    clickMenuItem('Remarkable')
    clickMenuItem('Toggle Left Sidebar')
    focused = null
    clickMenuItem('Remarkable')

    expect(holder.sent).toEqual([['menu:command', 'tools.remarkable']])
    expect(main.sent).toEqual([
      ['menu:command', 'view.toggleLeftSidebar'],
      ['menu:command', 'tools.remarkable'],
    ])
  })

  /*
   * The one send site for `menu:command`, and the event carries an id and nothing else. What keeps a
   * command that needs a value off the native menu is a catalog rule, and a catalog rule is one word
   * to undo; the channel now refuses such an id BY TYPE, so this throw is what narrows a plain
   * catalog id down to what it accepts. Reached directly because the menu cannot draw the item that
   * would reach it - which is the whole point: the guard is for the day the catalog says it can.
   */
  it('refuses to publish a command the native menu cannot supply a value for', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = routedWindow()
    replaceWorkspaceRegistry(hub, main, routedWindow(), () => null)
    const publish = (hub as unknown as { publishRendererCommand(id: CommandId): void })
      .publishRendererCommand.bind(hub)

    expect(() => publish('session.setColor')).toThrow(/needs a value/)
    expect(main.sent).toEqual([])
  })

  // Debug and Usage open as tabs of the workspace in front, so they open no window of their own.
  it('sends Debug and Usage to the workspace as tab commands', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = routedWindow()
    replaceWorkspaceRegistry(hub, main, routedWindow(), () => null)

    clickMenuItem('Debug')
    clickMenuItem('Usage')

    expect(main.sent).toEqual([['menu:command', 'debug.open'], ['menu:command', 'tools.usage']])
    expect(FakeWindow.created).toHaveLength(1)
  })

  it('reloads a focused holder and falls back to main when no workspace has focus', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const main = routedWindow()
    const holder = routedWindow()
    let focused: RoutedWindow | null = holder
    replaceWorkspaceRegistry(hub, main, holder, () => focused)

    clickMenuItem('Reload')
    focused = null
    clickMenuItem('Reload')

    expect([main.reloads, holder.reloads]).toEqual([1, 1])
  })

  it('opens a bare holder immediately from the Window menu', async () => {
    const hub = hubUnderTest()
    await hub.initialize()

    clickMenuItem('New Window')

    expect(FakeWindow.created).toHaveLength(2)
    expect((hub as unknown as { workspaceWindows: { holderCount(): number } })
      .workspaceWindows.holderCount()).toBe(1)
    expect(captured.menuBuilds).toBe(1)
  })

  /**
   * The only case in this file that saves a COLOUR, which is the only appearance branch that
   * rasterises: `WindowIcon.of` hands a tinted SVG to Resvg, a real native renderer, and the result
   * is cached per colour so the first call pays for all of them. Electron is mocked here; Resvg is
   * not, and nothing in this suite would be worth keeping if it were.
   *
   * That costs milliseconds here and does not fit five seconds on the GitHub runner, where it timed
   * out twice while every neighbouring case finished inside 22ms. The budget it needs is the
   * project's now, in vitest.node.config.ts, because a cold disk and a slow runner are not this
   * one case's problem - `scripts/tokensGate` hit the same wall on its own.
   */
  /**
   * The seam between the library and the client's own state. What group a session was put in is
   * never the library's to know, and the tree that holds the assignments is drawn in the main
   * window alone - so a fork asked for from a holder window's tab menu has only this wiring to
   * inherit through, and the event is the only way a tree that IS open hears about the write.
   */
  it('gives a fork the group its parent was put in and tells the windows', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const sender = FakeWindow.created[0].webContents
    const assign = captured.ipcHandlers.get('state:assign-session-group')
    const control = captured.ipcHandlers.get('control:call')
    const load = captured.ipcHandlers.get('state:load-session-groups')
    if (!assign || !control || !load)
      throw new Error('The hub registered no session group or control handler')

    await assign({ sender, senderFrame: sender.mainFrame }, 'session:parent-1', 'priority')
    FakeWindow.created[0].sent.length = 0
    expect(await control({ sender, senderFrame: sender.mainFrame }, 'sessions.fork', {
      session: { kind: 'sessionId', sessionId: 'parent-1' },
      name: 'refactor',
    })).toMatchObject({
      ok: true,
      value: { ok: true, operation: 'sessions.fork', value: { sessionId: 'fork-1', tabTitle: 'Work - 014-015' } },
    })

    expect(await load({ sender, senderFrame: sender.mainFrame })).toEqual({
      ok: true,
      value: [
        { key: 'session:parent-1', group: 'priority' },
        { key: 'session:fork-1', group: 'priority' },
      ],
    })
    expect(FakeWindow.created[0].sent).toContainEqual(['state:session-groups-changed'])
  })

  /** A parent with no assignment of its own hands nothing over, and nobody is woken for it. */
  it('writes nothing and says nothing when the forked session was never assigned', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const sender = FakeWindow.created[0].webContents
    const control = captured.ipcHandlers.get('control:call')
    const load = captured.ipcHandlers.get('state:load-session-groups')
    if (!control || !load) throw new Error('The hub registered no session group or control handler')

    FakeWindow.created[0].sent.length = 0
    await control({ sender, senderFrame: sender.mainFrame }, 'sessions.fork', { session: { kind: 'sessionId', sessionId: 'parent-1' } })

    expect(await load({ sender, senderFrame: sender.mainFrame })).toEqual({ ok: true, value: [] })
    expect(FakeWindow.created[0].sent).not.toContainEqual(['state:session-groups-changed'])
  })

  it('rebuilds the Window menu for name changes but not color-only saves', async () => {
    const hub = hubUnderTest()
    await hub.initialize()
    const save = captured.ipcHandlers.get('window:save-appearance')
    if (!save)
      throw new Error('The hub registered no window appearance handler')
    const sender = FakeWindow.created[0].webContents

    await save({ sender, senderFrame: sender.mainFrame }, { name: 'Primary', color: null })
    expect(captured.menuBuilds).toBe(2)

    await save({ sender, senderFrame: sender.mainFrame }, { name: 'Primary', color: '#123456' })
    expect(captured.menuBuilds).toBe(2)

    await save({ sender, senderFrame: sender.mainFrame }, { name: 'Review', color: '#123456' })
    expect(captured.menuBuilds).toBe(3)

    await save({ sender, senderFrame: sender.mainFrame }, { name: null, color: '#123456' })
    expect(captured.menuBuilds).toBe(4)
  })

  /**
   * The three transcript consumers read through the project manager's ONE view.
   *
   * A view of one's own gets a Codex index with `memo = null`, which that index's own header defines
   * as "every walk reads every header" - and two of the three are POLLED. Nothing else pins it: the
   * readers hold their resolver privately and this file's hub is built on mocks, so the fix was
   * verified by typecheck and by the smokes and by nothing that would fail again.
   *
   * Read off the source rather than off the instances, which is the same shape as the IPC parity
   * gate two tests above: what has to stay true is a wiring decision, and the wiring is the text.
   */
  it('gives every transcript consumer the project manager\'s own view', async () => {
    const source = await readFile(new URL('../../app-orchestrator/app/appHub.ts', import.meta.url), 'utf8')

    // The two polled readers, the file-changes manager, the session manager's reference block and
    // the sub-agent listing, and no sixth way in.
    expect(source.match(/this\.projects\.transcripts/g)).toHaveLength(5)
    expect(source).not.toContain('new ProviderTranscriptView(')
  })

  // Two lists used to name the nineteen services - a spread that proved coverage and a sum of
  // nineteen `Object.keys(...).length` that proved no two claimed the same channel. Both proofs now
  // ride on one list, so both are pinned here.
  it('keeps native ui reads on the confirmed owner cache, including refusal and external edits', async () => {
    const hub = hubUnderTest()
    const cache = (hub as unknown as { configCache: ConfigSectionsCache }).configCache
    const owner = orchestratorOf(hub) as { api: OrchestratorApi; configStore: ConfigStore; remoteControl: RemoteControl }
    expect(cache.read('ui')).toEqual(UiSettings.defaultValue())
    await hub.initialize()
    const sender = FakeWindow.created[0].webContents
    const invoke = captured.ipcHandlers.get('control:call')!
    const call = (operation: string, body: unknown) => invoke({ sender, senderFrame: sender.mainFrame }, operation, body)
    const before = cache.read('ui')
    const next = { ...before, fontScalePercent: 125 }
    let confirm!: () => void
    const confirmed = new Promise<void>(resolve => { confirm = resolve })
    const execute = owner.remoteControl.registry.execute.bind(owner.remoteControl.registry)
    vi.spyOn(owner.remoteControl.registry, 'execute').mockImplementationOnce(async (...args) => {
      await confirmed
      return execute(...args)
    })
    const pending = call('uiSettings.save', { value: next })
    await Promise.resolve()
    expect(cache.read('ui')).toEqual(before)
    confirm()
    expect(await pending).toMatchObject({ ok: true, value: { ok: true } })
    expect(cache.read('ui')).toEqual(next)
    const persisted = JSON.parse(readFileSync(join(stateRoot, 'config', 'config.json'), 'utf8'))
    expect(persisted.ui).toEqual(next)

    const save = vi.spyOn(owner.configStore, 'saveSection').mockReturnValueOnce({ ok: false, code: 'config-latched', detail: 'fixture refusal' })
    const publish = vi.spyOn(cache, 'update')
    expect(await call('uiSettings.save', { value: { ...next, fontScalePercent: 130 } }))
      .toMatchObject({ ok: true, value: { ok: false } })
    expect(cache.read('ui')).toEqual(next)
    expect(publish).not.toHaveBeenCalled()
    save.mockRestore()

    const edited = { ...next, fontScalePercent: 135 }
    const configFile = join(stateRoot, 'config', 'config.json')
    writeFileSync(configFile, JSON.stringify({ ...persisted, ui: edited }))
    const modified = new Date(Date.now() + 2_000)
    utimesSync(configFile, modified, modified)
    expect(cache.read('ui')).toEqual(next)
    expect(await call('uiSettings.get', {})).toMatchObject({ ok: true, value: { ok: true, value: edited } })
    expect(cache.read('ui')).toEqual(edited)
  })

  it('passes serializable snap-in descriptors to the native menu', () => {
    const hub = hubUnderTest()
    const api = (orchestratorOf(hub) as { api: OrchestratorApi }).api
    const descriptors = api.snapinDefinitions()
    expect(descriptors.length).toBeGreaterThan(0)
    expect(structuredClone(descriptors)).toEqual(descriptors)
    for (const descriptor of descriptors) expect(Object.keys(descriptor).sort()).toEqual(['kind', 'title'])
  })

  it('closes the orchestration media owner when native quit begins', async () => {
    const hub = hubUnderTest()
    const api = (orchestratorOf(hub) as { api: OrchestratorApi }).api
    hub.beginQuit()
    await expect(api.mediaOpen({ requestId: 'after-quit', resourceId: 'resource', version: 'v1', offset: 0, length: 1 }))
      .rejects.toThrow('File media is stopping')
  })

  it.each(['registry', 'control'] as const)('publishes confirmed UI values through the direct %s entry', async entry => {
    const hub = hubUnderTest()
    const cache = (hub as unknown as { configCache: ConfigSectionsCache }).configCache
    const owner = orchestratorOf(hub) as { api: OrchestratorApi; configStore: ConfigStore; remoteControl: RemoteControl }
    const nativeCall = vi.spyOn(owner.api, 'controlExecute')
    const publish = vi.spyOn(cache, 'update')
    let sequence = 0
    const execute = entry === 'registry' ? owner.remoteControl.registry : owner.remoteControl
    const call = (operation: string, body: unknown) => execute.execute({
      protocol: RemoteControlConst.protocol, requestId: `request-${++sequence}`,
      ...(operation === 'uiSettings.save' ? { operationId: `operation-${sequence}` } : {}), operation, body,
    }, { callerId: 'local-cli:fixture', callerKind: 'local-cli', allowedOperations: ['uiSettings.get', 'uiSettings.save'] })
    const next = { ...cache.read('ui'), fontScalePercent: 125 }
    expect(await call('uiSettings.save', { value: next })).toMatchObject({ ok: true })
    expect(cache.read('ui')).toEqual(next)
    expect(publish).toHaveBeenCalledTimes(1)
    publish.mockClear()
    const save = vi.spyOn(owner.configStore, 'saveSection').mockReturnValueOnce({ ok: false, code: 'config-latched', detail: 'fixture refusal' })
    expect(await call('uiSettings.save', { value: { ...next, fontScalePercent: 130 } })).toMatchObject({ ok: false })
    expect(publish).not.toHaveBeenCalled()
    expect(cache.read('ui')).toEqual(next)
    save.mockRestore()
    const configFile = join(stateRoot, 'config', 'config.json')
    const persisted = JSON.parse(readFileSync(configFile, 'utf8'))
    const edited = { ...next, fontScalePercent: 135 }
    writeFileSync(configFile, JSON.stringify({ ...persisted, ui: edited }))
    const modified = new Date(Date.now() + 2_000)
    utimesSync(configFile, modified, modified)
    expect(await call('uiSettings.get', {})).toMatchObject({ ok: true, value: edited })
    expect(cache.read('ui')).toEqual(edited)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(nativeCall).not.toHaveBeenCalled()
  })

  describe('the IPC contract', () => {
    it('gives every channel of the contract exactly one owning service', () => {
      const owned = Object.keys(MainHub.ipcChannelsConst)
      const services = [
        ServiceShellIpc.channelsConst,
        ServiceRemarkableIpc.channelsConst,
        ServiceTabsIpc.channelsConst,
        ServiceTabRequestsIpc.channelsConst,
        ServiceFileViewerIpc.channelsConst,
        ServiceFileViewerShellIpc.channelsConst,
      ]

      expect(owned.length).toBe(new Set(owned).size)
      for (const service of services)
        for (const channel of Object.keys(service))
          expect(owned).toContain(channel)
    })

    // A channel claimed twice reaches only whichever service registered second, and the first
    // silently handles nothing. The merge is what makes that loud, and it names the channel.
    it('refuses two services that claim the same channel', () => {
      const merge = ServiceChannels.merge

      expect(() => merge([{ 'app:info': true }, { 'app:info': true }]))
        .toThrow('Two IPC services claim the same channel: app:info')
    })
  })
})
