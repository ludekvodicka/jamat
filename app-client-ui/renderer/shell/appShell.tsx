import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import type {
  RateMonitorSnapshot,
} from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type {
  RemoteConnectionsSnapshot,
} from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppInfo } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import {
  AppCommands,
  type CommandId,
  type LauncherKeyPreference,
  type NewSessionPlace,
} from '../../shared/commands'
import type { SidebarSide, SidebarsStateValue } from '../../shared/sidebarsState'
import { type TerminalTarget, TerminalTargetCodec } from '../../shared/terminalTarget'
import { PanelKeysConst } from '../../shared/tabTransfer'
import type { WindowInfo, WindowRole } from '../../shared/windowInfo'
import { CommandRegistry } from '../commands/commandRegistry'
import { ShellChord } from './shellChord'
import { AgentSettingsStore } from '../contextCompaction/agentSettingsStore'
import { ContextCompactionController } from '../contextCompaction/contextCompactionController'
import { SessionCompact } from '../contextCompaction/sessionCompact'
import { PanelFileToolsRegistry } from '../fileViewer/panelFileToolsRegistry'
import { SnapshotStore } from '../ipc/snapshotStore'
import { KeyboardSettingsStore } from '../keyboardSettings/keyboardSettingsStore'
import { ConfigurationOverlay } from '../overlays/configuration/configurationOverlay'
import type {
  ConfigurationOpenRequest,
  ConfigurationTabId,
} from '../overlays/configuration/configurationTab.types'
import { WorktreeSetupIntentStore } from '../overlays/configuration/worktreeSetupIntentStore'
import type { FinalizeAsk, FinalizeOpenRequest } from '../overlays/finalize/finalizeModel'
import { FinalizeOverlay } from '../overlays/finalize/finalizeOverlay'
import {
  type LauncherIntent,
  LauncherIntentStore,
} from '../overlays/launcher/launcherIntentStore'
import { LauncherOverlay } from '../overlays/launcher/launcherOverlay'
import { RemarkableOverlay } from '../overlays/remarkable/remarkableOverlay'
import type { SessionDetailsOpenRequest } from '../overlays/sessionDetails/sessionDetailsModel'
import { SessionDetailsOverlay } from '../overlays/sessionDetails/sessionDetailsOverlay'
import { ProbePanel } from '../panels/probePanel'
import { TerminalPanel } from '../panels/terminal/terminalPanel'
import { WelcomePanel } from '../panels/welcomePanel'
import { SessionOperations } from './sessionOperations'
import { WorkspacePanels } from './workspacePanels'
import { TabClosePolicy } from './tabClosePolicy'
import { WorkspaceChannels } from './workspaceChannels'
import { SessionsMarksStore } from '../sessions/sessionsMarksStore'
import { useSessionModel } from '../statusBar/sessionModelItem'
import { type SessionModelPorts, SessionModelStore } from '../sessionModel/sessionModelStore'
import { AppShellItems } from '../statusBar/appShellItems'
import { StatusBar } from '../statusBar/statusBar'
import { ActiveAgentTerminals, useActiveAgentTerminal } from '../statusBar/useActiveAgentTerminal'
import { SessionsTreeView } from '../views/sessionsTree/sessionsTreeView'
import { SidebarProbeView } from '../views/sidebarProbeView'
import { ErrorBoundary } from '../widgets/errorBoundary'
import { AppShellSidebars } from '../widgets/sidebar/appShellSidebars'
import { SidebarRegistry } from '../widgets/sidebar/sidebarRegistry'
import { type SidebarsHandle, type SidebarsPorts, useSidebars } from '../widgets/sidebar/useSidebars'
import { PanelRegistry } from '../widgets/tabs/panelRegistry'
import { TabDecorationsStore } from '../widgets/tabs/tabDecorations'
import { TabDecorationsProvider } from '../widgets/tabs/tabDecorationsContext'
import { TabsController } from '../widgets/tabs/tabsController'
import { TabsHost } from '../widgets/tabs/tabsHost'
import { ActiveTerminalStore } from './activeTerminalStore'
import type {
  AppShellHostStatus,
  AppShellRatePorts,
  AppShellRemotePorts,
  AppShellSessionPorts,
  HolderShellWiring,
  MainShellWiring,
  LateBoundCommandPort,
  WorkspaceShellWiring,
} from './appShell.types'
import { LateBoundCommand } from './lateBoundCommand'
import { PanelFocusRegistry } from './panelFocusRegistry'
import { SessionRefreshRegistry } from './sessionRefreshRegistry'
import type { OpenTerminalPort } from './sessionTabOpener'
import { TerminalDraftRegistry } from './terminalDraftRegistry'
import { TerminalInputRegistry } from './terminalInputRegistry'
import { SessionRestartChain } from './sessionRestartChain'
import { WindowInfoStore } from './windowInfoStore'

interface WorkspaceShellProps {
  wiring: WorkspaceShellWiring
  sidebars: { registry: SidebarRegistry; handle: SidebarsHandle } | null
  hostStatus: AppShellHostStatus | null
}

interface RemarkableOpenRequest {
  requestId: number
  target: { panelId: string; sessionId: string }
}

export function MainShell(): React.JSX.Element {
  const [wiring] = useState<MainShellWiring>(() => AppShellComposition.wire('main'))
  const sidebars = useSidebars(wiring.sidebarViews, wiring.sidebarPorts)

  useEffect(() => wiring.sidebarCommands.bind((side) => sidebars.toggle(side)),
    [wiring, sidebars])
  useEffect(() => wiring.restartChain.start(), [wiring])

  return (
    <WorkspaceShell
      wiring={wiring}
      sidebars={{ registry: wiring.sidebarViews, handle: sidebars }}
      hostStatus={{ ports: wiring.sessionPorts, snapshot: wiring.sessionsSnapshot }}
    />
  )
}

