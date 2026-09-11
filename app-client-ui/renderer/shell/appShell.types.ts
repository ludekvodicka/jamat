import type { CommitOpenStore } from '../versioning/commitOpenStore'
import type {
  RateMonitorSnapshot,
} from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type {
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteConnectionsSnapshot,
} from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  RemoteControlResponse,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import type { TerminalTarget } from '../../shared/terminalTarget'
import type { SnapshotStore, SnapshotStorePorts } from '../ipc/snapshotStore'
import type { SessionsMarksStore } from '../sessions/sessionsMarksStore'
import type { HostStatusPorts } from '../statusBar/hostStatusItem'
import type { RateStatusPorts } from '../statusBar/rateStatusItem'
import type { SessionModelStore } from '../sessionModel/sessionModelStore'
import type { SessionsTreePorts } from '../views/sessionsTree/sessionsTreeView'
import type { SidebarRegistry } from '../widgets/sidebar/sidebarRegistry'
import type { SidebarSide } from '../../shared/sidebarsState'
import type { SidebarsPorts } from '../widgets/sidebar/useSidebars'
import type { PanelRegistry } from '../widgets/tabs/panelRegistry'
import type { TabSessionFacts } from '../widgets/tabs/tabContextMenu'
import type { TabDecorationsStore } from '../widgets/tabs/tabDecorations'
import type { TabsController } from '../widgets/tabs/tabsController'
import type { CommandRegistry } from '../commands/commandRegistry'
import type { SessionCompact } from '../contextCompaction/sessionCompact'
import type { AgentSettingsStore } from '../contextCompaction/agentSettingsStore'
import type { ContextCompactionController } from '../contextCompaction/contextCompactionController'
import type { WorktreeSetupIntentStore } from '../overlays/configuration/worktreeSetupIntentStore'
import type { FinalizeAsk } from '../overlays/finalize/finalizeModel'
import type { LauncherIntentStore } from '../overlays/launcher/launcherIntentStore'
import type { ConfigurationTabId } from '../overlays/configuration/configurationTab.types'
import type { ActiveTerminalStore } from './activeTerminalStore'
import type { PanelFocusRegistry } from './panelFocusRegistry'
import type { SessionRefreshRegistry } from './sessionRefreshRegistry'
import type { SessionRestartChain } from './sessionRestartChain'
import type { TerminalInputRegistry } from './terminalInputRegistry'

export type AppShellSessionPorts =
  SessionsTreePorts & HostStatusPorts & SnapshotStorePorts<SessionsSnapshot>

export type AppShellRatePorts = RateStatusPorts & SnapshotStorePorts<RateMonitorSnapshot>

export interface AppShellRemotePorts extends SnapshotStorePorts<RemoteConnectionsSnapshot> {
  disconnect(remoteEndpointId: string, sessionIds?: readonly string[]): Promise<IpcResult<void>>
  reopen(remoteEndpointId: string, sessionId: string): Promise<IpcResult<RemoteControlResponse>>
  finalize(remoteEndpointId: string, sessionId: string): Promise<IpcResult<RemoteControlResponse>>
}

export type PanelOpenOutcome =
  | { kind: 'opened'; panelId: string }
  | { kind: 'focusedExisting'; panelId: string; windowId: string }
  | { kind: 'failed'; detail: string }

/**
 * What a component sees of a command target the shell registered before it rendered: it binds what
 * the command should run, and the shell's own composition is the only thing that opens one.
 */
export interface LateBoundCommandPort<T> {
  bind(target: (argument: T) => void): void
  open(argument: T): void
}

/** What the bar's Host item is drawn from; the bar's own file reads it too. */
export interface AppShellHostStatus {
  ports: AppShellSessionPorts
  snapshot: SnapshotStore<SessionsSnapshot>
}

export interface WorkspaceShellWiring {
  panels: PanelRegistry
  controller: TabsController
  commands: CommandRegistry
  decorations: TabDecorationsStore
  refresh: SessionRefreshRegistry
  /**
   * Where this document's terminal panels offer the way into their sessions, and where synthetic
   * commands find it. Per document rather than per application, because the tab they are about
   * is the one THIS window has in front and the panel holding that attach is in this document too.
   */
  terminalInputs: TerminalInputRegistry
  /**
   * And where they offer the caret. Per document for the same reason: the tab or the row that was
   * clicked is in this window, and so is the panel whose terminal the click is asking for.
   */
  panelFocus: PanelFocusRegistry
  contextCompact: SessionCompact
  agentSettings: AgentSettingsStore
  contextCompaction: ContextCompactionController
  /**
   * Every workspace reads the sessions document, holder windows included: a terminal tab draws its
   * session's work state, and a tab dragged into a second window is the same tab.
   */
  sessionPorts: AppShellSessionPorts
  sessionsSnapshot: SnapshotStore<SessionsSnapshot>
  remotePorts: AppShellRemotePorts
  remoteSnapshot: SnapshotStore<RemoteConnectionsSnapshot>
  /**
   * What each session is marked as, per WINDOW: "have I seen this" is a question about one
   * screen. Holders get one too, because a holder draws session tabs and a tab now carries the
   * same mark a tree row does.
   */
  commitOpen: CommitOpenStore
  sessionsMarks: SessionsMarksStore
  /**
   * Every workspace draws the rate limits too: what is spent is the machine's, not this window's,
   * so a holder that only holds a tab still says how much is left.
   */
  ratePorts: AppShellRatePorts
  rateSnapshot: SnapshotStore<RateMonitorSnapshot>
  /**
   * Which source-aware terminal target this document has in front, written by the wrap around the
   * active-panel port. Per document rather than per application: the cross-window answer clears
   * attention marks, while the bar and the main window's tree follow their own active panel.
   */
  activeTerminal: ActiveTerminalStore
  /**
   * The poll behind the model widget, one per document for the same reason: what it reads is the
   * session of the tab THIS window has in front, and it stands still while that is nothing.
   */
  sessionModel: SessionModelStore
  launcherCommands: LateBoundCommandPort<void>
  settingsCommands: LateBoundCommandPort<ConfigurationTabId | null>
  detailsCommands: LateBoundCommandPort<string>
  finalizeCommands: LateBoundCommandPort<FinalizeAsk>
  remarkableCommands: LateBoundCommandPort<void>
  intents: LauncherIntentStore
  worktreeSetupIntents: WorktreeSetupIntentStore
  openTerminal(
    target: TerminalTarget,
    title: string,
    options?: { plain?: true; preview?: true },
  ): Promise<PanelOpenOutcome>
  /**
   * What a tab's menu is drawn from, read when that menu opens. It is a function rather than the
   * store itself because a tab asks about ONE session, and the menu that asks lives for a moment.
   */
  sessionFacts(sessionId: string): TabSessionFacts | null
}

export interface MainShellWiring extends WorkspaceShellWiring {
  role: 'main'
  sidebarViews: SidebarRegistry
  sidebarPorts: SidebarsPorts
  restartChain: SessionRestartChain
  sidebarCommands: LateBoundCommandPort<SidebarSide>
}

export interface HolderShellWiring extends WorkspaceShellWiring {
  role: 'holder'
}

export type AppShellWiring = MainShellWiring | HolderShellWiring
