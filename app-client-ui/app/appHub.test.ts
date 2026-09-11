import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MenuItemConstructorOptions } from 'electron'
import { readFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileChangesContext } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  TerminalDetector,
  TerminalDetectorDeps,
} from '../../lib-orchestrator/terminalDetector/terminalDetector'
import { AppClientUiBridgeEventsConst } from '../shared/appClientUiIpc'
import type { CommandId } from '../shared/commands'
import type { AppContext } from './appContext'
import { AppHub } from './appHub'
import { ServiceRemarkableIpc } from './remarkable/serviceRemarkableIpc'
import { ServiceShellIpc } from './shell/serviceShellIpc'
import { ServiceTabsIpc } from './tabs/serviceTabsIpc'

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
    sessionDeps: null as null | {
      onChanged: () => void
      onError: (message: string) => void
    },
    rateDeps: null as null | {
      onChanged: () => void
      onError: (message: string) => void
    },
    visible: [] as boolean[],
    rateVisible: [] as boolean[],
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
  }

  /**
   * Deliberately the OPPOSITE of what the wiring must leave behind, so a hub that forgot to wire the
   * updater is read here as the defaults electron-updater ships rather than as a missing call.
   */
  const updaterMock = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    events: [] as string[],
    on: (event: string): void => {
      updaterMock.events.push(event)
    },
  }

  return { FakeWindow, captured, updaterMock }
})