export function HolderShell(): React.JSX.Element {
  const [wiring] = useState<HolderShellWiring>(() => AppShellComposition.wire('holder'))
  return <WorkspaceShell wiring={wiring} sidebars={null} hostStatus={null} />
}

/** The composition shared by both renderer roles, without any main-only readers or sidebars. */
function WorkspaceShell(props: WorkspaceShellProps): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [windowInfo, setWindowInfo] = useState<WindowInfo | null>(() => WindowInfoStore.snapshot())
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [settingsRequest, setSettingsRequest] = useState<ConfigurationOpenRequest | null>(null)
  const [detailsRequest, setDetailsRequest] = useState<SessionDetailsOpenRequest | null>(null)
  const [finalizeRequest, setFinalizeRequest] = useState<FinalizeOpenRequest | null>(null)
  const [remarkableRequest, setRemarkableRequest] = useState<RemarkableOpenRequest | null>(null)
  const overlayOpen = useRef(false)
  const { wiring } = props
  // What both terminal widgets are about: the session of the tab in front, and whose agent it is.
  const focus = useActiveAgentTerminal(wiring.activeTerminal, wiring.sessionsSnapshot)
  const sessionModel = useSessionModel(wiring.sessionModel, focus)

  // Started here rather than in the main shell: a holder window draws session tabs too, and each
  // document has one reader of its own.
  useEffect(() => wiring.sessionsSnapshot.start(), [wiring])
  useEffect(() => wiring.remoteSnapshot.start(), [wiring])
  // The marks ride on that reader, in every workspace: a holder draws session tabs, and a tab now
  // carries the same mark a tree row does. The one reading of what is on screen lives here rather
  // than in the tree, because a window with no sidebar still has to put a mark out when its tab is
  // looked at.
  useEffect(() => wiring.sessionsMarks.start(), [wiring])
  useEffect(() => window.appClient.onTabsVisibleTerminalTargets(
    (targetKeys) => wiring.sessionsMarks.setActiveTargets(new Set(targetKeys)),
  ), [wiring])
  // Beside it for the same reason: the bar of every workspace draws the rate limits, and one
  // document has one reader of them.
  useEffect(() => wiring.rateSnapshot.start(), [wiring])
  // The model poll is armed once per document and re-keyed whenever the tab in front changes; with
  // nothing in front it holds its timer down, so a window looking at a file asks nobody anything.
  useEffect(() => wiring.sessionModel.start(), [wiring])
  useEffect(() => wiring.agentSettings.start(), [wiring])
  useEffect(() => wiring.contextCompaction.start(), [wiring])
  useEffect(() => wiring.sessionModel.setFocus(focus), [wiring, focus])
  // And it stands still while the whole window is out of sight, which is a different question from
  // "no agent terminal in front" and was the one this poll did not ask: the sessions poll and the
  // rate monitor both take it from the main process, and a holder minimised for the afternoon kept
  // asking every twenty seconds. Read from the document rather than over IPC, because what matters
  // here is whether THIS window is on screen.
  useEffect(() => {
    const report = (): void =>
      wiring.sessionModel.setWindowVisible(document.visibilityState === 'visible')
    report()
    document.addEventListener('visibilitychange', report)
    return () => document.removeEventListener('visibilitychange', report)
  }, [wiring])
  // The retitle half of a rename. A tab is named when it opens; this is what keeps an OPEN tab in
  // step with the record afterwards. It runs in every workspace window - a holder draws session
  // tabs too - and the controller writes only differences, so the windows converge on one snapshot
  // instead of re-saving layouts for names that already match.
  useEffect(() => wiring.sessionsSnapshot.subscribe(() => {
    const sessions = wiring.sessionsSnapshot.current().snapshot?.sessions
    if (sessions !== undefined)
      wiring.controller.applySessionTitles(sessions)
  }), [wiring])
  useEffect(() => wiring.remoteSnapshot.subscribe(() => {
    const endpoints = wiring.remoteSnapshot.current().snapshot?.outbound
    if (endpoints !== undefined)
      wiring.controller.applyRemoteSessionTitles(endpoints.map((endpoint) => ({
        remoteEndpointId: endpoint.remoteEndpointId,
        titles: endpoint.sessions?.sessions ?? [],
      })))
  }), [wiring])
  /*
   * "Never two overlays at once" used to hold by construction: every way in was a context menu,
   * and a menu cannot be opened while a card covers the window. That is no longer true of ANY of
   * them: the three launcher cards carry Ctrl+T, Ctrl+Shift+T and Ctrl+N, `settings.open` carries
   * Ctrl+, and the details card carries F2 - five registered accelerators, each firing wherever the
   * focus happens to be. The guard used to sit on F2 alone, on the stated ground that the others
   * had no key; they do, so a launcher key over a half-typed rename drew a second card on top of it
   * and gave Escape and Enter two owners.
   *
   * A ref rather than the state: each callback is bound once, so reading state inside it would
   * read the values of the render that bound it, for ever. The claim writes the ref itself rather
   * than waiting for the effect below, because two accelerators can land in one task and the
   * effect only runs after the commit - both would then be answered against the same stale value.
   */
  const claimOverlay = useCallback((): boolean => {
    if (overlayOpen.current)
      return false
    overlayOpen.current = true
    return true
  }, [])
  /**
   * One overlay handing the claim straight to the next. The effect below only re-reads the claim
   * after a commit, so a card that closes itself and opens another in the same task would be
   * refused by its own claim - which is what happened to the launcher's way into the settings.
   */
  const releaseOverlay = useCallback((): void => { overlayOpen.current = false }, [])
  useEffect(() => {
    overlayOpen.current = launcherOpen
      || settingsRequest !== null
      || detailsRequest !== null
      || finalizeRequest !== null
      || remarkableRequest !== null
  }, [launcherOpen, settingsRequest, detailsRequest, finalizeRequest, remarkableRequest])
  useEffect(() => wiring.launcherCommands.bind(() => {
    if (claimOverlay())
      setLauncherOpen(true)
  }), [wiring, claimOverlay])
  useEffect(() => wiring.settingsCommands.bind((tab) => {
    if (claimOverlay())
      setSettingsRequest((current) => ({ requestId: (current?.requestId ?? 0) + 1, tab }))
  }), [wiring, claimOverlay])
  useEffect(() => wiring.detailsCommands.bind((sessionId) => {
    if (claimOverlay())
      setDetailsRequest((current) => ({ requestId: (current?.requestId ?? 0) + 1, sessionId }))
  }), [wiring, claimOverlay])
  useEffect(() => wiring.finalizeCommands.bind((ask) => {
    if (claimOverlay())
      setFinalizeRequest((current) => ({ requestId: (current?.requestId ?? 0) + 1, ask }))
  }), [wiring, claimOverlay])
  useEffect(() => wiring.remarkableCommands.bind(() => {
    const target = wiring.activeTerminal.current()
    const agent = ActiveAgentTerminals.of(target, wiring.sessionsSnapshot.current().snapshot)
    const local = target !== null && TerminalTargetCodec.endpointOf(target.target) === null
      ? target
      : null
    if (local === null || agent?.life !== 'live'
      || !wiring.terminalInputs.has(local.target.sessionId)) {
      AppClientUiReport.error('Select a writable local Claude or Codex terminal first')
      return
    }
    if (claimOverlay())
      setRemarkableRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        target: { panelId: local.panelId, sessionId: local.target.sessionId },
      }))
  }), [wiring, claimOverlay])
  useEffect(() => WindowInfoStore.subscribe(() => setWindowInfo(WindowInfoStore.current())), [])

  useEffect(() => {
    let disposed = false
    void window.appClient.appInfo().then((result) => {
      if (disposed)
        return
      if (result.ok)
        setAppInfo(result.value)
      else
        AppClientUiReport.error(`app info unavailable: ${result.error}`)
    })
    return () => {
      disposed = true
    }
  }, [])

  // The one way a menu click or an accelerator reaches the workspace. There is no second keydown
  // listener for the same action: V1 had one, and every command it covered ran twice.
  useEffect(() => window.appClient.onMenuCommand((commandId) => {
    wiring.commands.execute(commandId)
  }), [wiring])

  // The one exception to the line above, and it covers no action the menu delivers: `Alt+T` and a
  // direction is a CHORD, which Electron cannot register, so those four commands have no
  // accelerator for this listener to fire a second time.
  useEffect(() => new ShellChord((commandId) => wiring.commands.execute(commandId)).start(),
    [wiring])

  // What the main process could not do with the state file. The console of a packaged main process
  // is nowhere the user can look; this one is in the window they have open.
  useEffect(() => window.appClient.onAppError((message) => {
    AppClientUiReport.error(`${message}`)
  }), [])

  useEffect(() => window.appClient.onTabsActivatePanel((panelId, params, title) => {
    wiring.controller.activatePanel(panelId, params, title)
  }), [wiring])
  useEffect(() => window.appClient.onTabsControlCommand((command) => {
    void WorkspacePanels.runTabControlCommand(wiring.controller, command)
      .catch((error: unknown) => WorkspacePanels.reportTabsError(error))
  }), [wiring])
  useEffect(() => window.appClient.onTabsClosePanel((panelId) => {
    void wiring.controller.hidePanel(panelId, { silent: true })
      .catch((error: unknown) => WorkspacePanels.reportTabsError(error))
  }), [wiring])
  useEffect(() => window.appClient.onTabsTerminalRestarted((targetKey) => {
    wiring.refresh.restarted(targetKey)
  }), [wiring])
  useEffect(() => window.appClient.onTabsTransferIn((token) => {
    void wiring.controller.receiveTransfer(token, { kind: 'empty' })
      .catch((error: unknown) => WorkspacePanels.reportTabsError(error))
  }), [wiring])
  useEffect(() => window.appClient.onTabsTransferOut((panelId) => {
    void WorkspacePanels.finishTransferOut(wiring.controller, panelId)
      .catch((error: unknown) => WorkspacePanels.reportTabsError(error))
  }), [wiring])

  // The debounce is 350 ms, so without this flush the last change before the window closes is lost.
  useEffect(() => {
    const flush = (): void => {
      wiring.controller.dispose()
      props.sidebars?.handle.flush()
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [wiring, props.sidebars])

  return (
    <div className="jamat-shell">
      <div className="jamat-shell__body">
        {props.sidebars === null
          ? null
          : AppShellSidebars.render('left', props.sidebars.registry, props.sidebars.handle)}
        <div className="jamat-shell__workspace">
          {/* Around the whole surface, so a tab and the content inside it share one store. */}
          <TabDecorationsProvider store={wiring.decorations}>
            <TabsHost
              registry={wiring.panels}
              controller={wiring.controller}
              commands={wiring.commands}
              sessionFacts={wiring.sessionFacts}
              panelFocus={wiring.panelFocus}
              onReady={() => void WorkspacePanels.restore(
                wiring.controller,
                wiring.sessionsSnapshot,
                wiring.remoteSnapshot,
              )}
            />
          </TabDecorationsProvider>
        </div>
        {props.sidebars === null
          ? null
          : AppShellSidebars.render('right', props.sidebars.registry, props.sidebars.handle)}
      </div>
      <StatusBar
        left={AppShellItems.left(appInfo, props.hostStatus)}
        right={AppShellItems.right(appInfo, windowInfo, focus, {
          sessionModel,
          compact: wiring.contextCompact,
          rate: { ports: wiring.ratePorts, store: wiring.rateSnapshot },
        })}
      />
      {launcherOpen && (
        <LauncherOverlay
          intents={wiring.intents}
          onOpenTerminal={(target, title, options) =>
            wiring.openTerminal(target, title, options)}
          // The card is replaced rather than covered: the claim it holds is handed straight on.
          onOpenRemoteSettings={() => {
            setLauncherOpen(false)
            releaseOverlay()
            wiring.settingsCommands.open('remoteControlConnections')
          }}
          onClose={() => setLauncherOpen(false)}
        />
      )}
      {settingsRequest !== null && (
        <ConfigurationOverlay
          request={settingsRequest}
          worktreeSetupIntents={wiring.worktreeSetupIntents}
          onClose={() => setSettingsRequest(null)}
        />
      )}
      {detailsRequest !== null && (
        <SessionDetailsOverlay
          // Keyed so a fresh request is a fresh card: the baseline is captured at mount.
          key={detailsRequest.requestId}
          request={detailsRequest}
          snapshot={wiring.sessionsSnapshot}
          inputs={wiring.terminalInputs}
          onClose={() => setDetailsRequest(null)}
        />
      )}
      {finalizeRequest !== null && (
        <FinalizeOverlay
          key={finalizeRequest.requestId}
          request={finalizeRequest}
          onClose={() => setFinalizeRequest(null)}
        />
      )}
      {remarkableRequest !== null && (
        <RemarkableOverlay
          key={remarkableRequest.requestId}
          sessionId={remarkableRequest.target.sessionId}
          onInsert={(outputPath) =>
            wiring.terminalInputs.insert(remarkableRequest.target.sessionId, outputPath)}
          onClose={() => setRemarkableRequest(null)}
        />
      )}
    </div>
  )
}

/**
 * The sidebar's own launcher button. It is a component rather than the element the wiring used to
 * build once, for one reason: the key it names can be swapped in the settings of another window,
 * and a title built at wiring time would go on naming the key it was born with.
 */
function NewSessionAction(props: { onClick: () => void }): React.JSX.Element {
  const launcherKeys = useSyncExternalStore(
    KeyboardSettingsStore.subscribe,
    KeyboardSettingsStore.current,
    KeyboardSettingsStore.current,
  )
  return (
    <button
      className="jamat-sidebar__action"
      type="button"
      title={AppShellComposition.hintOf('session.new', launcherKeys)}
      onClick={props.onClick}
    >
      New session
    </button>
  )
}

class AppShellComposition {
  /** What V1 typed and what both CLIs read as their own slash command; the Enter is the registry's. */
  private static readonly fileViewerPanelConst = lazy(async () => ({
    default: (await import('../fileViewer/fileViewerPanel')).FileViewerPanel,
  }))
  private static readonly directoryViewerPanelConst = lazy(async () => ({
    default: (await import('../fileViewer/directoryViewerPanel')).DirectoryViewerPanel,
  }))
  /** What the tab shows; a plain count is what a person reads back in a screenshot. */

  static wire(role: 'main'): MainShellWiring
  static wire(role: 'holder'): HolderShellWiring
  static wire(role: WindowRole): MainShellWiring | HolderShellWiring {
    if (role === 'main') {
      const sidebarCommands = new LateBoundCommand<SidebarSide>('sidebar')
      const common = AppShellComposition.workspaceWiring(role, sidebarCommands)
      const { sessionPorts, sessionsSnapshot, sessionsMarks } = common
      const restartChain = new SessionRestartChain({
        read: async () => {
          const snapshot = sessionsSnapshot.current().snapshot
          return snapshot === null
            ? { ok: false, error: 'The sessions snapshot has not arrived' }
            : { ok: true, value: snapshot }
        },
        subscribe: (onChanged) => sessionsSnapshot.subscribe(onChanged),
        reopen: (sessionId) => sessionPorts.reopen(sessionId),
        reportError: (message) => sessionPorts.reportError(message),
        openSessionIds: () => WorkspaceChannels.openSessionIds(),
        publishSessionRestarted: (sessionId) =>
          WorkspaceChannels.publishTerminalRestarted(sessionId),
      })
      const sidebars = new SidebarRegistry()
      sidebars.register({
        key: 'sessionsTree',
        side: 'left',
        title: 'Sessions',
        component: (props) => {
          return (
            <SessionsTreeView
              {...props}
              ports={sessionPorts}
              snapshotStore={sessionsSnapshot}
              remotePorts={common.remotePorts}
              remoteSnapshotStore={common.remoteSnapshot}
              commands={common.commands}
              // The same accessor the tabs host reads: the row's menu and the tab's menu are drawn
              // from one answer about what a session is.
              sessionFacts={common.sessionFacts}
              marks={sessionsMarks}
              activeTerminal={common.activeTerminal}
              onLaunch={(intent) =>
                AppShellComposition.launch(common.intents, common.launcherCommands, intent)}
              // The row of a paired computer opens the card on the screen that answers what the row
              // cannot: offline and switched-off computers are drawn there and nowhere else.
              onOpenSettings={(tab) => common.settingsCommands.open(tab)}
              onOpenTerminal={(target, title, intent) =>
                void common.openTerminal(target, title, WorkspacePanels.openOptionsOf(intent))
                  .then((outcome) => WorkspacePanels.reportPanelOpen(outcome))}
              // The tree never keeps the caret: what it puts in front is what gets typed into.
              onFocusTerminal={() =>
                common.panelFocus.focus(common.controller.activePanelId())}
              onCloseTerminal={(target) => AppShellComposition.closeTerminal(target)}
              onRerunTerminal={(target) => AppShellComposition.rerunTerminal(target)}
              onFinalizeAsk={(ask) => common.finalizeCommands.open(ask)}
            />
          )
        },
        headerAction: (
          <NewSessionAction
            onClick={() =>
              AppShellComposition.launch(common.intents, common.launcherCommands, {})}
          />
        ),
      })
      sidebars.register({
        key: 'probeRight',
        side: 'right',
        title: 'Right Probe',
        component: SidebarProbeView,
      })
      return {
        ...common,
        role,
        sidebarViews: sidebars,
        sidebarPorts: AppShellComposition.sidebarPorts(),
        restartChain,
        sidebarCommands,
      }
    } else if (role === 'holder')
      return { ...AppShellComposition.workspaceWiring(role, null), role }
    else
      throw new Error(`Unknown workspace role: ${JSON.stringify(role)}`)
  }

  private static workspaceWiring(
    role: WindowRole,
    sidebarCommands: LateBoundCommand<SidebarSide> | null,
  ): WorkspaceShellWiring {
    const panels = new PanelRegistry()
    const fileTools = new PanelFileToolsRegistry()
    const panelFocus = new PanelFocusRegistry()
    const sessionPorts = AppShellComposition.sessionPorts()
    const sessionsSnapshot = new SnapshotStore<SessionsSnapshot>(
      'The sessions snapshot',
      sessionPorts,
    )
    const remotePorts = AppShellComposition.remotePorts()
    const remoteSnapshot = new SnapshotStore<RemoteConnectionsSnapshot>(
      'The remote connections snapshot',
      remotePorts,
    )
    const sessionsMarks = new SessionsMarksStore(sessionsSnapshot, remoteSnapshot)
    const ratePorts = AppShellComposition.ratePorts()
    const rateSnapshot = new SnapshotStore<RateMonitorSnapshot>('The rate limits', ratePorts)
    const activeTerminal = new ActiveTerminalStore()
    const sessionModel = new SessionModelStore(AppShellComposition.sessionModelPorts())
    const agentSettings = new AgentSettingsStore({
      read: () => window.appClient.agents.getSettings(),
      subscribe: (onChanged) => window.appClient.onAgentSettingsChanged(onChanged),
      setAutoCompact: (agentId, enabled) =>
        window.appClient.agents.setAutoCompact(agentId, enabled),
      reportError: (message) => AppClientUiReport.error(message),
    })
    let controller: TabsController
    panels.register({ key: PanelKeysConst.welcome, title: 'Home', component: WelcomePanel })
    panels.register({
      key: PanelKeysConst.probe,
      title: WorkspacePanels.probeTitleConst,
      component: ProbePanel,
    })
    const refresh = new SessionRefreshRegistry()
    const terminalInputs = new TerminalInputRegistry()
    const terminalDrafts = new TerminalDraftRegistry()
    const contextCompact = new SessionCompact(terminalInputs, {
      claimAutomatic: (sessionId) => window.appClient.contextCompaction.claimAutomatic(sessionId),
      noteManual: (sessionId) => window.appClient.contextCompaction.noteManual(sessionId),
      cooldown: (sessionId) => window.appClient.contextCompaction.cooldown(sessionId),
      reportError: (message) => AppClientUiReport.error(message),
    })
    const contextCompaction = new ContextCompactionController(
      sessionsSnapshot,
      sessionModel,
      agentSettings,
      contextCompact,
      terminalDrafts,
      (message) => AppClientUiReport.error(message),
    )
    panels.register({
      key: PanelKeysConst.terminal,
      title: 'Terminal',
      // Wrapped, because the panel throws during render by house rule and React unmounts the whole
      // root when a render throws: a params shape one tab cannot read used to take every other tab
      // in the window with it, and the layout that produced it is deliberately kept, so the next
      // start drew the same blank window with no UI left to clear it from.
      component: (props) => (
        <ErrorBoundary what="The terminal">
          <TerminalPanel
            {...props}
            refresh={refresh}
            inputs={terminalInputs}
            drafts={terminalDrafts}
            panelFocus={panelFocus}
            sessions={sessionsSnapshot}
            remoteSessions={remoteSnapshot}
            sessionModel={sessionModel}
            settings={agentSettings}
            compact={contextCompact}
            compaction={contextCompaction}
            marks={sessionsMarks}
            fileTools={fileTools}
            openFile={(source, documentKey, hint, location) =>
              WorkspacePanels.openFileViewer(controller, source, documentKey, hint, location)}
            openDirectoryAt={(sessionId, path, directoryKey) =>
              WorkspacePanels.openDirectoryAt(controller, sessionId, path, directoryKey)}
          />
        </ErrorBoundary>
      ),
    })
    panels.register({
      key: PanelKeysConst.fileViewer,
      title: 'File',
      // Wrapped for the reason the terminal beside it is: the panel throws during render on a params
      // shape it cannot read, React unmounts the whole root when a render throws, and the layout
      // that produced it is deliberately kept - so the next start drew the same blank window with no
      // UI left to clear it from. `Suspense` does not catch a throw.
      component: (props) => (
        <ErrorBoundary what="The file viewer">
          <Suspense fallback={<p>Opening file...</p>}>
            <AppShellComposition.fileViewerPanelConst {...props} fileTools={fileTools} />
          </Suspense>
        </ErrorBoundary>
      ),
    })
    panels.register({
      key: PanelKeysConst.directoryViewer,
      title: 'Project Folder',
      component: (props) => (
        <ErrorBoundary what="The project folder">
          <Suspense fallback={<p>Opening project folder...</p>}>
            <AppShellComposition.directoryViewerPanelConst
              {...props}
              openFile={(source, documentKey) => {
                void WorkspacePanels.openFileViewer(controller, source, documentKey)
              }}
            />
          </Suspense>
        </ErrorBoundary>
      ),
    })
    const openTerminal: OpenTerminalPort = (sessionId, title, options) =>
      WorkspacePanels.openTerminal(controller, { kind: 'local', sessionId }, title, options)
    const launcherCommands = new LateBoundCommand('launcher')
    const settingsCommands = new LateBoundCommand<ConfigurationTabId | null>('settings')
    const detailsCommands = new LateBoundCommand<string>('session details')
    const finalizeCommands = new LateBoundCommand<FinalizeAsk>('finalize')
    const remarkableCommands = new LateBoundCommand('reMarkable')
    const intents = new LauncherIntentStore()
    const worktreeSetupIntents = new WorktreeSetupIntentStore()
    controller = new TabsController({
      registry: panels,
      saveLayout: (layout) => WorkspaceChannels.saveLayout(layout),
      clearLayout: () => WorkspaceChannels.clearLayout(),
      claimPanel: (panel) => WorkspaceChannels.claimPanel(panel),
      reconcilePanels: (presence) => WorkspaceChannels.reconcilePanels(presence),
      releasePanel: (panelId) => WorkspaceChannels.releasePanel(panelId),
      // This document's own reading first, then the main process: local surfaces would draw the
      // previous tab during the round trip, and the cross-window answer cannot choose one window's
      // current row when another visible window has a different terminal in front.
      setActivePanel: (panelId) => {
        activeTerminal.set(WorkspacePanels.activeTerminalOf(panelId))
        return WorkspaceChannels.setActivePanel(panelId)
      },
      tabDragStarted: (token, panel) => WorkspaceChannels.tabDragStarted(token, panel),
      transferPrepare: (token) => WorkspaceChannels.transferPrepare(token),
      transferCommit: (token) => WorkspaceChannels.transferCommit(token),
      transferAbort: (token) => WorkspaceChannels.transferAbort(token),
      movePanel: (panel, target) => WorkspaceChannels.movePanel(panel, target),
      reportError: (message) => AppClientUiReport.error(`${message}`),
      onWillUserClose: (key, params) => TabClosePolicy.mayClose(key, params),
    })
    return {
      panels,
      controller,
      sessionPorts,
      sessionsSnapshot,
      remotePorts,
      remoteSnapshot,
      sessionsMarks,
      ratePorts,
      rateSnapshot,
      activeTerminal,
      sessionModel,
      agentSettings,
      decorations: new TabDecorationsStore(),
      commands: AppShellComposition.commandsOf(
        role,
        controller,
        sidebarCommands,
        launcherCommands,
        settingsCommands,
        detailsCommands,
        remarkableCommands,
        intents,
        worktreeSetupIntents,
        fileTools,
        { snapshot: sessionsSnapshot, openTerminal, compact: contextCompact },
      ),
      refresh,
      terminalInputs,
      panelFocus,
      contextCompact,
      contextCompaction,
      launcherCommands,
      settingsCommands,
      detailsCommands,
      finalizeCommands,
      remarkableCommands,
      intents,
      worktreeSetupIntents,
      openTerminal: (target, title, options) =>
        WorkspacePanels.openTerminal(controller, target, title, options),
      sessionFacts: (sessionId) =>
        SessionOperations.sessionFactsOf(sessionsSnapshot, sessionId),
    }
  }

  private static sessionPorts(): AppShellSessionPorts {
    return {
      read: () => window.appClient.sessions.snapshot(),
      subscribe: (onChanged) => window.appClient.onSessionsChanged(onChanged),
      reportError: (message) => AppClientUiReport.error(`${message}`),
      finalize: (sessionId) => window.appClient.sessions.finalize(sessionId),
      reopen: (sessionId) => window.appClient.sessions.reopen(sessionId),
      remove: (sessionId) => window.appClient.sessions.remove(sessionId),
      retrySetup: (sessionId, acknowledgeSetup) =>
        window.appClient.sessions.retrySetup(sessionId, acknowledgeSetup),
      adoptOrphan: (runtimeSessionId) => window.appClient.sessions.adoptOrphan(runtimeSessionId),
      startHost: () => window.appClient.sessions.startHost(),
      loadView: () => window.appClient.state.loadSessionsView(),
      saveView: (view) => window.appClient.state.saveSessionsView(view),
      loadFilters: () => window.appClient.state.loadSessionFilters(),
      saveFilters: (filters) => window.appClient.state.saveSessionFilters(filters),
    }
  }

  private static remotePorts(): AppShellRemotePorts {
    return {
      read: () => window.appClient.remote.snapshot(),
      subscribe: (onChanged) => window.appClient.onRemoteChanged(onChanged),
      reportError: (message) => AppClientUiReport.error(`${message}`),
      reopen: (remoteEndpointId, sessionId) =>
        window.appClient.remote.reopenSession(remoteEndpointId, sessionId),
      finalize: (remoteEndpointId, sessionId) =>
        window.appClient.remote.finalizeSession(remoteEndpointId, sessionId),
    }
  }

  private static closeTerminal(target: TerminalTarget): void {
    if (target.kind !== 'local' && target.kind !== 'remote')
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
    void WorkspaceChannels.closeTerminalPanel(TerminalTargetCodec.key(target))
      .catch((error: unknown) => WorkspacePanels.reportTabsError(error))
  }

  private static rerunTerminal(target: TerminalTarget): void {
    if (target.kind !== 'local' && target.kind !== 'remote')
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
    void WorkspaceChannels.publishTerminalRestarted(TerminalTargetCodec.key(target))
      .catch((error: unknown) => WorkspacePanels.reportTabsError(error))
  }

  private static ratePorts(): AppShellRatePorts {
    return {
      read: () => window.appClient.rateMonitor.get(),
      subscribe: (onChanged) => window.appClient.onRateChanged(onChanged),
      refresh: () => window.appClient.rateMonitor.refresh(),
      reportError: (message) => AppClientUiReport.error(`${message}`),
    }
  }

  /**
   * On demand, and only for the session this window is looking at. There is no snapshot and no
   * broadcast behind this: the main process knows which sessions exist, not which tab is in front of
   * which window, and a manager reading every live transcript on a clock would read for nobody.
   */
  private static sessionModelPorts(): SessionModelPorts {
    return {
      read: (sessionId) => window.appClient.sessionModel.get(sessionId),
      reportError: (message) => AppClientUiReport.error(`${message}`),
    }
  }

  /**
   * What a button says when the pointer rests on it: what it does, and the key that does it too.
   *
   * The key comes through the preference rather than off the descriptor, because the two launcher
   * commands can be swapped and a tooltip naming the key the menu no longer registers is worse than
   * no tooltip at all.
   */
  static hintOf(id: CommandId, launcherKeys: LauncherKeyPreference): string {
    const command = AppCommands.byId(id)
    const accelerator = AppCommands.acceleratorOf(command, launcherKeys)
    if (accelerator === undefined)
      return command.title
    return `${command.title} (${accelerator})`
  }

  /**
   * A place a row named, as the intent the launcher reads. A project gives it both screens' worth of
   * answer and it skips to the create form; a category gives it only where to stand.
   */
  private static intentOf(place: NewSessionPlace): LauncherIntent {
    if (place.kind === 'project') return { project: place.project }
    else if (place.kind === 'category') return { category: place.categoryId }
    else
      throw new Error(`Unknown new-session place: ${JSON.stringify(place)}`)
  }

  /** Every opening path is this one: write what was meant, then show the launcher. */
  private static launch(
    intents: LauncherIntentStore,
    launcherCommands: LateBoundCommandPort<void>,
    intent: LauncherIntent,
  ): void {
    intents.set(intent)
    launcherCommands.open()
  }

  private static sidebarPorts(): SidebarsPorts {
    return {
      load: async () => {
        const result = await window.appClient.state.loadSidebars()
        // A state we could not even ask for is a state we must not overwrite, same as a damaged one.
        if (!result.ok)
          return { sidebars: null, failed: true }
        return result.value
      },
      save: (state: SidebarsStateValue) => WorkspaceChannels.saveSidebars(state),
      reportError: (message) => AppClientUiReport.error(`${message}`),
    }
  }

  private static commandsOf(
    role: WindowRole,
    controller: TabsController,
    sidebarCommands: LateBoundCommand<SidebarSide> | null,
    launcherCommands: LateBoundCommand,
    settingsCommands: LateBoundCommand<ConfigurationTabId | null>,
    detailsCommands: LateBoundCommand<string>,
    remarkableCommands: LateBoundCommand,
    intents: LauncherIntentStore,
    worktreeSetupIntents: WorktreeSetupIntentStore,
    fileTools: PanelFileToolsRegistry,
    session: {
      snapshot: SnapshotStore<SessionsSnapshot>
      openTerminal: OpenTerminalPort
      compact: SessionCompact
    },
  ): CommandRegistry {
    const commands = new CommandRegistry()
    commands.register('session.new', () =>
      AppShellComposition.launch(intents, launcherCommands, {}))
    // The same launcher, opened knowing as much as the row that asked for it did.
    commands.register('session.newHere', (arg) =>
      AppShellComposition.launch(intents, launcherCommands,
        AppShellComposition.intentOf(arg.place)))
    commands.register('settings.open', () => settingsCommands.open(null))
    commands.register('window.settings', () => settingsCommands.open('window'))
    // The settings card opened knowing which project, the same way the launcher is.
    commands.register('project.worktreeSetup', (arg) => {
      worktreeSetupIntents.write({
        projectName: arg.project.projectName,
        projectPath: arg.project.projectPath,
      })
      settingsCommands.open('worktrees')
    })
    commands.register('tools.remarkable', () => remarkableCommands.open())
    if (role === 'main') {
      if (sidebarCommands === null)
        throw new Error('The main shell has no sidebar command target')
      commands.register('view.toggleLeftSidebar', () => sidebarCommands.open('left'))
      commands.register('view.toggleRightSidebar', () => sidebarCommands.open('right'))
    } else if (role === 'holder') {
      if (sidebarCommands !== null)
        throw new Error('A holder shell received a sidebar command target')
    } else
      throw new Error(`Unknown workspace role: ${JSON.stringify(role)}`)
    commands.register('tab.new', () =>
      AppShellComposition.launch(intents, launcherCommands, { purpose: 'tabProfile' }))
    // The same launcher again, asking which computer first. The tree's action on a connected one
    // writes the same intent with that answer already in it.
    commands.register('session.newRemote', () =>
      AppShellComposition.launch(intents, launcherCommands, { purpose: 'remote' }))
    commands.register('debug.newProbe', () => WorkspacePanels.openProbe(controller))
    commands.register('tab.promote', (arg) =>
      WorkspacePanels.started('tab.promote',
        WorkspacePanels.promoteTab(controller, arg?.sessionId ?? null)))
    // The menu named no panel: it made its tab active before opening, so the active one IS the one
    // the item was clicked on.
    commands.register('tab.keepOpen', () => {
      const active = controller.activePanelId()
      if (active !== null)
        controller.keepOpen(active)
    })
    commands.register('tab.openProjectFolder', (arg) =>
      WorkspacePanels.openProjectFolder(controller, arg?.sessionId ?? null))
    commands.register('tab.copyProjectFolder', (arg) =>
      WorkspacePanels.started('tab.copyProjectFolder',
        SessionOperations.copyProjectFolder(session.snapshot,
          WorkspacePanels.commandTargetOf(controller, arg))))
    // The one item a paired computer's row shares with a local one: the block is composed from the
    // snapshot that computer already sent, so the endpoint on the argument is all that separates the
    // two routes.
    commands.register('session.copyReference', (arg) =>
      WorkspacePanels.started('session.copyReference',
        SessionOperations.copySessionReference(
          WorkspacePanels.commandTargetOf(controller, arg),
          arg?.remoteEndpointId ?? null)))
    // The project row's pair. They name a path outright, where the two above read one off a session,
    // and the session they carry is only what the directory grant is proved against.
    commands.register('project.openFolder', (arg) =>
      WorkspacePanels.openDirectoryAt(controller, arg.sessionId, arg.path,
        WorkspacePanels.projectFolderKeyOf(arg.path)))
    commands.register('project.copyFolderPath', (arg) =>
      WorkspacePanels.started('project.copyFolderPath',
        SessionOperations.copyPath(arg.path)))
    // The card needs only the session's id: it captures everything else off the snapshot itself.
    // The tree names the clicked session; the tab menu names nothing, and made its tab active
    // before executing, so there the active terminal IS the clicked one.
    commands.register('session.details', (arg) => {
      const target = WorkspacePanels.commandTargetOf(controller, arg)
      if (target !== null) detailsCommands.open(target.sessionId)
    })
    commands.register('session.setColor', (arg) =>
      WorkspacePanels.started('session.setColor',
        SessionOperations.onSession(
          WorkspacePanels.commandTargetOf(controller, arg),
          (sessionId) => window.appClient.sessions.setColor(sessionId, arg.color))))
    // The same agent as the target session, which only the session itself can say.
    commands.register('session.newBlank', (arg) =>
      WorkspacePanels.started('session.newBlank',
        SessionOperations.createFrom(session,
          WorkspacePanels.commandTargetOf(controller, arg),
          (sessionId, info) => info.agent === undefined
            ? null
            : window.appClient.sessions.newBeside(sessionId, info.agent.agentId),
          { plain: true })))
    commands.register('session.newInClaude', (arg) =>
      WorkspacePanels.started('session.newInClaude',
        SessionOperations.createFrom(session,
          WorkspacePanels.commandTargetOf(controller, arg),
          (sessionId) => window.appClient.sessions.newBeside(sessionId, 'claude'),
          { plain: true })))
    commands.register('session.newInCodex', (arg) =>
      WorkspacePanels.started('session.newInCodex',
        SessionOperations.createFrom(session,
          WorkspacePanels.commandTargetOf(controller, arg),
          (sessionId) => window.appClient.sessions.newBeside(sessionId, 'codex'),
          { plain: true })))
    // A fork is a session of the tree, so its tab is not a plain one.
    commands.register('session.fork', (arg) =>
      WorkspacePanels.started('session.fork',
        SessionOperations.createFrom(session,
          WorkspacePanels.commandTargetOf(controller, arg),
          (sessionId) => window.appClient.sessions.fork(sessionId),
          { plain: false })))
    commands.register('session.restart', (arg) =>
      WorkspacePanels.started('session.restart',
        SessionOperations.restartSession(session.snapshot,
          WorkspacePanels.commandTargetOf(controller, arg))))
    // Straight to the session's terminal in this window, not through the library: typing a slash
    // command is keystrokes, and the registry beside this one is where the panel offered its attach.
    commands.register('session.compact', (arg) =>
      SessionOperations.compactSession(session.compact,
        WorkspacePanels.commandTargetOf(controller, arg)))
    commands.register('tab.close', () =>
      WorkspacePanels.started('tab.close', WorkspacePanels.closeActive(controller)))
    commands.register('tab.closeOthers', () => WorkspacePanels.closeOthers(controller))
    commands.register('tab.splitRight', () => controller.splitActivePanel('right'))
    commands.register('tab.splitDown', () => controller.splitActivePanel('below'))
    commands.register('tab.moveRight', () => controller.moveActivePanelInDirection('right'))
    commands.register('tab.moveLeft', () => controller.moveActivePanelInDirection('left'))
    commands.register('tab.moveUp', () => controller.moveActivePanelInDirection('above'))
    commands.register('tab.moveDown', () => controller.moveActivePanelInDirection('below'))
    commands.register('tab.moveToNewWindow', () => {
      void controller.moveActivePanel({ kind: 'newWindow' })
        .catch((error: unknown) => WorkspacePanels.reportTabsError(error))
    })
    commands.register('tab.resetLayout', () =>
      WorkspacePanels.started('tab.resetLayout', controller.resetLayout()))
    commands.register('view.maximizeToggle', () => controller.toggleMaximizeActiveGroup())
    commands.register('view.toggleTabSidebar', () => fileTools.toggle(controller.activePanelId()))
    commands.register('view.fileChanges', () => fileTools.openFileChanges(controller.activePanelId()))
    commands.register('view.fileBack', () => WorkspacePanels.backInSplit(controller))
    commands.assertCovers(AppCommands.rendererFor(role))
    return commands
  }
}
