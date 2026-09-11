import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RateMonitorSnapshot } from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  SessionModelInfo,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type {
  AppClientUiBridge,
  IpcResult,
  LoadSidebarsResult,
} from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import type { BareCommandId, CommandDescriptor } from '../../shared/commands'
import type { SessionsTabsView } from '../../shared/sessionsViewState'
import { SidebarsState, type SidebarsStateValue } from '../../shared/sidebarsState'
import type { TabControlAck, TabControlCommand } from '../../shared/tabControl'
import type { TabMoveTarget, TabTransferLease, TabTransferPayload } from '../../shared/tabTransfer'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import type { WindowAppearance, WindowInfo } from '../../shared/windowInfo'
import { CommandRegistry } from '../commands/commandRegistry'
import { ConfigurationLastTab } from '../overlays/configuration/configurationLastTab'
import type { FinalizeAsk } from '../overlays/finalize/finalizeModel'
import { SessionsFixtures } from '../sessions/fixtures/sessionsFixtures'
import { TabsController } from '../widgets/tabs/tabsController'
import { type ActiveTerminalReading, ActiveTerminalStore } from './activeTerminalStore'
import { HolderShell, MainShell } from './appShell'
import { LateBoundCommand } from './lateBoundCommand'
import { TerminalInputRegistry } from './terminalInputRegistry'
import { WindowInfoStore } from './windowInfoStore'
import { WorkspacePanels } from './workspacePanels'

const remarkableOverlayMock = vi.hoisted(() => ({
  outputPath: 'Q:\\Jamat\\remarkable\\imports\\page 1.png',
  props: null as null | { onInsert(path: string): boolean; onClose(): void },
}))

vi.mock('../overlays/remarkable/remarkableOverlay', () => ({
  RemarkableOverlay: (props: { onInsert(path: string): boolean; onClose(): void }) => {
    remarkableOverlayMock.props = props
    return (
      <div aria-label="Remarkable" className="jamat-remarkable" role="dialog">
        <button type="button" onClick={() => props.onInsert(remarkableOverlayMock.outputPath)}>
          Insert path
        </button>
        <button type="button" onClick={props.onClose}>Close</button>
      </div>
    )
  },
}))