vi.mock('electron', () => ({
  app: {
    getAppPath: () => captured.appPath,
    getPath: () => 'C:/tmp/app/state',
    isPackaged: false,
    exit: () => {},
    relaunch: () => {},
    quit: () => {},
  },
  BrowserWindow: FakeWindow,
  nativeImage: {
    createFromDataURL: () => ({ isEmpty: () => false }),
    createFromBuffer: () => ({ isEmpty: () => false }),
  },
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      captured.ipcHandlers.set(channel, handler),
  },
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
vi.mock('electron-updater', () => ({ autoUpdater: updaterMock }))

vi.mock('./remarkable/sidecar/remarkableSidecarInstaller', () => ({
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

vi.mock('./remarkable/sidecar/remarkableCli', () => ({
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

vi.mock('../../lib-orchestrator/sessionManager/sessionManager', () => ({
  SessionManager: class {
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

    async start(): Promise<void> {}
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

vi.mock('./remoteControl/remoteControlServer', () => ({
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

vi.mock('./skills/skillLinkInstaller', () => ({
  SkillLinkInstaller: class {
    install(): readonly [] {
      captured.skillInstalls += 1
      return []
    }
  },
}))

describe('app-client-ui/app/appHub', () => {
  let stateRoot: string

  function hubUnderTest(): AppHub {
    const context = {
      appName: 'Jamat V3',
      smoke: true,
      appVersion: '0.0.0',
      fileDiffWorkerPath: 'fileDiffWorker.js',
      preloadPath: 'preload.js',
      rendererPath: 'index.html',
      rendererDevUrl: undefined,
      debugRendererPath: 'debug.html',
      debugRendererDevUrl: undefined,
      appInfo: {},
      config: {
        configDir: 'C:/tmp/config',
        runtimeChannel: 'development',
        identity: { configIdentity: 'app-hub-test' },
      },
    } as unknown as AppContext
    return new AppHub(context)
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
    hub: AppHub,
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
  }

  function windows(): { main: OpenWindow; debug: OpenWindow } {
    const [main, debug] = FakeWindow.created
    if (!main || !debug) throw new Error('both windows have to be open for this')
    return { main, debug }
  }

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-app-hub-test-'))
    process.env.JAMAT_V3_LOCAL_STATE_DIR = stateRoot
    FakeWindow.created = []
    captured.sessionDeps = null
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
    updaterMock.autoDownload = true
    updaterMock.autoInstallOnAppQuit = false
    updaterMock.events = []
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    rmSync(stateRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /**
   * The assembly's whole share of the update path: the flags are what make a check ask before it
   * downloads, and they have to be set before anything can touch the updater - which is why the hub
   * wires it as it builds it rather than in `initialize`. Nothing is checked until the menu item is.
   */
  it('wires the updater to find an update without downloading it', () => {
    hubUnderTest()

    expect(updaterMock.autoDownload).toBe(false)
    expect(updaterMock.autoInstallOnAppQuit).toBe(true)
    expect(updaterMock.events).toEqual(['error'])
  })

  it('installs the AppJamatV3 skill links during initialization', () => {
    const hub = hubUnderTest()

    hub.initialize()

    expect(captured.skillInstalls).toBe(1)
  })

  /*
   * The reason the window exists: watching what the client is doing while the workspace is behind
   * something else. Throttling on the workspace alone would have slowed the poll to fifteen seconds
   * exactly while somebody was reading it.
   */
  it('keeps the cadence while either window can be seen', () => {
    const hub = hubUnderTest()
    hub.initialize()
    const main = FakeWindow.created[0]
    const visibility = hub as unknown as { visibleWorkspaceWindowIds: Set<string> }

    expect(visibility.visibleWorkspaceWindowIds).toEqual(new Set(['main']))

    main.visible = false
    main.emitWindow('hide')
    expect(captured.visible.at(-1)).toBe(false)
    expect(visibility.visibleWorkspaceWindowIds).toEqual(new Set())

    clickMenuItem('Debug Window')
    const { debug } = windows()
    debug.emitWindow('show')
    expect(captured.visible.at(-1)).toBe(true)
    expect(visibility.visibleWorkspaceWindowIds.has('debug')).toBe(false)

    debug.visible = false
    debug.emitWindow('hide')
    expect(captured.visible.at(-1)).toBe(false)
  })

  /*
   * The rate monitor follows the same expression as the sessions rather than the workspace alone:
   * the Debug window draws the rate section, so somebody looking only at it is still looking.
   */
  it('gives the rate monitor the visibility of any window at all', () => {
    const hub = hubUnderTest()
    hub.initialize()
    const main = FakeWindow.created[0]

    expect(captured.rateVisible.at(-1)).toBe(true)

    main.visible = false
    main.emitWindow('hide')
    expect([captured.visible.at(-1), captured.rateVisible.at(-1)]).toEqual([false, false])

    clickMenuItem('Debug Window')
    windows().debug.emitWindow('show')
    expect([captured.visible.at(-1), captured.rateVisible.at(-1)]).toEqual([true, true])
  })

  it('tells both windows that the rate limits moved and that reading them failed', () => {
    const hub = hubUnderTest()
    hub.initialize()
    clickMenuItem('Debug Window')
    const { debug } = windows()
    const main = routedWindow()
    const holder = routedWindow()
    replaceWorkspaceRegistry(hub, main, holder, () => holder)

    captured.rateDeps?.onChanged()
    captured.rateDeps?.onError('the usage endpoint answered 429')

    for (const window of [main, holder, debug])
      expect(window.sent).toContainEqual(['rate:changed'])
    expect(debug.sent).toContainEqual(['app:error', 'the usage endpoint answered 429'])
  })

  // reMarkable may own an active child or a noninterruptible atomic copy, so it is aborted and
  // awaited before the other child owners. The diff worker is next because it may be terminating.
  it('awaits reMarkable before the other child owners and removes control discovery immediately', async () => {
    const hub = hubUnderTest()
    hub.initialize()
    Object.assign(hub, {
      remarkable: {
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
    })

    await hub.dispose()

    expect(captured.disposeOrder).toEqual(['remarkable', 'diff', 'rate', 'control', 'sessions'])
    expect(captured.remoteBeginStops).toBe(1)
  })

  it('owns one lazy diff worker and gives it to the file changes manager', () => {
    const hub = hubUnderTest()
    const worker = (hub as unknown as { fileDiffWorker: unknown }).fileDiffWorker

    expect(captured.fileChangesExecutor).toBe(worker)
  })

  it('boots without a sidecar seed, CLI call, install call or secure-storage prompt', () => {
    const hub = hubUnderTest()
    const sourceDirectory = captured.remarkableInstallerOptions?.sourceDirectory
    if (sourceDirectory === undefined) throw new Error('The hub did not construct the installer')
    expect(existsSync(sourceDirectory)).toBe(false)

    hub.initialize()

    expect(captured.remarkableActions).toEqual([])
    expect(captured.safeStorageCalls).toEqual([])
  })

  /*
   * The half `preload/index.test.ts` cannot see. It proves every event channel has a SUBSCRIBER;
   * this proves every one has a PUBLISHER, which is the only thing that makes a subscription worth
   * having. Read off the source because an event is published from wherever it happens - the shell,
   * the tab brokers, the rate monitor - and no runtime seam collects them.
   */
  it('publishes every event channel from somewhere in the main process', () => {
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

    const unpublished = Object.values(AppClientUiBridgeEventsConst)
      .filter((channel) => !sources.some((source) => source.includes(`'${channel}'`)))

    expect(unpublished).toEqual([])
  })

  /*
   * Both readers over ONE view, and the project manager's own. A view of their own would have no
   * memo behind its index, and resolving a Codex rollout means walking a directory - which this
   * pair does on every poll, for every session on screen.
   */
  it('gives both transcript readers the project manager’s memo-carrying view', () => {
    // Every hub this file builds writes here, so only THIS hub's pair is read.
    captured.transcriptViews.length = 0
    const hub = hubUnderTest()
    hub.initialize()
    const projects = (hub as unknown as { projects: { transcripts: unknown } }).projects

    expect(captured.transcriptViews.map(([reader]) => reader)).toEqual(['model', 'transcript'])
    for (const [reader, view] of captured.transcriptViews)
      expect(view, reader).toBe(projects.transcripts)
  })

  it('holds the final IPC parity counts', () => {
    expect(Object.keys(AppHub.ipcChannelsConst)).toHaveLength(173)
    expect(Object.keys(AppClientUiBridgeEventsConst)).toHaveLength(20)
    expect(Object.keys(ServiceTabsIpc.channelsConst)).toHaveLength(13)
    expect(Object.keys(ServiceRemarkableIpc.channelsConst)).toHaveLength(16)
  })

  /*
   * The third gate, measured at the boot it protects: `satisfies` proves the subsets cover the
   * contract and the merge proves no two claim a channel, but neither proves anybody
   * handled one. A service constructed and never initialized passes both and leaves its channels
   * empty for the renderer's first call.
   */
  it('leaves no channel of the contract without a handler once it has booted', () => {
    const hub = hubUnderTest()

    hub.initialize()

    expect([...captured.ipcHandlers.keys()].sort())
      .toEqual(Object.keys(AppHub.ipcChannelsConst).sort())
  })

  /*
   * The detector's second tier, which is what a half-written path in a terminal is matched against,
   * and the reason it is held for a moment: `list()` files a snapshot nobody owns into a store
   * bounded at 32, so a run of right clicks would evict the ones open diff panels are drawn from.
   */
  it('hands the detector every changed path, and lists them once for a burst of clicks', async () => {
    const hub = hubUnderTest()
    const detector = (hub as unknown as {
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
    hub.initialize()
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

    expect(await restore({ sender }, source, false)).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'proof-expired',
        detail: 'The terminal detection behind this file is gone; open it from the terminal again',
      },
    })

    ;(hub as unknown as { terminalDetector: TerminalDetector }).terminalDetector
      .markOpened(real, 'file')
    const allowed = await restore({ sender }, source, false) as {
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

  it('publishes active sessions from visible workspace windows to main', () => {
    const hub = hubUnderTest()
    hub.initialize()
    const internals = hub as unknown as {
      panelIndex: {
        claimOpen(windowId: string, panel: {
          panelId: string
          key: string
          title: string
          params: Record<string, unknown>
          sessionId: string | null
          presentation: 'session' | 'plain' | null
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
      presentation: 'session',
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
    Object.assign(hub, {
      transferBroker: {
        rendererGone: (windowId: string) => order.push(`broker:${windowId}`),
      },
      panelIndex: {
        releaseWindow: (windowId: string) => order.push(`index:${windowId}`),
        visibleTerminalTargetKeys: () => [],
      },
      workspaceWindows: { publishTo: () => undefined, broadcast: () => undefined },
      sessions: { setWindowVisible: () => undefined },
    })
    const lifecycle = hub as unknown as { workspaceRendererGone(windowId: string): void }

    lifecycle.workspaceRendererGone('holder')

    expect(order).toEqual(['broker:holder', 'index:holder'])
  })

  /**
   * A discard is final, so stopping at the first refusal left the sessions before it destroyed
   * AND the window open, drawing tabs for sessions that no longer exist. Every id is attempted
   * now: the close goes ahead when anything was discarded, and is refused only when nothing was,
   * because that is the one case where leaving the window alone costs nothing.
   */
  it('attempts every plain session of a closing holder and reports the ones that refused', async () => {
    const hub = hubUnderTest()
    const reports: string[] = []
    const refuse = new Set(['s-2'])
    const attempted: string[] = []
    Object.assign(hub, {
      sessions: {
        discardPlainSession: (sessionId: string) => {
          attempted.push(sessionId)
          return Promise.resolve(refuse.has(sessionId)
            ? { ok: false, code: 'host-unreachable', detail: `no answer for ${sessionId}` }
            : { ok: true, value: undefined })
        },
      },
      report: (message: string) => reports.push(message),
    })
    const close = hub as unknown as {
      closePlainSessions(ids: readonly string[]): Promise<boolean>
    }

    expect(await close.closePlainSessions(['s-1', 's-2', 's-3'])).toBe(true)

    expect(attempted).toEqual(['s-1', 's-2', 's-3'])
    expect(reports).toEqual(['1 of 3 sessions could not be discarded: no answer for s-2'])
  })

  it('keeps a holder open when not one of its plain sessions could be discarded', async () => {
    const hub = hubUnderTest()
    const reports: string[] = []
    Object.assign(hub, {
      sessions: {
        discardPlainSession: () =>
          Promise.resolve({ ok: false, code: 'host-unreachable', detail: 'the Host did not answer' }),
      },
      report: (message: string) => reports.push(message),
    })
    const close = hub as unknown as {
      closePlainSessions(ids: readonly string[]): Promise<boolean>
    }

    expect(await close.closePlainSessions(['s-1', 's-2'])).toBe(false)
    expect(reports).toEqual(['the Host did not answer'])
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
    Object.assign(hub, {
      remarkable: { beginStop: () => order.push('remarkable') },
      fileDiffWorker: { beginStop: () => order.push('diff') },
      transferBroker: { cancelAll: () => order.push('broker') },
      workspaceWindows: { beginQuit: () => order.push('windows') },
    })

    hub.beginQuit()

    expect(order).toEqual(['remarkable', 'diff', 'broker', 'windows'])
  })

  it('tells both windows that the snapshot moved and that something failed', () => {
    const hub = hubUnderTest()
    hub.initialize()
    clickMenuItem('Debug Window')
    const { main, debug } = windows()

    captured.sessionDeps?.onChanged()
    captured.sessionDeps?.onError('the state file is unreadable')

    for (const window of [main, debug]) {
      expect(window.sent).toContainEqual(['sessions:changed'])
      expect(window.sent).toContainEqual(['app:error', 'the state file is unreadable'])
    }
    expect(captured.remoteEvents).toContain('sessions.changed')
  })

  it('broadcasts session changes to every workspace window and Debug', () => {
    const hub = hubUnderTest()
    hub.initialize()
    clickMenuItem('Debug Window')
    const { debug } = windows()
    const main = routedWindow()
    const holder = routedWindow()
    replaceWorkspaceRegistry(hub, main, holder, () => holder)

    captured.sessionDeps?.onChanged()

    expect(main.sent).toContainEqual(['sessions:changed'])
    expect(holder.sent).toContainEqual(['sessions:changed'])
    expect(debug.sent).toContainEqual(['sessions:changed'])
  })

  // A renderer command belongs to the workspace: the Debug window builds no command registry, and
  // an event it cannot answer would be an event it has to be taught to ignore.
  it('sends Remarkable to the workspace window and never to Debug', () => {
    const hub = hubUnderTest()
    hub.initialize()
    clickMenuItem('Debug Window')
    const { main, debug } = windows()

    clickMenuItem('Remarkable')

    expect(main.sent).toContainEqual(['menu:command', 'tools.remarkable'])
    expect(debug.sent).toEqual([])
  })

  it('routes Remarkable to the focused holder with main fallback', () => {
    const hub = hubUnderTest()
    hub.initialize()
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
  it('refuses to publish a command the native menu cannot supply a value for', () => {
    const hub = hubUnderTest()
    hub.initialize()
    const main = routedWindow()
    replaceWorkspaceRegistry(hub, main, routedWindow(), () => null)
    const publish = (hub as unknown as { publishRendererCommand(id: CommandId): void })
      .publishRendererCommand.bind(hub)

    expect(() => publish('session.setColor')).toThrow(/needs a value/)
    expect(main.sent).toEqual([])
  })

  it('opens one Debug window however many times the command is run', () => {
    const hub = hubUnderTest()
    hub.initialize()
    clickMenuItem('Debug Window')
    clickMenuItem('Debug Window')
    expect(FakeWindow.created).toHaveLength(2)
  })

  /*
   * Reload means the window in front, which is what Electron's own role would do. Without it, a
   * Debug window whose renderer had stopped answering could only be closed and opened again, because
   * the command reloaded the workspace whatever was on screen.
   */
  it('reloads the window in front, and the workspace when neither is', () => {
    const hub = hubUnderTest()
    hub.initialize()
    clickMenuItem('Debug Window')
    const { main, debug } = windows()

    clickMenuItem('Reload')
    expect([main.reloads, debug.reloads]).toEqual([1, 0])

    debug.focus_ = true
    clickMenuItem('Reload')
    expect([main.reloads, debug.reloads]).toEqual([1, 1])

    debug.focus_ = false
    main.focus_ = true
    clickMenuItem('Reload')
    expect([main.reloads, debug.reloads]).toEqual([2, 1])
  })

  it('reloads a focused holder and falls back to main when no workspace has focus', () => {
    const hub = hubUnderTest()
    hub.initialize()
    const main = routedWindow()
    const holder = routedWindow()
    let focused: RoutedWindow | null = holder
    replaceWorkspaceRegistry(hub, main, holder, () => focused)

    clickMenuItem('Reload')
    focused = null
    clickMenuItem('Reload')

    expect([main.reloads, holder.reloads]).toEqual([1, 1])
  })

  it('opens a bare holder immediately from the Window menu', () => {
    const hub = hubUnderTest()
    hub.initialize()

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
  it('rebuilds the Window menu for name changes but not color-only saves', async () => {
    const hub = hubUnderTest()
    hub.initialize()
    const save = captured.ipcHandlers.get('window:save-appearance')
    if (!save)
      throw new Error('The hub registered no window appearance handler')
    const sender = FakeWindow.created[0].webContents

    await save({ sender }, { name: 'Primary', color: null })
    expect(captured.menuBuilds).toBe(2)

    await save({ sender }, { name: 'Primary', color: '#123456' })
    expect(captured.menuBuilds).toBe(2)

    await save({ sender }, { name: 'Review', color: '#123456' })
    expect(captured.menuBuilds).toBe(3)

    await save({ sender }, { name: null, color: '#123456' })
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
    const source = await readFile(new URL('./appHub.ts', import.meta.url), 'utf8')

    // The two polled readers, the file-changes manager and the session manager's reference block,
    // and no fifth way in.
    expect(source.match(/this\.projects\.transcripts/g)).toHaveLength(4)
    expect(source).not.toContain('new ProviderTranscriptView(')
  })

  // Two lists used to name the nineteen services - a spread that proved coverage and a sum of
  // nineteen `Object.keys(...).length` that proved no two claimed the same channel. Both proofs now
  // ride on one list, so both are pinned here.
  describe('the IPC contract', () => {
    it('gives every channel of the contract exactly one owning service', () => {
      const owned = Object.keys(AppHub.ipcChannelsConst)
      const services = [
        ServiceShellIpc.channelsConst,
        ServiceRemarkableIpc.channelsConst,
        ServiceTabsIpc.channelsConst,
      ]

      expect(owned.length).toBe(new Set(owned).size)
      for (const service of services)
        for (const channel of Object.keys(service))
          expect(owned).toContain(channel)
    })

    // A channel claimed twice reaches only whichever service registered second, and the first
    // silently handles nothing. The merge is what makes that loud, and it names the channel.
    it('refuses two services that claim the same channel', () => {
      const merge = (AppHub as unknown as {
        mergedChannelsOf(tables: readonly Record<string, true>[]): unknown
      }).mergedChannelsOf

      expect(() => merge([{ 'app:info': true }, { 'app:info': true }]))
        .toThrow('Two IPC services claim the same channel: app:info')
    })
  })
})