/**
 * xterm measures the DOM and draws into a canvas jsdom does not have. What the shell is asked here is
 * which panel a session's tab is, so the surface inside it is stood in for.
 */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    readonly parser = { registerOscHandler: (): void => {} }
    /** The width table the surface registers on every terminal it opens. */
    readonly unicode = { activeVersion: '6' }
    /** Only what the buffer scan reads before jsdom's zero-sized screen rect ends it. */
    readonly buffer = { active: { getLine: () => undefined, viewportY: 0, length: 0 } }
    /** Read per wheel event by the repeat the attachment installs. */
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    onData(): void {}
    onSelectionChange(): void {}
    getSelection(): string { return '' }
    clearSelection(): void {}
    loadAddon(): void {}
    open(): void {}
    reset(): void {}
    resize(): void {}
    write(): void {}
    focus(): void {}
    dispose(): void {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

/** Only what the shell reaches for, so a channel it stops calling shows up as an unused stub. */
class AppClientStub {
  /** One provider answering and one that never will: both halves of the bar's widget at once. */
  private static readonly rateSnapshotConst: RateMonitorSnapshot = {
    revision: 1,
    providers: {
      claude: {
        kind: 'ok',
        fetchedAt: Date.now(),
        windows: [
          { durationMinutes: 300, usedPercent: 42, resetsAt: null },
          { durationMinutes: 10_080, usedPercent: 12, resetsAt: null },
        ],
      },
      codex: { kind: 'unconfigured', reason: 'codex is not installed' },
    },
  }

  /** One agent session with a transcript to read, so the model widget has something to draw. */
  private static readonly sessionModelConst: Readonly<Record<string, SessionModelInfo>> = {
    's-working': {
      model: 'claude-sonnet-4-5-20260101',
      modelLabel: 'Sonnet 4.5',
      effortLevel: 'high',
      contextTokens: 90_000,
      contextWindow: 1_000_000,
    },
  }

  readonly sessionModelReads: string[] = []
  readonly savedLayouts: string[] = []
  readonly savedSidebars: SidebarsStateValue[] = []
  /** `{ ok: true, value: false }`: the channel worked and the store refused the write. */
  sidebarSavesRefused = false
  readonly savedSessionsViews: SessionsTabsView[] = []
  readonly readinessOrder: string[] = []
  readonly transferCalls: string[] = []
  readonly movedPanels: { panel: TabTransferPayload; target: TabMoveTarget }[] = []
  readonly tabControlAcks: TabControlAck[] = []
  /** What one detected directory answers with, so the composer's own derivations are the only unknown. */
  static readonly detectedDirectoryConst = {
    requestId: 'request-1',
    detectionId: 'detection-1',
    path: 'D:/reports/nightly-logs',
    name: 'nightly-logs',
    directoryKey: 'proved-directory-key',
  }

  readonly rootDirectorySessions: string[] = []
  readonly directoryAtReads: { sessionId: string; path: string }[] = []
  readonly openedDirectories: { requestId: string; detectionId: string }[] = []
  readonly claimedPanels: { panelId: string; title: string }[] = []
  plainCloseCalls = 0
  layoutClears = 0
  transferLease: TabTransferLease | null = null
  sessionSnapshotReads = 0
  sessionSnapshotSubscriptions = 0
  rateSnapshotReads = 0
  sidebarLoads = 0
  layoutFailed = false
  windowInfo: WindowInfo = {
    windowId: 'main',
    role: 'main',
    name: null,
    color: null,
  }
  private menuCommand: ((commandId: BareCommandId) => void) | null = null
  /** A set, not one slot: the bridge pushes to every listener, and a document each brings one. */
  private readonly sessionsChanged = new Set<() => void>()
  private tabsActivatePanel: ((panelId: string) => void) | null = null
  private tabsClosePanel: ((panelId: string) => void) | null = null
  private tabsSessionRestarted: ((sessionId: string) => void) | null = null
  private tabsVisibleSessions: ((sessionIds: readonly string[]) => void) | null = null
  private tabsTransferIn: ((token: string) => void) | null = null
  private tabsTransferOut: ((panelId: string) => void) | null = null
  private tabsControlCommand: ((command: TabControlCommand) => void) | null = null
  private windowChanged: (() => void) | null = null
  private readonly panelBySession = new Map<string, string>()
  /** What the tab menu's handlers asked for, and the answer this stub gives the one question. */
  readonly restarted: string[] = []
  readonly reopened: string[] = []
  /** Every session a tab was told to attach to again, in the order it was told. */
  readonly restartsPublished: string[] = []
  readonly forked: { sessionId: string; name?: string }[] = []
  readonly copied: string[] = []
  readonly referenced: string[] = []
  readonly remoteReferenced: string[] = []
  readonly asked: { message: string; detail: string }[] = []
  confirmAnswer = true

  constructor(
    private readonly sidebars: { sidebars: SidebarsStateValue | null; failed: boolean },
    private readonly transportFails = false,
    private readonly sessionsSnapshot: SessionsSnapshot = SessionsFixtures.mixed(),
  ) {}

  install(): void {
    // `satisfies`, like the preload: a channel added to the bridge without a stub here is a
    // compile error, instead of every mount throwing into an unhandled rejection at run time.
    const bridge = {
      appInfo: () => Promise.resolve({
        ok: true as const,
        value: {
          appVersion: '0.0.0',
          platform: 'win32' as NodeJS.Platform,
          configDir: 'C:/config',
          configIdentity: 'identity',
          runtimeChannel: 'development' as const,
        },
      }),
      rendererReady: () => {
        this.readinessOrder.push('rendererReady')
        return Promise.resolve({ ok: true as const, value: undefined })
      },
      windows: {
        info: () => Promise.resolve({
          ok: true as const,
          value: this.windowInfo,
        }),
        saveAppearance: (appearance) => {
          this.windowInfo = { ...this.windowInfo, ...appearance }
          this.windowChanged?.()
          return Promise.resolve({ ok: true as const, value: this.windowInfo })
        },
      },
      state: {
        loadLayout: () => {
          this.readinessOrder.push('loadLayout')
          return Promise.resolve({
            ok: true as const,
            value: { layout: null, failed: this.layoutFailed },
          })
        },
        saveLayout: (layout: string) => {
          this.savedLayouts.push(layout)
          return Promise.resolve({ ok: true as const, value: true })
        },
        clearLayout: () => {
          this.readinessOrder.push('clearLayout')
          this.layoutClears += 1
          return Promise.resolve({ ok: true as const, value: true })
        },
        loadSidebars: () => this.loadAnswer(),
        saveSidebars: (state: SidebarsStateValue) => {
          this.savedSidebars.push(state)
          return Promise.resolve({ ok: true as const, value: !this.sidebarSavesRefused })
        },
        loadSessionsView: () =>
          Promise.resolve({ ok: true as const, value: { sessionsView: null } }),
        loadSessionFilters: () => Promise.resolve({ ok: true as const, value: [] }),
        saveSessionFilters: () => Promise.resolve({ ok: true as const, value: true }),
        saveSessionsView: (view: SessionsTabsView) => {
          this.savedSessionsViews.push(view)
          return Promise.resolve({ ok: true as const, value: true })
        },
        loadNewSessionAgent: () =>
          Promise.resolve({ ok: true as const, value: 'claude' as const }),
        saveNewSessionAgent: () => Promise.resolve({ ok: true as const, value: true }),
      },
      dialog: {
        pickDirectory: () => {
          throw new Error('No test of the shell picks a directory')
        },
        confirm: (message: string, detail: string) => {
          this.asked.push({ message, detail })
          return Promise.resolve({ ok: true as const, value: this.confirmAnswer })
        },
      },
      projects: AppClientStub.projects(),
      sessions: this.sessions(),
      tabs: {
        claimPanel: (panel) => {
          this.claimedPanels.push({ panelId: panel.panelId, title: panel.title })
          if (panel.sessionId !== null)
            this.panelBySession.set(panel.sessionId, panel.panelId)
          return Promise.resolve({
            ok: true as const,
            value: { kind: 'granted' as const },
          })
        },
        reconcilePanels: (panels) => {
          this.readinessOrder.push('reconcilePanels')
          return Promise.resolve({
            ok: true as const,
            value: {
              acceptedPanelIds: panels.map((panel) => panel.panelId),
              rejectedPanelIds: [],
            },
          })
        },
        releasePanel: () => Promise.resolve({ ok: true as const, value: undefined }),
        setActivePanel: () => {
          this.readinessOrder.push('setActivePanel')
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        openSessionIds: () => Promise.resolve({ ok: true as const, value: [] }),
        closeTerminalPanel: (targetKey) => {
          const panelId = this.panelBySession.get(targetKey)
          if (panelId)
            this.tabsClosePanel?.(panelId)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        publishTerminalRestarted: (targetKey) => {
          this.restartsPublished.push(targetKey)
          this.tabsSessionRestarted?.(targetKey)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        dragStarted: () => Promise.resolve({ ok: true as const, value: undefined }),
        transferPrepare: (token) => {
          this.transferCalls.push(`prepare:${token}`)
          return Promise.resolve({ ok: true as const, value: this.transferLease })
        },
        transferCommit: (token) => {
          this.transferCalls.push(`commit:${token}`)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        transferAbort: (token) => {
          this.transferCalls.push(`abort:${token}`)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        movePanel: (panel, target) => {
          this.movedPanels.push({ panel, target })
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        controlAck: (ack) => {
          this.tabControlAcks.push(ack)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
      },
      // The workspace shell reaches none of it: the bridge is one superset for both documents.
      debug: {
        hostStatus: () => {
          throw new Error('No test of the shell reads the Host debug status')
        },
        pingHost: () => {
          throw new Error('No test of the shell pings the Host')
        },
        sectionActive: () => Promise.resolve({ ok: true as const, value: undefined }),
      },
      versioning: {
        revertCommitFile: async () => { throw new Error('unused') },
        openTortoise: async () => { throw new Error('unused') },
        externalDiff: async () => { throw new Error('unused') },
        openDraft: async () => { throw new Error('unused') },
        openCommitTab: async () => { throw new Error('unused') },
        commitFiles: async () => { throw new Error('unused') },
        readCommit: async () => { throw new Error('unused') },
        setCommitMessage: async () => { throw new Error('unused') },
        runCommit: async () => { throw new Error('unused') },
        closeCommit: async () => ({ ok: true, value: undefined }),
        openCommitSessions: async () => ({ ok: true, value: { revision: 0, sessionIds: [] } }),
        getSettings: () => {
          throw new Error('No test of the shell reads the versioning settings')
        },
        saveSettings: () => {
          throw new Error('No test of the shell saves the versioning settings')
        },
      },
      worktrees: {
        getSettings: () => {
          throw new Error('No test of the shell reads the worktree settings')
        },
        saveSettings: () => {
          throw new Error('No test of the shell saves the worktree settings')
        },
        getProjectSetup: () => {
          throw new Error("No test of the shell reads a project's own setup")
        },
        saveProjectSetup: () => {
          throw new Error("No test of the shell writes a project's own setup")
        },
      },
      fileChanges: {
        getSettings: () => {
          throw new Error('No test of the shell reads the file changes settings')
        },
        saveSettings: () => {
          throw new Error('No test of the shell saves the file changes settings')
        },
        list: () => {
          throw new Error('No test of the shell lists file changes')
        },
        workingTree: () => {
          throw new Error('No test of the shell lists working tree changes')
        },
        history: () => {
          throw new Error('No test of the shell reads file changes history')
        },
        diff: () => {
          throw new Error('No test of the shell reads a file diff')
        },
        openFile: () => {
          throw new Error('No test of the shell opens a changed file')
        },
      },
      fileViewer: {
        openWorkspace: () => { throw new Error('No test of the shell opens a workspace file') },
        restore: () => { throw new Error('No test of the shell restores a file') },
        text: () => { throw new Error('No test of the shell reads file text') },
        version: () => { throw new Error('No test of the shell polls a file version') },
        chunk: () => { throw new Error('No test of the shell reads file bytes') },
        rootDirectory: (sessionId) => {
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: {
                directoryId: `workspace-directory-${sessionId}`,
                rootPath: 'C:/work',
                path: 'C:/work',
                relativePath: '',
                canGoParent: false,
                entries: [],
                truncated: false,
              },
            },
          })
        },
        projectDirectory: (sessionId) => {
          this.rootDirectorySessions.push(sessionId)
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: {
                directoryId: `directory-${sessionId}`,
                rootPath: 'C:/',
                path: 'C:/work',
                relativePath: 'work',
                canGoParent: true,
                entries: [],
                truncated: false,
              },
            },
          })
        },
        directoryAt: (sessionId, path) => {
          this.directoryAtReads.push({ sessionId, path })
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: {
                directoryId: `detected-directory-${sessionId}`,
                rootPath: 'D:/',
                path,
                relativePath: 'logs',
                canGoParent: true,
                entries: [],
                truncated: false,
              },
            },
          })
        },
        documentDirectory: () => { throw new Error('No test of the shell opens a file directory') },
        directoryEntry: () => { throw new Error('No test of the shell enters a directory') },
        parentDirectory: () => { throw new Error('No test of the shell leaves a directory') },
        openEntry: () => { throw new Error('No test of the shell opens a directory file') },
        mediaResource: () => { throw new Error('No test of the shell opens media') },
        relativeResource: () => { throw new Error('No test of the shell opens Markdown media') },
        copyPath: () => { throw new Error('No test of the shell copies a file path') },
        openExternal: () => { throw new Error('No test of the shell opens an external URL') },
        release: () => { throw new Error('No test of the shell releases a file') },
      },
      ui: {
        getSettings: () => {
          throw new Error('No test of the shell reads the UI settings')
        },
        saveSettings: () => {
          throw new Error('No test of the shell saves the UI settings')
        },
      },
      // Answered rather than thrown: the sidebar's launcher button names a key, so the shell reads
      // this whenever it draws one.
      keyboard: {
        getSettings: () => Promise.resolve({
          ok: true as const,
          value: { launcherKeys: 'session-first' as const },
        }),
        saveSettings: () => {
          throw new Error('No test of the shell saves the keyboard settings')
        },
      },
      agents: {
        getSettings: () => Promise.resolve({
          ok: true as const,
          value: { claude: { yolo: false }, codex: { yolo: false } },
        }),
        saveSettings: () => {
          throw new Error('No test of the shell saves the agent settings')
        },
        setAutoCompact: () => {
          throw new Error('No test of the shell changes auto-compact yet')
        },
      },
      contextCompaction: {
        claimAutomatic: () => Promise.resolve({ ok: true as const, value: true }),
        cooldown: () => Promise.resolve({ ok: true, value: null }),
        noteManual: () => Promise.resolve({ ok: true as const, value: undefined }),
      },
      remote: {
        snapshot: () => Promise.resolve({
          ok: true as const,
          value: { revision: 0, outbound: [], inbound: [] },
        }),
        connect: () => Promise.resolve({ ok: true as const, value: { ok: true as const, value: undefined } }),
        selectSession: () => Promise.resolve({ ok: true as const, value: { ok: true as const, value: undefined } }),
        disconnect: () => Promise.resolve({ ok: true as const, value: undefined }),
        release: () => Promise.resolve({ ok: true as const, value: undefined }),
        describeAgents: () => { throw new Error('No test of the shell describes remote agents') },
        listProjects: () => { throw new Error('No test of the shell lists remote projects') },
        createSession: () => { throw new Error('No test of the shell creates a remote session') },
        reopenSession: () => { throw new Error('No test of the shell reopens a remote session') },
        finalizeSession: () => { throw new Error('No test of the shell finalizes a remote session') },
        sessionReference: (endpointId: string, sessionId: string) => {
          this.remoteReferenced.push(`${endpointId}:${sessionId}`)
          return Promise.resolve({
            ok: true as const,
            value: { ok: true as const, value: { text: `AppJamatV3 session remote ${sessionId}` } },
          })
        },
        terminalAttach: () => { throw new Error('No test of the shell attaches a remote terminal') },
        terminalInput: () => { throw new Error('No test of the shell writes to a remote terminal') },
        terminalResize: () => { throw new Error('No test of the shell resizes a remote terminal') },
        terminalActive: () => { throw new Error('No test of the shell activates a remote terminal') },
        terminalDetach: () => { throw new Error('No test of the shell detaches a remote terminal') },
      },
      remoteSettings: {
        get: () => { throw new Error('No test of the shell reads the remote settings') },
        saveListener: () => { throw new Error('No test of the shell saves the remote listener') },
        connectPairing: () => { throw new Error('No test of the shell connects a computer') },
        setProfileEndpoint: () => {
          throw new Error('No test of the shell moves a remote endpoint')
        },
        retryProfile: () => { throw new Error('No test of the shell retries a remote dial') },
        forgetProfile: () => { throw new Error('No test of the shell forgets a paired computer') },
        revokeInbound: () => { throw new Error('No test of the shell revokes inbound access') },
      },
      onMenuCommand: (callback: (commandId: BareCommandId) => void) => {
        this.menuCommand = callback
        return () => { this.menuCommand = null }
      },
      onAppError: () => () => undefined,
      onWindowChanged: (callback: () => void) => {
        this.windowChanged = callback
        return () => { this.windowChanged = null }
      },
      onSessionsChanged: (callback: () => void) => {
        this.sessionSnapshotSubscriptions += 1
        this.sessionsChanged.add(callback)
        return () => {
          if (this.sessionsChanged.delete(callback))
            this.sessionSnapshotSubscriptions -= 1
        }
      },
      onRemoteChanged: () => () => undefined,
      onTabsActivatePanel: (callback: (panelId: string) => void) => {
        this.tabsActivatePanel = callback
        return () => { this.tabsActivatePanel = null }
      },
      onTabsClosePanel: (callback: (panelId: string) => void) => {
        this.tabsClosePanel = callback
        return () => { this.tabsClosePanel = null }
      },
      onTabsTerminalRestarted: (callback: (targetKey: string) => void) => {
        this.tabsSessionRestarted = callback
        return () => { this.tabsSessionRestarted = null }
      },
      onTabsVisibleTerminalTargets: (callback: (targetKeys: readonly string[]) => void) => {
        this.tabsVisibleSessions = callback
        return () => { this.tabsVisibleSessions = null }
      },
      onTabsTransferIn: (callback: (token: string) => void) => {
        this.tabsTransferIn = callback
        return () => { this.tabsTransferIn = null }
      },
      onTabsTransferOut: (callback: (panelId: string) => void) => {
        this.tabsTransferOut = callback
        return () => { this.tabsTransferOut = null }
      },
      onTabsControlCommand: (callback) => {
        this.tabsControlCommand = callback
        return () => { this.tabsControlCommand = null }
      },
      rateMonitor: {
        get: () => {
          this.rateSnapshotReads += 1
          return Promise.resolve({ ok: true as const, value: AppClientStub.rateSnapshotConst })
        },
        refresh: () => { throw new Error('No test of the shell refreshes the rate limits') },
        debugStatus: () => { throw new Error('The rate debug view belongs to the Debug window') },
      },
      sessionModel: {
        get: (sessionId: string) => {
          this.sessionModelReads.push(sessionId)
          const info = AppClientStub.sessionModelConst[sessionId]
          return Promise.resolve({
            ok: true as const,
            value: info === undefined
              ? { kind: 'none' as const, reason: 'nothing has been written yet' }
              : { kind: 'ok' as const, info },
          })
        },
      },
      sessionTranscript: {
        get: () => Promise.resolve({
          ok: true as const,
          value: {
            kind: 'none' as const,
            code: 'transcript-not-found' as const,
            reason: 'nothing has been written yet',
          },
        }),
      },
      onUiSettingsChanged: () => () => undefined,
      onCommitChanged: () => () => undefined,
      onKeyboardSettingsChanged: () => () => undefined,
      onAgentSettingsChanged: () => () => undefined,
      onRateChanged: () => () => undefined,
      onHostPingResult: () => () => undefined,
      // Answered rather than refused: opening a session's tab is how the shell's two panel-id
      // derivations are compared. What the surface then draws is the panel's own business.
      terminal: {
        attach: () => Promise.resolve({ ok: true as const, value: { ok: true as const } }),
        input: () => Promise.resolve({ ok: true as const, value: undefined }),
        resize: () => Promise.resolve({ ok: true as const, value: undefined }),
        active: () => Promise.resolve({ ok: true as const, value: undefined }),
        detach: () => Promise.resolve({ ok: true as const, value: undefined }),
        clipboardRead: () => Promise.resolve({ ok: true as const, value: '' }),
        clipboardWrite: () => Promise.resolve({ ok: true as const, value: true }),
      },
      terminalMenu: {
        detect: () => Promise.resolve({
          ok: true as const,
          value: {
            requestId: AppClientStub.detectedDirectoryConst.requestId,
            detections: [{
              kind: 'directory' as const,
              detectionId: AppClientStub.detectedDirectoryConst.detectionId,
              path: AppClientStub.detectedDirectoryConst.path,
              name: AppClientStub.detectedDirectoryConst.name,
              via: 'direct' as const,
              children: [],
              childrenTruncated: false,
            }],
          },
        }),
        openFile: () => { throw new Error('No test of the shell opens a detected file') },
        openExternal: () => { throw new Error('No test of the shell opens a detection outside') },
        openDirectory: (requestId: string, detectionId: string) => {
          this.openedDirectories.push({ requestId, detectionId })
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: {
                sessionId: 's-working',
                path: AppClientStub.detectedDirectoryConst.path,
                directoryKey: AppClientStub.detectedDirectoryConst.directoryKey,
              },
            },
          })
        },
        openVsCode: () => { throw new Error('No test of the shell opens VS Code') },
        openProjectVsCode: () => { throw new Error('No test of the shell opens a project in VS Code') },
      },
      remarkable: AppClientStub.remarkable(),
      clipboard: {
        writeText: (text: string) => {
          this.copied.push(text)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
      },
      onTerminalFrame: () => () => undefined,
      onRemoteTerminalFrame: () => () => undefined,
    } satisfies AppClientUiBridge
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = bridge
  }

  /** `ok: false` is the transport failing, which must latch the same way a damaged file does. */
  private loadAnswer(): Promise<IpcResult<LoadSidebarsResult>> {
    this.sidebarLoads += 1
    if (this.transportFails)
      return Promise.resolve({ ok: false as const, error: 'main process is gone' })
    return Promise.resolve({ ok: true as const, value: this.sidebars })
  }

  run(commandId: BareCommandId): void {
    if (!this.menuCommand)
      throw new Error('The shell subscribed to no menu command')
    act(() => this.menuCommand?.(commandId))
  }

  pushSessionsChanged(): void {
    act(() => {
      for (const listener of [...this.sessionsChanged]) listener()
    })
  }

  activatePanel(panelId: string): void {
    act(() => this.tabsActivatePanel?.(panelId))
  }

  closePanel(panelId: string): void {
    act(() => this.tabsClosePanel?.(panelId))
  }

  restartSession(sessionId: string): void {
    act(() => this.tabsSessionRestarted?.(sessionId))
  }

  setVisibleSessions(sessionIds: readonly string[]): void {
    act(() => this.tabsVisibleSessions?.(sessionIds))
  }

  transferIn(token: string): void {
    act(() => this.tabsTransferIn?.(token))
  }

  transferOut(panelId: string): void {
    act(() => this.tabsTransferOut?.(panelId))
  }

  controlTabs(command: TabControlCommand): void {
    act(() => this.tabsControlCommand?.(command))
  }

  pushWindowAppearance(appearance: WindowAppearance): void {
    this.windowInfo = { ...this.windowInfo, ...appearance }
    act(() => this.windowChanged?.())
  }

  private static remarkable(): AppClientUiBridge['remarkable'] {
    const success = () => Promise.resolve({
      ok: true as const,
      value: { ok: true as const, value: undefined },
    })
    const unavailable = () => Promise.resolve({
      ok: true as const,
      value: {
        ok: false as const,
        code: 'invalid-operation' as const,
        detail: 'No reMarkable operation is active in this shell test',
        retryable: false,
      },
    })
    return {
      getSettings: () => Promise.resolve({
        ok: true,
        value: { value: { timeoutMilliseconds: 180_000 }, passwordConfigured: false },
      }),
      saveSettings: success,
      saveImport: success,
      getStorage: () => Promise.resolve({
        ok: true as const,
        value: { scope: 'global' as const, projectDirectory: '.remarkable' },
      }),
      saveStorage: success,
      setPassword: success,
      clearPassword: success,
      detectFingerprint: unavailable,
      testConnection: success,
      dependenciesStatus: () => Promise.resolve({
        ok: true,
        value: { kind: 'missing', detail: 'No reMarkable sidecar is installed in this shell test' },
      }),
      installDependencies: unavailable,
      startOperation: unavailable,
      pages: unavailable,
      render: unavailable,
      preview: unavailable,
      release: () => Promise.resolve({ ok: true, value: undefined }),
    }
  }

  /**
   * The launcher reads three of these the moment it opens and the settings tab reads the catalog as
   * soon as it is drawn; the rest still throw, so the day the shell reaches one the test says which
   * rather than handing back an answer nothing produced.
   */
  private static projects(): AppClientUiBridge['projects'] {
    const refuse = (name: string) => () => {
      throw new Error(`The shell called projects.${name}, which nothing in the renderer uses yet`)
    }
    return {
      getConfig: () => Promise.resolve({
        ok: true as const,
        value: { ok: true as const, value: [] },
      }),
      saveConfig: refuse('saveConfig'),
      categories: () => Promise.resolve({ ok: true as const, value: [] }),
      list: () => Promise.resolve({
        ok: true as const,
        value: {
          ok: true as const,
          value: {
            entries: [],
            projects: [],
            virtualFolders: [],
            truncated: false,
            available: true,
          },
        },
      }),
      sessions: () => Promise.resolve({
        ok: true as const,
        value: { ok: true as const, value: { claude: [], codex: [], merged: [] } },
      }),
      create: refuse('create'),
      rename: refuse('rename'),
      movePrefix: refuse('movePrefix'),
      archive: refuse('archive'),
      deletePreview: refuse('deletePreview'),
      deleteProject: refuse('deleteProject'),
    }
  }

  /**
   * The tree and the status item read the snapshot the moment they mount, and the create screen
   * reads the number it would propose as soon as a project row opens it. The stop is answered
   * because it is what the shell closes a session's tab from; the rest still names itself when it
   * is reached.
   */
  private sessions(): AppClientUiBridge['sessions'] {
    const refuse = (name: string) => () => {
      throw new Error(`The shell called sessions.${name}, which nothing in the renderer uses yet`)
    }
    return {
      snapshot: () => {
        this.sessionSnapshotReads += 1
        return Promise.resolve({ ok: true as const, value: this.sessionsSnapshot })
      },
      create: refuse('create'),
      // Read whenever a card opens on Continue/Fork, which the two commands acting on a session
      // now do: this project has nothing recorded, so the session's own row is the whole list.
      historyReferences: () => Promise.resolve({
        ok: true as const,
        value: { ok: true as const, value: { references: [] } },
      }),
      openHistory: refuse('openHistory'),
      reopen: (sessionId: string) => {
        this.reopened.push(sessionId)
        return Promise.resolve({ ok: true as const, value: { ok: true as const, value: undefined } })
      },
      finalize: () => Promise.resolve({
        ok: true as const,
        value: { ok: true as const, value: undefined },
      }),
      remove: refuse('remove'),
      closePlain: () => {
        this.plainCloseCalls += 1
        return Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: undefined },
        })
      },
      promotePlain: refuse('promotePlain'),
      fork: (sessionId: string, options?: { name?: string }) => {
        this.forked.push({ sessionId, ...(options?.name === undefined ? {} : { name: options.name }) })
        return Promise.resolve({
          ok: true as const,
          value: {
            ok: true as const,
            value: { sessionId: 'forked-1', tabTitle: 'AppJamatV3 - 008' },
          },
        })
      },
      restart: (sessionId: string) => {
        this.restarted.push(sessionId)
        return Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: undefined },
        })
      },
      setColor: refuse('setColor'),
      setDetails: refuse('setDetails'),
      discardWorktree: refuse('discardWorktree'),
      retrySetup: refuse('retrySetup'),
      adoptOrphan: refuse('adoptOrphan'),
      nextNumber: () => Promise.resolve({
        ok: true as const,
        value: { ok: true as const, value: { token: 'number-4' } },
      }),
      allocateNumber: refuse('allocateNumber'),
      startHost: refuse('startHost'),
      reference: (sessionId: string) => {
        this.referenced.push(sessionId)
        return Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: { text: `AppJamatV3 session local ${sessionId}` } },
        })
      },
    }
  }
}

class Sidebars {
  static of(container: HTMLElement, title: string): HTMLElement {
    const dock = container.querySelector(`[aria-label="${title}"]`)
    if (!(dock instanceof HTMLElement))
      throw new Error(`The shell renders no sidebar titled ${JSON.stringify(title)}`)
    return dock
  }

  static hidden(container: HTMLElement, title: string): boolean {
    return Sidebars.of(container, title).classList.contains('jamat-sidebar--hidden')
  }

  static localState(container: HTMLElement, title: string): string {
    const button = Sidebars.of(container, title).querySelector('.jamat-sidebar-probe__button')
    if (!(button instanceof HTMLElement))
      throw new Error('The sidebar view renders no local-state button')
    return button.textContent ?? ''
  }
}

describe('app-client-ui/renderer/shell/appShell', () => {
  // Unmounted BEFORE the stub goes away: dockview's onReady lands a tick late, and a shell that
  // reaches for window.appClient after the test removed it throws into nobody's hands.
  afterEach(() => {
    // Real again for the next test: the three negative sidebar tests below move the clock rather
    // than sleeping on it, and a fake clock left installed would stop the next mount settling.
    vi.useRealTimers()
    cleanup()
    // The settings card reopens where it was last left, and that outlives an unmount by design:
    // without this, a case that opened Window hands the next one a Window tab it never set up.
    ConfigurationLastTab.reset()
    WindowInfoStore.reset()
    AppShellTest.clearPalette()
    remarkableOverlayMock.props = null
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(
    stored: { sidebars: SidebarsStateValue | null; failed: boolean },
    transportFails = false,
  ) {
    const client = new AppClientStub(stored, transportFails)
    client.install()
    const view = render(<MainShell />)
    await waitFor(() => expect(view.container.querySelector('.jamat-sidebar')).toBeTruthy())
    return { client, view }
  }

  async function mountHolder() {
    const client = new AppClientStub({ sidebars: null, failed: false })
    client.install()
    const view = render(<HolderShell />)
    await waitFor(() => expect(view.container.querySelector('.jamat-shell__workspace')).toBeTruthy())
    return { client, view }
  }

  function activeTarget(sessionId: string): {
    activate(sessionId: string): void
  } {
    let reading: ActiveTerminalReading = {
      panelId: `terminal:${JSON.stringify(TerminalTargetCodec.params({ kind: 'local', sessionId }))}`,
      target: { kind: 'local', sessionId },
    }
    vi.spyOn(ActiveTerminalStore.prototype, 'current').mockImplementation(() => reading)
    return {
      activate: (nextSessionId) => {
        reading = {
          panelId: `terminal:${JSON.stringify(TerminalTargetCodec.params({
            kind: 'local',
            sessionId: nextSessionId,
          }))}`,
          target: { kind: 'local', sessionId: nextSessionId },
        }
      },
    }
  }

  function transferPanel(
    key: 'probe' | 'terminal' | 'directoryViewer' = 'probe',
  ): TabTransferPayload {
    if (key === 'directoryViewer')
      return {
        panelId: 'directoryViewer:detected-key',
        key,
        title: 'logs',
        params: { sessionId: 's-working', path: 'D:/logs' },
        sessionId: 's-working',
        presentation: null,
      }
    else if (key === 'probe')
      return {
        panelId: 'probe:stable-id',
        key,
        title: 'Transferred Probe',
        params: { serial: 1, sidebar: { width: 280 } },
        sessionId: null,
        presentation: null,
      }
    else if (key === 'terminal')
      return {
        panelId: 'terminal:plain-stable-id',
        key,
        title: 'Transferred Plain',
        params: { sessionId: 's-working', presentation: 'tab' },
        sessionId: 's-working',
        presentation: 'plain',
      }
    else
      throw new Error(`Unknown transfer panel key: ${JSON.stringify(key)}`)
  }

  it('draws the left sidebar open and the right one closed but present', async () => {
    const { view } = await mount({ sidebars: null, failed: false })

    expect(Sidebars.hidden(view.container, 'Sessions')).toBe(false)
    expect(Sidebars.hidden(view.container, 'Right Probe')).toBe(true)
  })

  /**
   * A holder reads the sessions document like every other workspace - its terminal tabs draw their
   * session's work state - and that is the whole of what it shares with main. The sidebars, the
   * restart chain and the Host reading stay where the one window that owns them is.
   */
  it('builds a holder without main-only sidebars, restart chain or Host status', async () => {
    const { client, view } = await mountHolder()
    await waitFor(() => expect(view.container.textContent).toContain('v0.0.0'))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(view.container.querySelector('.jamat-sidebar')).toBeNull()
    expect(view.container.textContent).not.toContain('Host v')
    expect(client.sidebarLoads).toBe(0)
    expect(client.sessionSnapshotReads).toBe(1)
    expect(client.sessionSnapshotSubscriptions).toBe(1)
    // The rate limits are the machine's, so a holder draws them too - once, like the sessions.
    expect(client.rateSnapshotReads).toBe(1)
  })

  it('flushes only the tab controller when a holder closes', async () => {
    const { client } = await mountHolder()

    vi.useFakeTimers()
    act(() => void window.dispatchEvent(new Event('beforeunload')))
    act(() => void vi.advanceTimersByTime(400))

    expect(client.sidebarLoads).toBe(0)
    expect(client.savedSidebars).toEqual([])
  })

  it('opens the launcher and settings overlays in a holder', async () => {
    const { client, view } = await mountHolder()

    client.run('session.new')
    expect(view.container.querySelector('.jamat-launcher')).toBeTruthy()
    const launcher = view.container.querySelector('.jamat-launcher__card')
    if (!(launcher instanceof HTMLElement))
      throw new Error('The holder drew no launcher card')
    act(() => void fireEvent.keyDown(view.getByRole('textbox', { name: 'Filter projects' }), { key: 'Escape' }))

    client.run('settings.open')
    expect(view.container.querySelector('.jamat-configuration')).toBeTruthy()
  })

  it('receives a command transfer through the same durable transaction as a drop', async () => {
    const { client, view } = await mountHolder()
    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))
    const payload = transferPanel()
    client.transferLease = { token: 'token-1', panel: payload }

    client.transferIn('token-1')

    await waitFor(() => expect(client.transferCalls).toEqual([
      'prepare:token-1',
      'commit:token-1',
    ]))
    expect(view.container.textContent).toContain('Transferred Probe')
    expect(view.container.textContent).not.toContain('Home')
    expect(client.savedLayouts.at(-1)).toContain('probe:stable-id')
    expect(client.savedLayouts.at(-1)).not.toContain('welcome:{}')
  })

  it('removes a transferred plain tab without invoking the runtime close operation', async () => {
    const { client, view } = await mountHolder()
    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))
    const payload = transferPanel('terminal')
    client.transferLease = { token: 'token-1', panel: payload }
    client.transferIn('token-1')
    await waitFor(() => expect(client.transferCalls).toContain('commit:token-1'))
    const clearsBefore = client.layoutClears

    client.transferOut(payload.panelId)

    await waitFor(() => expect(client.layoutClears).toBe(clearsBefore + 1))
    expect(view.container.textContent).not.toContain('Transferred Plain')
    expect(client.plainCloseCalls).toBe(0)
  })

  it('keeps Move to New Window inert on Home and sends the exact active payload otherwise', async () => {
    const { client } = await mountHolder()
    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))

    client.run('tab.moveToNewWindow')
    expect(client.movedPanels).toEqual([])

    const payload = transferPanel()
    client.transferLease = { token: 'token-1', panel: payload }
    client.transferIn('token-1')
    await waitFor(() => expect(client.transferCalls).toContain('commit:token-1'))
    client.run('tab.moveToNewWindow')
    await waitFor(() => expect(client.movedPanels).toEqual([
      { panel: payload, target: { kind: 'newWindow' } },
    ]))
  })

  it('opens one stable project directory tab for the active session', async () => {
    const { client, view } = await mountHolder()
    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))
    const payload = transferPanel('terminal')
    client.transferLease = { token: 'token-1', panel: payload }
    client.transferIn('token-1')
    await waitFor(() => expect(client.transferCalls).toContain('commit:token-1'))

    client.run('tab.openProjectFolder')

    await waitFor(() => expect(client.rootDirectorySessions).toEqual(['s-working']))
    await waitFor(() => expect(client.savedLayouts.some((layout) =>
      layout.includes('directoryViewer:s-working'))).toBe(true))
    expect(view.getAllByText('Project Folder')).toHaveLength(1)

    client.run('tab.openProjectFolder')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(client.rootDirectorySessions).toEqual(['s-working'])
    expect(view.getAllByText('Project Folder')).toHaveLength(1)
  })

  it('proves a detected directory again where it lands and keeps one tab for it', async () => {
    const { client, view } = await mountHolder()
    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))
    const payload = transferPanel('directoryViewer')
    client.transferLease = { token: 'token-1', panel: payload }

    client.transferIn('token-1')

    await waitFor(() => expect(client.directoryAtReads).toEqual([
      { sessionId: 's-working', path: 'D:/logs' },
    ]))
    const layout = client.savedLayouts.at(-1) ?? ''
    expect(layout).toContain('directoryViewer:detected-key')
    expect(layout).toContain('D:/logs')
    expect(layout).not.toContain('detected-directory')
    expect(client.rootDirectorySessions).toEqual([])

    // Asking for the same directory again is the same panel id, so it lands on the open tab.
    client.activatePanel(payload.panelId)

    expect(view.getAllByRole('region', { name: 'Directory' })).toHaveLength(1)
    expect(client.directoryAtReads).toHaveLength(1)
  })

  /*
   * The tab a detected directory becomes, built here rather than read out of a payload a transfer
   * happened to carry: the id is the key main derived from the session AND the path, so two
   * detected directories of one session are two tabs, and the title is the leaf that fits on one.
   */
  it('builds a detected directory tab from the proved key and the leaf of its path', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    AppShellTest.rightClickTerminal(view.container, 's-working')
    const open = await waitFor(() => AppShellTest.menuItem('Open D:/reports/nightly-logs in tab'))
    act(() => void fireEvent.click(open))

    await waitFor(() => expect(client.openedDirectories)
      .toEqual([{ requestId: 'request-1', detectionId: 'detection-1' }]))
    await waitFor(() => expect(client.claimedPanels).toContainEqual({
      panelId: 'directoryViewer:proved-directory-key',
      title: 'nightly-logs',
    }))
    await waitFor(() => expect(client.directoryAtReads)
      .toEqual([{ sessionId: 's-working', path: 'D:/reports/nightly-logs' }]))
  })

  it('uses a UUID for every probe opened in a holder', async () => {
    const first = '00000000-0000-4000-8000-000000000001'
    const second = '00000000-0000-4000-8000-000000000002'
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const { client, view } = await mountHolder()

    client.run('debug.newProbe')
    client.run('debug.newProbe')

    expect(randomUUID).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(view.container.textContent).toContain('Lifecycle Probe 2'))
    expect(view.container.textContent).toContain('Lifecycle Probe 1')
  })

  it('reports renderer readiness only after dockview requested its stored layout', async () => {
    const { client } = await mount({ sidebars: null, failed: false })

    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))
    expect(client.readinessOrder).toEqual([
      'loadLayout',
      'reconcilePanels',
      'clearLayout',
      'setActivePanel',
      'rendererReady',
    ])
  })

  it('reports renderer readiness after a failed restore without reconciling or writing', async () => {
    const client = new AppClientStub({ sidebars: SidebarsState.default(), failed: false })
    client.layoutFailed = true
    client.install()
    render(<MainShell />)

    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))
    expect(client.readinessOrder).toEqual(['loadLayout', 'setActivePanel', 'rendererReady'])
    expect(client.savedLayouts).toEqual([])
  })

  /**
   * The boot's only snapshot publication can land BEFORE restore created the panels: subscribe does
   * not replay, and the revision gate refuses a refetch, so a restored tab would keep a pre-rename
   * title until the next sessions event. The gate here holds the layout back until the snapshot has
   * been published, and what it pins is the one catch-up call after the restore.
   */
  it('applies the session titles once more after the layout restore', async () => {
    const applied = vi.spyOn(TabsController.prototype, 'applySessionTitles')
    const client = new AppClientStub({ sidebars: null, failed: false })
    client.install()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(window.appClient.state, 'loadLayout').mockImplementation(async () => {
      await gate
      return { ok: true as const, value: { layout: null, failed: false } }
    })
    const view = render(<MainShell />)

    // The snapshot is published while the restore is still waiting on its layout.
    await waitFor(() => expect(view.container.querySelector('[data-session="s-working"]'))
      .toBeTruthy())
    const before = applied.mock.calls.length
    release()

    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))
    expect(applied.mock.calls.length).toBeGreaterThan(before)
    // The catch-up carries the pairs of the snapshot that arrived early, read off the store.
    expect(applied.mock.calls.at(-1)?.[0]).toEqual(SessionsFixtures.mixed().sessions)
  })

  /**
   * The substrate the terminal widgets and sessions tint read. Main answers with a cross-window set,
   * so the surfaces of THIS document read a value this document writes before the call leaves.
   */
  it('writes the active terminal of this window before the main process is told', async () => {
    const client = new AppClientStub({ sidebars: null, failed: false })
    client.install()
    const wrote = vi.spyOn(ActiveTerminalStore.prototype, 'set')
    const told = vi.spyOn(window.appClient.tabs, 'setActivePanel')
    const view = render(<MainShell />)
    await waitFor(() => expect(view.container.querySelector('.jamat-sidebar')).toBeTruthy())
    const row = Sidebars.of(view.container, 'Sessions').querySelector('[data-session="s-working"]')
    if (!(row instanceof HTMLElement))
      throw new Error('The sessions tree drew no row for the live session')
    const open = [...row.querySelectorAll('button')]
      .find((node) => node.textContent === 'Alpha worktree')
    if (!open)
      throw new Error('The session row draws no title to open it by')

    fireEvent.click(open)

    const panelId = 'terminal:{"sessionId":"s-working"}'
    await waitFor(() => expect(told.mock.calls.map(([id]) => id)).toContain(panelId))
    // The restore wrote first, with the welcome panel in front: a panel of any other kind is no
    // terminal, and the same wrap says so.
    expect(wrote.mock.calls[0][0]).toBeNull()
    const written = wrote.mock.calls.findIndex(([reading]) => reading !== null)
    expect(wrote.mock.calls[written][0]).toEqual({
      panelId,
      target: { kind: 'local', sessionId: 's-working' },
    })
    expect(wrote.mock.invocationCallOrder[written]).toBeLessThan(
      told.mock.invocationCallOrder[told.mock.calls.findIndex(([id]) => id === panelId)],
    )
  })

  it('moves the sessions tint with this window while cross-window visibility stays stale', async () => {
    const client = new AppClientStub({ sidebars: null, failed: false })
    client.install()
    const view = render(<MainShell />)
    await waitFor(() => expect(view.container.querySelector('[data-session="s-working"]'))
      .toBeTruthy())
    const current = (sessionId: string) => Sidebars.of(view.container, 'Sessions')
      .querySelector(`[data-session="${sessionId}"] > .jamat-sessions__row`)
      ?.getAttribute('aria-current') ?? null

    client.setVisibleSessions(['s-working'])
    expect(current('s-working')).toBeNull()

    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(current('s-working')).toBe('true'))

    AppShellTest.openSession(view.container, 'Beta worktree')
    await waitFor(() => expect(current('s-waiting')).toBe('true'))
    expect(current('s-working')).toBeNull()
  })

  it('executes tab control commands through the existing opener and acknowledges the result', async () => {
    const { client } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(client.readinessOrder).toContain('rendererReady'))
    const panelId = 'terminal:{"sessionId":"s-working","presentation":"tab"}'

    client.controlTabs({
      kind: 'open-session',
      requestId: 'open-1',
      sessionId: 's-working',
      tabTitle: 'Alpha - 001',
      plain: true,
    })
    await waitFor(() => expect(client.tabControlAcks).toContainEqual({
      requestId: 'open-1',
      result: { kind: 'opened', panelId },
    }))
    expect(client.claimedPanels.filter((panel) => panel.panelId === panelId)).toHaveLength(1)

    client.controlTabs({
      kind: 'open-session',
      requestId: 'open-2',
      sessionId: 's-working',
      tabTitle: 'Alpha - 001',
      plain: true,
    })
    await waitFor(() => expect(client.tabControlAcks).toContainEqual({
      requestId: 'open-2',
      result: { kind: 'opened', panelId },
    }))
    expect(client.claimedPanels.filter((panel) => panel.panelId === panelId)).toHaveLength(1)

    client.controlTabs({ kind: 'focus-panel', requestId: 'focus-1', panelId })
    await waitFor(() => expect(client.tabControlAcks).toContainEqual({
      requestId: 'focus-1',
      result: { kind: 'focused', panelId },
    }))

    client.controlTabs({ kind: 'close-panel', requestId: 'close-1', panelId })
    await waitFor(() => expect(client.tabControlAcks).toContainEqual({
      requestId: 'close-1',
      result: { kind: 'closed', panelId },
    }))
    expect(client.plainCloseCalls).toBe(1)
  })

  // The command target is bound on every render, and an accelerator can arrive before the first
  // one commits - which is why the throw in `LateBoundCommand` is not dead code.
  it('toggles a side through the menu command it registered', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })

    client.run('view.toggleLeftSidebar')

    expect(Sidebars.hidden(view.container, 'Sessions')).toBe(true)
  })

  // Closing a global sidebar hides it; the content behind it is the surface that outlives tabs.
  it('keeps the view of a closed sidebar alive with its own state', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    const button = Sidebars.of(view.container, 'Right Probe')
      .querySelector('.jamat-sidebar-probe__button')
    if (!(button instanceof HTMLElement))
      throw new Error('The sidebar view renders no local-state button')

    fireEvent.click(button)
    expect(Sidebars.localState(view.container, 'Right Probe')).toBe('Local state: 1')

    client.run('view.toggleRightSidebar')
    client.run('view.toggleRightSidebar')

    expect(Sidebars.hidden(view.container, 'Right Probe')).toBe(true)
    expect(Sidebars.localState(view.container, 'Right Probe')).toBe('Local state: 1')
  })

  // The debounce would otherwise eat the last change before the window closes.
  it('flushes the pending sidebar state when the window is closing', async () => {
    const { client } = await mount({ sidebars: null, failed: false })

    client.run('view.toggleRightSidebar')
    expect(client.savedSidebars).toEqual([])

    act(() => void window.dispatchEvent(new Event('beforeunload')))

    await vi.waitFor(() => expect(client.savedSidebars).toHaveLength(1))
    expect(client.savedSidebars[0].right.visible).toBe(true)
  })

  /*
   * The shell's own half of the refusal, which the hook's test cannot see: this wiring used to
   * answer `result.ok` - "the channel worked" - where the hook asks "was it stored". A drag the
   * store refused then moved the cursor anyway and was never offered again, so the width on screen
   * and the width on disk parted with nothing said.
   */
  it('offers a refused sidebar state again rather than recording it as stored', async () => {
    const { client } = await mount({ sidebars: null, failed: false })
    client.sidebarSavesRefused = true

    client.run('view.toggleRightSidebar')
    await vi.waitFor(() => expect(client.savedSidebars).toHaveLength(1))

    client.run('view.toggleRightSidebar')
    client.run('view.toggleRightSidebar')

    await vi.waitFor(() => expect(client.savedSidebars.length).toBeGreaterThan(1))
    expect(client.savedSidebars.at(-1)?.right.visible).toBe(true)
  })

  it('writes nothing after a state the main process could not read', async () => {
    const { client } = await mount({ sidebars: null, failed: true })

    vi.useFakeTimers()
    client.run('view.toggleRightSidebar')
    act(() => void window.dispatchEvent(new Event('beforeunload')))
    act(() => void vi.advanceTimersByTime(400))

    expect(client.savedSidebars).toEqual([])
  })

  // `ok: false` never reached the store, so its latch cannot protect this path - the renderer's
  // own has to.
  it('latches when the load fails in transport rather than on disk', async () => {
    const { client } = await mount({ sidebars: null, failed: false }, true)

    vi.useFakeTimers()
    client.run('view.toggleRightSidebar')
    act(() => void window.dispatchEvent(new Event('beforeunload')))
    act(() => void vi.advanceTimersByTime(400))

    expect(client.savedSidebars).toEqual([])
  })

  it('opens the launcher overlay from its menu command', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    expect(view.container.querySelector('.jamat-launcher')).toBeNull()

    client.run('session.new')

    expect(view.container.querySelector('.jamat-launcher')).toBeTruthy()
  })

  /**
   * The tree's own verb, moved onto the sidebar's title line so it costs no row of its own. It is
   * the same launcher the menu command opens, opened with no project behind it.
   */
  it('opens the launcher from the sessions sidebar title line', async () => {
    const { view } = await mount({ sidebars: null, failed: false })
    const action = Sidebars.of(view.container, 'Sessions')
      .querySelector('.jamat-sidebar__action')
    if (!(action instanceof HTMLElement))
      throw new Error('The sessions sidebar draws no header action')
    expect(action.textContent).toBe('New session')
    // Read off the catalog rather than written here twice: the tooltip is where somebody learns the
    // key, so it has to be the key the catalog registers.
    expect(action.title).toBe('New Session (Ctrl+T)')

    fireEvent.click(action)

    expect(view.container.querySelector('.jamat-launcher')).toBeTruthy()
    // With no project behind it, which is the whole difference from the row opener below: the card
    // is standing on the screen that picks a project rather than on the one that starts a session.
    expect(view.container.querySelector('.jamat-launcher-projects')).toBeTruthy()
    expect(view.container.querySelector('.jamat-launcher-create')).toBeNull()
  })

  // One flag, one card: a second Ctrl+N must not stack a second overlay over the first.
  it('draws one overlay however often the command runs', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })

    client.run('session.new')
    client.run('session.new')

    expect(view.container.querySelectorAll('.jamat-launcher')).toHaveLength(1)
  })

  it('takes the overlay away again when it closes itself', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    client.run('session.new')
    const card = view.container.querySelector('.jamat-launcher__card')
    if (!(card instanceof HTMLElement))
      throw new Error('The shell drew no launcher card')

    act(() => void fireEvent.keyDown(view.getByRole('textbox', { name: 'Filter projects' }), { key: 'Escape' }))

    expect(view.container.querySelector('.jamat-launcher')).toBeNull()
  })

  it('opens the configuration overlay from its menu command', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    expect(view.container.querySelector('.jamat-configuration')).toBeNull()

    client.run('settings.open')

    expect(view.container.querySelector('.jamat-configuration')).toBeTruthy()
  })

  it('opens the Window tab from the window settings command', async () => {
    AppShellTest.installPalette()
    const client = new AppClientStub({ sidebars: null, failed: false })
    client.install()
    await WindowInfoStore.start()
    const view = render(<HolderShell />)

    client.run('window.settings')

    expect(view.container.querySelector('.jamat-configuration__pane')?.getAttribute('aria-label'))
      .toBe('Window')
  })

  it('takes the configuration overlay away again when it closes itself', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    client.run('settings.open')
    const card = view.container.querySelector('.jamat-configuration__card')
    if (!(card instanceof HTMLElement))
      throw new Error('The shell drew no configuration card')

    act(() => void fireEvent.keyDown(card, { key: 'Escape' }))

    expect(view.container.querySelector('.jamat-configuration')).toBeNull()
  })

  /**
   * The third overlay, opened the way the tab menu opens it: for the session of the tab in front.
   * With nothing of a session's in front there is nothing to edit, so the command opens nothing.
   */
  it('opens the session details card for the session of the tab in front', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    client.run('session.details')
    expect(view.container.querySelector('.jamat-session-details')).toBeNull()

    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    client.run('session.details')

    const input = await waitFor(() => {
      const found = view.container.querySelector('.jamat-session-details__name')
      if (!(found instanceof HTMLInputElement))
        throw new Error('The shell drew no session details card')
      return found
    })
    // The card captured the session it was opened for, off this document's own snapshot.
    expect(input.value).toBe('Alpha worktree')

    const card = view.container.querySelector('.jamat-session-details__card')
    if (!(card instanceof HTMLElement))
      throw new Error('The shell drew no session details card')
    act(() => void fireEvent.keyDown(card, { key: 'Escape' }))
    expect(view.container.querySelector('.jamat-session-details')).toBeNull()
  })

  /**
   * The other direction, and the one the guard used to be blind to: `session.new` carries Ctrl+N,
   * `settings.open` carries Ctrl+, and `tab.new` carries Ctrl+T. All three fire wherever the
   * focus is, so each of them lands on the open rename card, and drawing a second one over it
   * gives Escape and Enter two owners while a half-typed name is still on screen.
   */
  it('leaves the open details card alone when the other overlay commands run', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())
    client.run('session.details')
    const input = await waitFor(() => {
      const found = view.container.querySelector('.jamat-session-details__name')
      if (!(found instanceof HTMLInputElement))
        throw new Error('The shell drew no session details card')
      return found
    })
    act(() => void fireEvent.change(input, { target: { value: 'Half typed' } }))

    client.run('session.new')
    client.run('settings.open')

    expect(view.container.querySelector('.jamat-launcher')).toBeNull()
    expect(view.container.querySelector('.jamat-configuration')).toBeNull()
    expect(view.container.querySelectorAll('.jamat-session-details')).toHaveLength(1)
    expect(view.container.querySelector('.jamat-session-details__name')).toBe(input)
  })

  /**
   * F2 is registered, so it fires wherever the focus is - including onto the card it opened. The
   * card is keyed by the request id, so an ungated second run would re-key it, and a re-keyed card
   * is a fresh one: the name being typed would go without a trace of why.
   */
  it('leaves the open details card alone when its own command runs again', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())
    client.run('session.details')
    const input = await waitFor(() => {
      const found = view.container.querySelector('.jamat-session-details__name')
      if (!(found instanceof HTMLInputElement))
        throw new Error('The shell drew no session details card')
      return found
    })
    act(() => void fireEvent.change(input, { target: { value: 'Half typed' } }))

    client.run('session.details')

    expect(view.container.querySelectorAll('.jamat-session-details')).toHaveLength(1)
    // The same element, not merely one that looks the same: a remount replaces the node.
    expect(view.container.querySelector('.jamat-session-details__name')).toBe(input)
    expect(input.value).toBe('Half typed')
  })

  // The other half of the same guard, and the one the overlay rule is written for: a key reaches
  // the shell while the launcher covers the window, and a second card must not be drawn over it.
  it('opens no details card while another overlay is up', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())
    client.run('session.new')
    expect(view.container.querySelector('.jamat-launcher')).toBeTruthy()

    client.run('session.details')

    expect(view.container.querySelector('.jamat-session-details')).toBeNull()
    expect(view.container.querySelectorAll('.jamat-launcher')).toHaveLength(1)
  })

  it('opens a finalize request through its late-bound shell command', async () => {
    const openFinalize = AppShellTest.captureLateBound<FinalizeAsk>('finalize')
    const { view } = await mount({ sidebars: null, failed: false })

    act(() => openFinalize().open(AppShellTest.finalizeAsk()))

    expect(view.container.querySelectorAll('.jamat-finalize')).toHaveLength(1)
    expect(view.container.querySelector('.jamat-finalize__session')?.textContent)
      .toBe('Dirty worktree')
  })

  it('opens finalize from an ended worktree row on its first click', async () => {
    const client = new AppClientStub(
      { sidebars: null, failed: false },
      false,
      SessionsFixtures.stoppedWorktree(),
    )
    client.install()
    const view = render(<MainShell />)
    const tree = await waitFor(() => Sidebars.of(view.container, 'Sessions'))
    const row = await waitFor(() => {
      const found = tree.querySelector('[data-session="s-dirty"]')
      if (!(found instanceof HTMLElement)) throw new Error('The tree drew no stopped worktree')
      return found
    })
    const finish = [...row.querySelectorAll('button')]
      .find((button) => button.textContent === 'Finish…')
    if (!(finish instanceof HTMLElement)) throw new Error('The row offered no finalize dialog')

    fireEvent.click(finish)

    await waitFor(() => expect(view.container.querySelector('.jamat-finalize')).toBeTruthy())
    expect(view.container.querySelector('.jamat-finalize__session')?.textContent)
      .toBe('Dirty worktree')
    expect(finish.textContent).toBe('Finish…')
  })

  it('does not open finalize while another overlay owns the shell', async () => {
    const openFinalize = AppShellTest.captureLateBound<FinalizeAsk>('finalize')
    const { client, view } = await mount({ sidebars: null, failed: false })
    client.run('session.new')
    expect(view.container.querySelector('.jamat-launcher')).toBeTruthy()

    act(() => openFinalize().open(AppShellTest.finalizeAsk()))

    expect(view.container.querySelector('.jamat-finalize')).toBeNull()
    expect(view.container.querySelectorAll('.jamat-launcher')).toHaveLength(1)
  })

  it.each([
    ['no terminal', null],
    ['a shell terminal', 's-shell'],
    ['a non-live agent terminal', 's-lost'],
  ] as const)('refuses Remarkable for %s before mounting its IPC owner', async (_label, sessionId) => {
    if (sessionId === null)
      vi.spyOn(ActiveTerminalStore.prototype, 'current').mockReturnValue(null)
    else
      activeTarget(sessionId)
    const has = vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(true)
    const report = vi.spyOn(AppClientUiReport, 'error').mockImplementation(() => undefined)
    const { client, view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.querySelector('[data-session="s-working"]')).toBeTruthy())

    client.run('tools.remarkable')

    expect(view.container.querySelector('.jamat-remarkable')).toBeNull()
    expect(remarkableOverlayMock.props).toBeNull()
    expect(report).toHaveBeenCalledWith('Select a writable local Claude or Codex terminal first')
    expect(has).not.toHaveBeenCalled()
  })

  it('refuses a remote terminal before mounting the Remarkable overlay', async () => {
    const panelId = `terminal:${JSON.stringify(TerminalTargetCodec.params({
      kind: 'remote',
      remoteEndpointId: 'remote-a',
      sessionId: 's-working',
    }))}`
    const remote = WorkspacePanels.activeTerminalOf(panelId)
    expect(remote).toEqual({
      panelId,
      target: { kind: 'remote', remoteEndpointId: 'remote-a', sessionId: 's-working' },
    })
    vi.spyOn(ActiveTerminalStore.prototype, 'current').mockReturnValue(remote)
    const has = vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(true)
    vi.spyOn(AppClientUiReport, 'error').mockImplementation(() => undefined)
    const { client, view } = await mount({ sidebars: null, failed: false })

    client.run('tools.remarkable')

    expect(view.container.querySelector('.jamat-remarkable')).toBeNull()
    expect(has).not.toHaveBeenCalled()
  })

  it('refuses a live agent terminal that has no writable input target', async () => {
    activeTarget('s-working')
    const has = vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(false)
    const report = vi.spyOn(AppClientUiReport, 'error').mockImplementation(() => undefined)
    const { client, view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.querySelector('[data-session="s-working"]')).toBeTruthy())

    client.run('tools.remarkable')

    expect(has).toHaveBeenCalledWith('s-working')
    expect(view.container.querySelector('.jamat-remarkable')).toBeNull()
    expect(report).toHaveBeenCalledWith('Select a writable local Claude or Codex terminal first')
  })

  it('opens Remarkable for a live Codex terminal', async () => {
    activeTarget('s-waiting')
    vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(true)
    const { client, view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.querySelector('[data-session="s-waiting"]')).toBeTruthy())

    client.run('tools.remarkable')

    expect(view.container.querySelectorAll('.jamat-remarkable')).toHaveLength(1)
  })

  it('opens Remarkable in a holder workspace', async () => {
    activeTarget('s-working')
    vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(true)
    const { client, view } = await mountHolder()
    await waitFor(() => expect(client.sessionModelReads).toContain('s-working'))

    client.run('tools.remarkable')

    expect(view.container.querySelectorAll('.jamat-remarkable')).toHaveLength(1)
  })

  it('inserts the rendered path only into the session captured before the active tab changes', async () => {
    const active = activeTarget('s-working')
    vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(true)
    const insert = vi.spyOn(TerminalInputRegistry.prototype, 'insert').mockReturnValue(true)
    const { client, view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.querySelector('[data-session="s-working"]')).toBeTruthy())
    client.run('tools.remarkable')
    expect(remarkableOverlayMock.props).not.toBeNull()

    active.activate('s-waiting')
    let accepted = false
    act(() => {
      accepted = remarkableOverlayMock.props?.onInsert(remarkableOverlayMock.outputPath) ?? false
    })

    expect(accepted).toBe(true)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith('s-working', remarkableOverlayMock.outputPath)
  })

  it('returns insertion refusal for captured session A without falling through to active session B', async () => {
    const active = activeTarget('s-working')
    vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(true)
    const insert = vi.spyOn(TerminalInputRegistry.prototype, 'insert')
      .mockImplementation((sessionId) => sessionId !== 's-working')
    const { client, view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.querySelector('[data-session="s-working"]')).toBeTruthy())
    client.run('tools.remarkable')

    active.activate('s-waiting')
    let accepted = true
    act(() => {
      accepted = remarkableOverlayMock.props?.onInsert(remarkableOverlayMock.outputPath) ?? true
    })

    expect(accepted).toBe(false)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith('s-working', remarkableOverlayMock.outputPath)
    expect(view.container.querySelectorAll('.jamat-remarkable')).toHaveLength(1)
  })

  it.each([
    ['session.new', '.jamat-launcher'],
    ['settings.open', '.jamat-configuration'],
    ['session.details', '.jamat-session-details'],
  ] as const)('does not open Remarkable over %s', async (command, selector) => {
    vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(true)
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())
    client.run(command)
    expect(view.container.querySelector(selector)).toBeTruthy()

    client.run('tools.remarkable')

    expect(view.container.querySelector('.jamat-remarkable')).toBeNull()
    expect(view.container.querySelector(selector)).toBeTruthy()
  })

  it('keeps Remarkable as the sole overlay when all other overlay commands run', async () => {
    vi.spyOn(TerminalInputRegistry.prototype, 'has').mockReturnValue(true)
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())
    client.run('tools.remarkable')
    const remarkable = view.container.querySelector('.jamat-remarkable')
    expect(remarkable).toBeTruthy()

    client.run('session.new')
    client.run('settings.open')
    client.run('session.details')

    expect(view.container.querySelector('.jamat-launcher')).toBeNull()
    expect(view.container.querySelector('.jamat-configuration')).toBeNull()
    expect(view.container.querySelector('.jamat-session-details')).toBeNull()
    expect(view.container.querySelector('.jamat-remarkable')).toBe(remarkable)
  })

  // A window saved before the tree existed names a view nobody registers any more. It degrades to
  // the side's first registered view rather than failing the restore, which is what lets this
  // change ship without a state migration.
  it('opens a state that still names the retired probe with the sessions tree', async () => {
    const stored = SidebarsState.coerce({
      left: { visible: false, width: 300, activeView: 'probeLeft' },
      right: { visible: true, width: 280, activeView: 'probeRight' },
    })
    const { view } = await mount({ sidebars: stored, failed: false })

    await waitFor(() => expect(Sidebars.hidden(view.container, 'Right Probe')).toBe(false))
    expect(Sidebars.hidden(view.container, 'Sessions')).toBe(true)
    expect(Sidebars.of(view.container, 'Right Probe').style.width).toBe('280px')
  })

  /**
   * The version and the Host stand together, because both say what this window is running on; the
   * channel keeps the other end of the bar to itself. The gap between the groups is read as an item
   * rather than assumed from the order.
   *
   * The sessions panel used to draw the same reading in its own footer, so the two had to agree
   * about a Host neither of them owned. It is asserted here, in the same test, because it is the
   * same fact: the bar is where this is drawn, and nowhere else is.
   */
  it('reads the Host into the status bar beside the version, and nowhere else', async () => {
    const { view } = await mount({ sidebars: null, failed: false })
    const bar = view.container.querySelector('[aria-label="Status"]')
    if (!(bar instanceof HTMLElement))
      throw new Error('The shell drew no status bar')

    // The welcome panel is in front, so neither terminal widget is drawn and the right group is the
    // channel alone. What separates the pieces on screen is layout, and layout leaves no characters.
    await waitFor(() => expect(AppShellTest.barText(bar)).toEqual([
      'v0.0.0',
      'Host v2026.08.04.09.30 · 4 live',
      '|',
      'development',
    ]))
    expect(Sidebars.of(view.container, 'Sessions').textContent).not.toContain('Host')
  })

  /**
   * Both terminal widgets are about the tab in front, so both arrive with it and both leave with it:
   * the right group reflows once per switch rather than twice. This is the supersession of the
   * earlier "draw the usage widget unconditionally" decision, and the order is the contract - the
   * model reading stands before the usage it explains, and the channel keeps the edge.
   */
  it('draws the session model before the usage widget, and only for a terminal tab', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    const bar = view.container.querySelector('[aria-label="Status"]')
    if (!(bar instanceof HTMLElement))
      throw new Error('The shell drew no status bar')
    await waitFor(() => expect(AppShellTest.barText(bar)).toContain('development'))
    expect(AppShellTest.barText(bar).join('')).not.toContain('S: 42%')

    AppShellTest.openSession(view.container, 'Alpha worktree')

    // Claude's own line, and the arrow to its usage page: the tab in front is a Claude terminal.
    // The Compact button is part of the model item's own text: it sits inside the widget, and since
    // it no longer waits for a fill threshold it is there for every live session.
    await waitFor(() => expect(AppShellTest.barText(bar)).toEqual([
      'v0.0.0',
      'Host v2026.08.04.09.30 · 4 live',
      '|',
      'Sonnet 4.5 · high · 90k / 1M · 9%Compact',
      'S: 42% [████░░░░░░], W: 12% [█░░░░░░░░░]↗',
      'development',
    ]))
    expect(client.sessionModelReads).toEqual(['s-working'])
  })

  /**
   * The one case that would otherwise leave a separator standing on its own for the life of the tab:
   * a session whose transcript says nothing yet, or nothing ever. The usage widget still draws,
   * because what is left of a provider's limits is true whether or not this session has spoken -
   * and this tab is a Codex one, so what it draws is the placeholder of a provider with nothing
   * behind it. That is the one reading the narrowing does NOT hide: hiding it there would leave a
   * user with no credentials no way of ever learning the reading exists.
   */
  it('draws no model slot at all for a terminal whose session has said nothing', async () => {
    const { view } = await mount({ sidebars: null, failed: false })
    const bar = view.container.querySelector('[aria-label="Status"]')
    if (!(bar instanceof HTMLElement))
      throw new Error('The shell drew no status bar')

    AppShellTest.openSession(view.container, 'Beta worktree')

    await waitFor(() => expect(AppShellTest.barText(bar)).toEqual([
      'v0.0.0',
      'Host v2026.08.04.09.30 · 4 live',
      '|',
      '-',
      'development',
    ]))
  })

  it('shows the window name and reacts to a pushed appearance', async () => {
    const client = new AppClientStub({ sidebars: null, failed: false })
    client.windowInfo = {
      windowId: 'holder-1',
      role: 'holder',
      name: 'Review',
      color: AppShellTest.color(1),
    }
    client.install()
    await WindowInfoStore.start()
    const view = render(<HolderShell />)
    const bar = view.container.querySelector('[aria-label="Status"]')
    if (!(bar instanceof HTMLElement))
      throw new Error('The shell drew no status bar')

    await waitFor(() => expect(bar.textContent).toContain('Review'))
    expect(document.documentElement.style.getPropertyValue('--window-color'))
      .toBe(AppShellTest.color(1))

    client.pushWindowAppearance({ name: 'Logs', color: AppShellTest.color(2) })

    await waitFor(() => expect(bar.textContent).toContain('Logs'))
    expect(document.title).toBe('Jamat V3 - Logs')
  })

  it('shares one sessions reader between the tree, Host status and restart chain', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })

    await waitFor(() => expect(view.container.querySelector('[data-session="s-working"]'))
      .toBeTruthy())
    expect(client.sessionSnapshotReads).toBe(1)
    expect(client.sessionSnapshotSubscriptions).toBe(1)

    client.pushSessionsChanged()
    await waitFor(() => expect(client.sessionSnapshotReads).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(client.sessionSnapshotReads).toBe(2)
    expect(client.sessionSnapshotSubscriptions).toBe(1)
  })

  /**
   * One reader per DOCUMENT, and no more. Each of the three below is its own window in the real
   * application, so three readers is the floor rather than a leak; what the rule forbids is a second
   * reader inside one of them, which is why the counts move by exactly three.
   */
  it('gives one main and two holder documents one sessions reader each', async () => {
    const client = new AppClientStub({ sidebars: null, failed: false })
    client.install()
    render(<><MainShell /><HolderShell /><HolderShell /></>)

    await waitFor(() => expect(client.sessionSnapshotReads).toBe(3))
    expect(client.sessionSnapshotSubscriptions).toBe(3)

    client.pushSessionsChanged()

    await waitFor(() => expect(client.sessionSnapshotReads).toBe(6))
    expect(client.sessionSnapshotSubscriptions).toBe(3)
  })

  /**
   * The other opener, and the one that carries something: a project row writes the project into the
   * intent, so the card skips the screen that picks one and opens on the screen that starts a
   * session. Reaching that screen is what asks the Host for a number, which is why the shell's stub
   * answers `nextNumber` at all.
   */
  it('opens the launcher on the create screen from a project row', async () => {
    const { view } = await mount({ sidebars: null, failed: false })
    const button = [...Sidebars.of(view.container, 'Sessions').querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === '+ Session in AppJamatV3')
    if (!(button instanceof HTMLElement))
      throw new Error('The sessions tree drew no launch button on a project row')

    fireEvent.click(button)

    expect(view.container.querySelector('.jamat-launcher')).toBeTruthy()
    await waitFor(() =>
      expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
  })

  /**
   * The two halves of one derivation, compared by running them: the tab is opened from the params
   * the tree hands over, and closed from a panel id this file builds again from the same session.
   * `panelIdOf` is the params stringified, so a key added on one side and not the other closes
   * nothing at all while every other test stays green.
   */
  it('takes the tab of a session away when that session is stopped', async () => {
    const { view } = await mount({ sidebars: null, failed: false })
    const tree = Sidebars.of(view.container, 'Sessions')
    const row = tree.querySelector('[data-session="s-working"]')
    if (!(row instanceof HTMLElement))
      throw new Error('The sessions tree drew no row for the live session')
    const open = [...row.querySelectorAll('button')]
      .find((node) => node.textContent === 'Alpha worktree')
    if (!open)
      throw new Error('The session row draws no title to open it by')

    fireEvent.click(open)
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    // Twice: Finish is armed by the first click and acts on the second.
    const finish = [...row.querySelectorAll('button')].find((node) => node.textContent === 'Finish')
    if (!finish)
      throw new Error('The session row offers no finish')
    fireEvent.click(finish)
    fireEvent.click(finish)

    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeNull())
  })

  /**
   * The question is the client's and the operation is the library's. It is asked only while
   * something is running, because that is when a restart throws away an answer somebody waits for.
   */
  it('asks before restarting a live session, and restarts it once the answer is yes', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    client.run('session.restart')

    await waitFor(() => expect(client.restarted).toEqual(['s-working']))
    expect(client.asked).toEqual([{
      message: 'Restart this session?',
      detail: 'The process running now will be stopped, and the conversation resumed in a new one.',
    }])
  })

  it('restarts nothing when the question is answered no', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    client.confirmAnswer = false
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    client.run('session.restart')

    await waitFor(() => expect(client.asked).toHaveLength(1))
    expect(client.restarted).toEqual([])
  })

  // Nothing is running, so there is no answer to lose and nothing to ask about.
  it('restarts an interrupted session without asking', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Lost claude')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-lost"]')).toBeTruthy())

    client.run('session.restart')

    await waitFor(() => expect(client.restarted).toEqual(['s-lost']))
    expect(client.asked).toEqual([])
  })

  /*
   * The commands that start work beside a session ask before they act, and this is the one whose
   * answer only the library can compose: the card collects a name, the fork itself is the library's
   * from the record. Nothing is forked until the card is submitted, and what the card opens on is
   * Continue/Fork with that session standing as its chosen row.
   */
  it('opens the fork card on the session of the tab in front and forks what it names', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    client.run('session.fork')

    await waitFor(() =>
      expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
    expect(client.forked).toEqual([])
    // The session it would branch is the row the list stands on, and the name field opens holding
    // that session's name.
    expect(AppShellTest.launcherRow(view.container)).toBe('Alpha worktreethis sessionC')
    expect(AppShellTest.launcherName(view.container)).toBe('Alpha worktree')

    fireEvent.click(AppShellTest.launcherStart(view.container))

    await waitFor(() =>
      expect(client.forked).toEqual([{ sessionId: 's-working', name: 'Alpha worktree' }]))
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session forked-1"]')).toBeTruthy())
  })

  it('copies the project folder of the tab in front', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    client.run('tab.copyProjectFolder')

    await waitFor(() => expect(client.copied).toEqual(['C:/Projects/NodeJs/AppJamatV3']))
  })

  /**
   * The block a person hands to a SECOND agent. Nothing about it is composed here - the library
   * writes the text - so what these two hold is the route: a bare argument asks this machine, an
   * endpoint asks what the paired computer last sent, and both end in the same clipboard.
   */
  it('copies the session id of the tab in front', async () => {
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    client.run('session.copyReference')

    await waitFor(() => expect(client.referenced).toEqual(['s-working']))
    expect(client.copied).toEqual(['AppJamatV3 session local s-working'])
    expect(client.remoteReferenced).toEqual([])
  })

  it('asks the paired computer for a session id named with an endpoint', async () => {
    const commandsOf = AppShellTest.captureCommands()
    const { client, view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.textContent).toContain('Alpha worktree'))

    act(() => void commandsOf().execute('session.copyReference', {
      sessionId: 's-remote',
      remoteEndpointId: 'endpoint-a',
    }))

    await waitFor(() => expect(client.remoteReferenced).toEqual(['endpoint-a:s-remote']))
    expect(client.copied).toEqual(['AppJamatV3 session remote s-remote'])
    expect(client.referenced).toEqual([])
  })

  /**
   * The explicit target the tree's menu will send. The tab in front is a LIVE session, whose
   * restart asks first - so the question not being asked is the proof the argument won over the
   * active-tab fallback.
   */
  it('restarts the named session rather than the one behind the active tab', async () => {
    const commandsOf = AppShellTest.captureCommands()
    const { client, view } = await mount({ sidebars: null, failed: false })
    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())

    act(() => void commandsOf().execute('session.restart', { sessionId: 's-lost' }))

    await waitFor(() => expect(client.restarted).toEqual(['s-lost']))
    expect(client.asked).toEqual([])
  })

  // The Compact precedent: a window holding no live terminal for the session refuses with a log.
  it('logs and does nothing for a compact whose named session has no terminal here', async () => {
    const commandsOf = AppShellTest.captureCommands()
    await mount({ sidebars: null, failed: false })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    act(() => void commandsOf().execute('session.compact', { sessionId: 's-working' }))

    expect(errors).toHaveBeenCalledWith(
      '[app-client-ui] compact: no live terminal is attached for session s-working',
    )
  })

  // A tree row needs no open tab: the target names no panel, and the new tab lands by default.
  it('forks a named session with no open tab and opens a tab for what came back', async () => {
    const commandsOf = AppShellTest.captureCommands()
    const { client, view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.textContent).toContain('Alpha worktree'))

    act(() => void commandsOf().execute('session.fork', { sessionId: 's-working' }))

    await waitFor(() =>
      expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
    fireEvent.click(AppShellTest.launcherStart(view.container))

    await waitFor(() =>
      expect(client.forked).toEqual([{ sessionId: 's-working', name: 'Alpha worktree' }]))
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session forked-1"]')).toBeTruthy())
  })

  /*
   * The ended half of the same pair. It brings THAT session back rather than founding one, so what
   * the card sends is an id: the session keeps its number, its name and its colour, and the tab that
   * was left holding a dead screen is told to attach again before it is put in front.
   */
  it('opens the resume card on a stopped session and brings that session back', async () => {
    const commandsOf = AppShellTest.captureCommands()
    const { client, view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.textContent).toContain('Lost claude'))

    // The restart chain reopens lost sessions of its own accord, so what this test reads is what
    // the CARD added: everything before the click belongs to the shell's own startup.
    const before = { reopened: client.reopened.length, published: client.restartsPublished.length }
    act(() => void commandsOf().execute('session.resume', { sessionId: 's-lost' }))

    await waitFor(() =>
      expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
    expect(client.reopened.slice(before.reopened)).toEqual([])
    // No name to type over: the card stands on the session it would bring back and asks nothing.
    expect(view.container.querySelector('[aria-label="Session name"]')).toBeNull()
    expect(AppShellTest.launcherRow(view.container)).toBe('Lost claudethis sessionC')

    fireEvent.click(AppShellTest.launcherStart(view.container))

    await waitFor(() => expect(client.reopened.slice(before.reopened)).toEqual(['s-lost']))
    expect(client.restartsPublished.slice(before.published)).toEqual(['s-lost'])
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-lost"]')).toBeTruthy())
  })

  /*
   * The other three of that block. They start nothing themselves: what arrives is an ordinary create
   * from the card, which is what makes it a session of the tree with a number rather than the
   * unnamed plain tab this used to open.
   */
  it('opens the create card on the session a new-beside command names', async () => {
    const commandsOf = AppShellTest.captureCommands()
    const { view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.textContent).toContain('Alpha worktree'))

    act(() => void commandsOf().execute('session.newBeside', { sessionId: 's-working' }))

    await waitFor(() =>
      expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
    // A fresh session in the same place: nothing is being acted on, so no row stands for one.
    expect(AppShellTest.launcherRow(view.container)).toBeNull()
    expect(AppShellTest.launcherName(view.container)).toBe('Alpha worktree')
  })

  /*
   * The tree opens PROVISIONALLY, and the shell is what turns that intent into the controller's
   * option. Read off the tab rather than off a spy, because the whole point is the chain: row click
   * to intent to option to the mark the tab wears.
   */
  it('opens a tab from the tree as a preview', async () => {
    const { view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.textContent).toContain('Alpha worktree'))

    AppShellTest.openSession(view.container, 'Alpha worktree')

    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())
    expect(AppShellTest.previewTabTitles(view.container)).toEqual(['AppJamatV3 - Alpha worktree'])
  })

  // The browser sends both clicks before the double: the tab opens provisionally and is then kept.
  it('keeps the tab the tree row was double-clicked on', async () => {
    const { view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.textContent).toContain('Alpha worktree'))

    AppShellTest.openSession(view.container, 'Alpha worktree')
    AppShellTest.openSession(view.container, 'Alpha worktree')
    AppShellTest.keepSession(view.container, 'Alpha worktree')

    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())
    await waitFor(() => expect(AppShellTest.previewTabTitles(view.container)).toEqual([]))
  })

  // One preview per window: the second row REPLACES the first rather than stacking beside it.
  it('replaces the preview when another row is clicked', async () => {
    const { view } = await mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.container.textContent).toContain('Alpha worktree'))

    AppShellTest.openSession(view.container, 'Alpha worktree')
    await waitFor(() => expect(view.container
      .querySelector('[aria-label="Terminal for session s-working"]')).toBeTruthy())
    AppShellTest.openSession(view.container, 'Beta worktree')

    await waitFor(() => expect(AppShellTest.previewTabTitles(view.container))
      .toEqual(['AppJamatV3 - Beta worktree']))
    expect(view.container.querySelector('[aria-label="Terminal for session s-working"]')).toBeNull()
  })
})

class AppShellTest {
  private static readonly paletteTokensConst = [
    'red', 'orange', 'amber', 'green', 'teal', 'cyan',
    'sky', 'blue', 'indigo', 'violet', 'magenta', 'rose',
  ] as const

  static color(index: number): string {
    return `#${index.toString(16).padStart(6, '0')}`
  }

  /** What the launcher's create card is holding in its name field. */
  static launcherName(container: HTMLElement): string {
    const input = container.querySelector('.jamat-launcher-create__name-input')
    if (!(input instanceof HTMLInputElement))
      throw new Error('The launcher drew no name field')
    return input.value
  }

  /** The row Continue/Fork stands on, or null where the card is acting on no session at all. */
  static launcherRow(container: HTMLElement): string | null {
    const row = container.querySelector(
      '.jamat-launcher-create__session-row.jamat-launcher__row--selected')
    return row === null ? null : row.textContent
  }

  static launcherStart(container: HTMLElement): HTMLElement {
    const button = container.querySelector('.jamat-launcher__start-button')
    if (!(button instanceof HTMLElement))
      throw new Error('The launcher drew no start button')
    return button
  }

  /** The bar as a run of text per item, with the gap between the two groups read as an item too. */
  static barText(bar: HTMLElement): (string | null)[] {
    return [...bar.children].map((node) =>
      node.classList.contains('jamat-status__spacer') ? '|' : node.textContent)
  }

  /**
   * The registry the shell wired, captured at the one call every composition makes. The tests above
   * hand the explicit target to the same `execute` the tree's row menu calls, without mounting the
   * tree. Restored by the suite's `restoreAllMocks`.
   */
  static captureCommands(): () => CommandRegistry {
    let captured: CommandRegistry | null = null
    const original = CommandRegistry.prototype.assertCovers
    vi.spyOn(CommandRegistry.prototype, 'assertCovers')
      .mockImplementation(function (this: CommandRegistry, commands: readonly CommandDescriptor[]) {
        captured = this
        original.call(this, commands)
      })
    return () => {
      if (captured === null)
        throw new Error('The shell wired no command registry')
      return captured
    }
  }

  static captureLateBound<T>(subject: string): () => LateBoundCommand<T> {
    let captured: LateBoundCommand<T> | null = null
    const bind = LateBoundCommand.prototype.bind
    vi.spyOn(LateBoundCommand.prototype, 'bind').mockImplementation(function (
      this: LateBoundCommand<unknown>,
      target: (argument: unknown) => void,
    ) {
      bind.call(this, target)
      if ((this as unknown as { subject: string }).subject === subject)
        captured = this as LateBoundCommand<T>
    })
    return () => {
      if (captured === null)
        throw new Error(`The shell did not bind its ${subject} command`)
      return captured
    }
  }

  static finalizeAsk(): FinalizeAsk {
    return {
      target: { kind: 'local', sessionId: 's-dirty' },
      scope: 'local',
      sessionTitle: 'Dirty worktree',
      questions: [{
        specId: 'worktree',
        question: {
          label: 'Worktree',
          chosenDefault: 'merge',
          choices: [{
            id: 'merge',
            title: 'Merge back',
            note: 'commits, merges and removes the worktree',
            glyph: '⇤',
            submitLabel: 'Merge',
          }],
        },
      }],
    }
  }

  /** Opens a session's terminal the way a user does: by clicking its title in the tree. */
  static openSession(container: HTMLElement, title: string): void {
    const open = [...Sidebars.of(container, 'Sessions').querySelectorAll('button')]
      .find((node) => node.textContent === title)
    if (!open)
      throw new Error(`The sessions tree draws no row titled ${JSON.stringify(title)}`)
    fireEvent.click(open)
  }

  /** The gesture that says keep it: the row's double-click, which opens permanently. */
  static keepSession(container: HTMLElement, title: string): void {
    const open = [...Sidebars.of(container, 'Sessions').querySelectorAll('button')]
      .find((node) => node.textContent === title)
    if (!open)
      throw new Error(`The sessions tree draws no row titled ${JSON.stringify(title)}`)
    fireEvent.doubleClick(open)
  }

  /** What the tabs in italics say, which is the only place the preview state is visible. */
  static previewTabTitles(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.jamat-tab.is-preview .jamat-tab__title')]
      .map((node) => node.textContent ?? '')
  }

  /** The right click that opens the terminal menu, on the surface the attachment listens on. */
  static rightClickTerminal(container: HTMLElement, sessionId: string): void {
    const surface = container
      .querySelector(`[aria-label="Terminal for session ${sessionId}"] .jamat-terminal__screen`)
    if (!(surface instanceof HTMLElement))
      throw new Error(`The shell draws no terminal surface for ${sessionId}`)
    fireEvent.contextMenu(surface)
  }

  /** The menu is a portal on the body, so it is looked for there and not in the render container. */
  static menuItem(label: string): HTMLElement {
    const found = [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((node) => node.textContent === label)
    if (!(found instanceof HTMLElement))
      throw new Error(`The terminal menu draws no item labelled ${JSON.stringify(label)}`)
    return found
  }

  static installPalette(): void {
    AppShellTest.paletteTokensConst.forEach((token, index) =>
      document.documentElement.style.setProperty(
        `--window-color-${token}`,
        AppShellTest.color(index + 1),
      ))
  }

  static clearPalette(): void {
    for (const token of AppShellTest.paletteTokensConst)
      document.documentElement.style.removeProperty(`--window-color-${token}`)
    document.documentElement.style.removeProperty('--window-color')
    document.title = ''
  }
}
