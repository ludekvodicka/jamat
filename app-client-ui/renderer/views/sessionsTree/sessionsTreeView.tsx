import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import type {
  OrphanInfo,
  SessionOutcome,
  SessionSetupAgreement,
  SessionsOpResult,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteConnectionsSnapshot,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  RemoteControlResponse,
} from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { IpcResult, LoadSessionsViewResult } from '../../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../../shared/appClientUiReport'
import { AppCommands } from '../../../shared/commands'
import { ErrorText } from '../../../shared/errorText'
import { type SessionsTabsView, SessionsViewState } from '../../../shared/sessionsViewState'
import { SessionsFilterState, type SessionsFilterValue } from '../../../shared/sessionsFilterState'
import { type TerminalTarget, TerminalTargetCodec } from '../../../shared/terminalTarget'
import type { CommandRegistry } from '../../commands/commandRegistry'
import { IpcFailure } from '../../ipc/ipcFailure'
import type { SnapshotStore } from '../../ipc/snapshotStore'
import type {
  ConfigurationTabId,
} from '../../overlays/configuration/configurationTab.types'
import { type FinalizeAsk, FinalizeAsks } from '../../overlays/finalize/finalizeModel'
import type { LauncherIntent } from '../../overlays/launcher/launcherIntentStore'
import type { ActiveTerminalStore } from '../../shell/activeTerminalStore'
import { AgentGlyph } from '../../sessions/agentGlyph'
import type { SessionsMarksStore } from '../../sessions/sessionsMarksStore'
import type { ContextMenuPosition } from '../../widgets/contextMenu'
import { ContextMenu } from '../../widgets/contextMenu'
import { ErrorBoundary } from '../../widgets/errorBoundary'
import { SignalGlyph } from '../../widgets/signalGlyph'
import type { SidebarViewProps } from '../../widgets/sidebar/sidebarRegistry'
import type { TabSessionFacts } from '../../widgets/tabs/tabContextMenu'
import {
  type RemoteSessionsComputerTree,
  type RemoteSessionsSections,
  RemoteSessionsTreeModel,
} from './remoteSessionsTreeModel'
import { FinalizeAwait } from './finalizeAwait'
import { SessionsTreeActionButton } from './sessionsTreeActionButton'
import {
  type SessionAction,
  type SessionGlyph,
  type SessionMergeBadge,
  SessionNodeState,
  type SessionLaunchBadge,
  type SessionSetupBadge,
} from './sessionNodeState'
import './sessionsTree.css'
import { SessionsTreeContextMenu } from './sessionsTreeContextMenu'
import {
  type GroupRowFacts,
  SessionsTreeGroupItems,
  SessionsTreeGroupMenu,
} from './sessionsTreeGroupMenu'
import {
  type SessionBadges,
  SessionsTreeModel,
  type TreeContent,
  type TreeNode,
  type TreeResult,
  type TreeStateGroup,
  type WorktreeBadge,
} from './sessionsTreeModel'
import { useSessionsSnapshot, useSnapshotStore } from './useSessionsSnapshot'
import { useSessionStateFlash } from './useSessionStateFlash'
import { type CommitOpenStore, useCommitOpen } from '../../versioning/commitOpenStore'
import { SessionsFilterMenu } from './sessionsFilterMenu'
import { SessionsSavedFilters } from './sessionsSavedFilters'
import { useSavedSessionsFilters, type SavedSessionsFiltersPorts } from './useSavedSessionsFilters'

/** Everything the tree changes in the main process, apart from the shared snapshot document. */
export interface SessionsTreePorts extends SavedSessionsFiltersPorts {
  reportError(message: string): void
  finalize(sessionId: string): Promise<IpcResult<SessionsOpResult>>
  remove(sessionId: string): Promise<IpcResult<SessionsOpResult>>
  /** The hash answers a `setup-not-acknowledged` refusal, and travels no further than one call. */
  retrySetup(sessionId: string, acknowledgeSetup?: string): Promise<IpcResult<SessionsOpResult>>
  adoptOrphan(runtimeSessionId: string): Promise<IpcResult<SessionsOpResult>>
  /**
   * The remembered arrangement of the panel: together, by tab presentation, or by work state. It is
   * stored, unlike the filter above it, because it is how the panel is READ rather than what is
   * being looked for today.
   */
  loadView(): Promise<IpcResult<LoadSessionsViewResult>>
  saveView(view: SessionsTabsView): Promise<IpcResult<boolean>>
}

export interface SessionsTreeRemotePorts {
  disconnect(remoteEndpointId: string, sessionIds?: readonly string[]): Promise<IpcResult<void>>
  reopen(remoteEndpointId: string, sessionId: string): Promise<IpcResult<RemoteControlResponse>>
  finalize(remoteEndpointId: string, sessionId: string): Promise<IpcResult<RemoteControlResponse>>
}

/**
 * How long the tab the tree opens is meant to last. A look costs a tab that the next look reuses;
 * saying so takes a deliberate gesture, and the tree has exactly one, the double-click.
 */
export type SessionOpenIntent = 'preview' | 'permanent'

export interface SessionsTreeViewProps extends SidebarViewProps {
  ports: SessionsTreePorts
  snapshotStore: SnapshotStore<SessionsSnapshot>
  remotePorts: SessionsTreeRemotePorts
  remoteSnapshotStore: SnapshotStore<RemoteConnectionsSnapshot>
  /** What the row menu's items run through: the same registry the tab menu executes against. */
  commands: CommandRegistry
  /**
   * What the clicked row's session is, for that row's menu - the same accessor the tabs host
   * reads, asked when the menu opens and never subscribed to: a menu lives for a moment.
   */
  sessionFacts(sessionId: string): TabSessionFacts | null
  /**
   * What each session is marked as, computed once per window rather than here. The tree stopped
   * owning it the day a tab had to draw the same fact with the sidebar closed.
   */
  marks: SessionsMarksStore
  commitOpen: CommitOpenStore
  /** The terminal panel THIS workspace window has in front. */
  activeTerminal: ActiveTerminalStore
  /** Writes the intent and opens the launcher; what the launcher then does is its own business. */
  onLaunch(intent: LauncherIntent): void
  /** A row is how a session already running is looked at; the tab is the only place it is visible. */
  onOpenTerminal(target: TerminalTarget, tabTitle: string, intent: SessionOpenIntent): void
  /**
   * And the way back out: a stop that the library accepted leaves nothing to look at, so whatever
   * was drawing that session goes with it. Called on the stop alone - a session that ends by itself
   * keeps its tab, because the exit code is written there.
   */
  onCloseTerminal(target: TerminalTarget): void
  /**
   * And the way back in: a rerun the library accepted put a runtime behind a session whose tab is
   * still drawing the dead screen it was left with. The panel reads no snapshot by decision, so
   * being told is the only way it finds out.
   */
  onRerunTerminal(target: TerminalTarget): void
  /** Opens the finalize dialog with questions captured from the snapshot at click time. */
  onFinalizeAsk(ask: FinalizeAsk): void
  /**
   * Opens the settings card on one of its screens. A prop rather than a command, for the same reason
   * `onLaunch` beside it is one: the tab a row asks for is a renderer type, and the command catalog
   * is shared with the main process, which has never heard of a settings screen.
   */
  onOpenSettings(tab: ConfigurationTabId): void
  /**
   * Hands the keyboard back to the terminal the window has in front. The tree is read with the
   * mouse and typed into in exactly one place, so holding the focus is never what it is for: a row
   * clicked to look at a session is a session somebody is about to type into, and a click that
   * changes nothing at all should still not leave the caret on a button in here.
   */
  onFocusTerminal(): void
}

type SessionTreeNode = Extract<TreeNode, { kind: 'session' }>
type GroupTreeNode = Extract<TreeNode, { kind: 'category' | 'project' }>

/**
 * What the panel has to draw. The arrangement gets decided once, where the trees
 * are built, so the drawing reads it off this type instead of asking the same question again.
 */
type SessionsTrees =
  | { view: 'together'; both: TreeResult; remote: RemoteSessionsSections | null }
  | { view: 'separated'; sessions: TreeResult; tabs: TreeResult; remote: RemoteSessionsSections | null }
  | { view: 'states'; groups: readonly {
      key: TreeStateGroup
      title: string
      tree: TreeResult
      remote: RemoteSessionsSections | null
    }[] }

interface PendingConfirm {
  targetKey: string
  target: TerminalTarget
  action: SessionAction
  live: boolean
  endedAt: number | null
}

/**
 * The row menu's whole world, captured when it opens: a short-lived menu does not follow the
 * snapshot. Two kinds, because the tree has two kinds of row - a session, and the category or
 * project above it - and never more than one menu on screen at a time.
 */
type TreeMenuState =
  | {
      kind: 'session'
      position: ContextMenuPosition
      node: SessionTreeNode
      facts: TabSessionFacts
    }
  | {
      kind: 'remote-session'
      position: ContextMenuPosition
      node: SessionTreeNode
    }
  /** A paired computer THIS one dials, named by the endpoint a session would be started on. */
  | {
      kind: 'remote-computer'
      position: ContextMenuPosition
      remoteEndpointId: string
      displayName: string
    }
  | { kind: 'group'; position: ContextMenuPosition; facts: GroupRowFacts }

/**
 * What a right-click on a paired computer's row opens. The inbound section gets none: those rows are
 * another computer's connection TO this one, and nothing there is this computer's to start.
 */
type RemoteRowMenu = (
  remoteEndpointId: string,
  displayName: string,
  position: ContextMenuPosition,
) => void

/** What every row below needs from the view, as one prop instead of six threaded through the tree. */
interface SessionsTreeChrome {
  pending: PendingConfirm | null
  collapsed: ReadonlySet<string>
  /** The one target THIS workspace window has in front. */
  inFront: string | null
  /**
   * The `sessionId:action` pairs whose call is still out. A button is drawn dead for its own pair,
   * because the library serializes operations: the second click of a pair reaches a record the
   * first one has already moved, and is answered with a refusal for an action that worked.
   */
  inFlight: ReadonlySet<string>
  /** Accepted live Finish calls waiting for their snapshot to reach an ended state. */
  awaitingAsk: ReadonlyMap<string, TerminalTarget>
  toggle(nodeId: string): void
  request(node: SessionTreeNode, action: SessionAction): void
  launch(intent: LauncherIntent): void
  openTerminal(target: TerminalTarget, tabTitle: string, intent: SessionOpenIntent): void
  openMenu(node: SessionTreeNode, position: ContextMenuPosition): void
  openGroupMenu(facts: GroupRowFacts, position: ContextMenuPosition): void
  openRemoteMenu: RemoteRowMenu
  disconnect(remoteEndpointId: string, sessionIds?: readonly string[]): void
  openSettings(tab: ConfigurationTabId): void
}

/**
 * The sessions tree: the first surface that shows what the session manager knows.
 *
 * It decides nothing about a session - which glyph, which project, which actions and what a filter
 * hides are all `SessionsTreeModel`'s answers. What lives here is the chrome the model has no
 * opinion about: what is collapsed, what is typed into the filter, which destructive action is
 * waiting for its second click, and which failures are worth a line of text.
 */
export function SessionsTreeView(props: SessionsTreeViewProps): React.JSX.Element {
  const {
    ports,
    remotePorts,
    snapshotStore,
    remoteSnapshotStore,
    onLaunch,
    onOpenSettings,
    sessionFacts,
    onFinalizeAsk,
  } = props
  const { snapshot, error, refresh } = useSessionsSnapshot(snapshotStore)
  const {
    snapshot: remoteSnapshot,
    error: remoteError,
    refresh: refreshRemote,
  } = useSnapshotStore(remoteSnapshotStore)
  const marksView = useSyncExternalStore(
    useCallback((listener) => props.marks.subscribe(listener), [props.marks]),
    useCallback(() => props.marks.current(), [props.marks]),
    useCallback(() => props.marks.current(), [props.marks]),
  )
  const marks = marksView.marks
  const commitOpen = useCommitOpen(props.commitOpen)
  const visibleTargetKeys = marksView.activeTargetKeys
  const activeTerminal = useSyncExternalStore(
    useCallback((listener) => props.activeTerminal.subscribe(listener), [props.activeTerminal]),
    useCallback(() => props.activeTerminal.current(), [props.activeTerminal]),
    useCallback(() => props.activeTerminal.current(), [props.activeTerminal]),
  )
  const activeTargetKey = activeTerminal === null
    ? null
    : TerminalTargetCodec.key(activeTerminal.target)
  const [filters, setFilters] = useState<SessionsFilterValue>(SessionsFilterState.defaultConst)
  const savedFilters = useSavedSessionsFilters(ports)
  const [namingFilter, setNamingFilter] = useState(false)
  const [filterMenu, setFilterMenu] = useState<{ position: ContextMenuPosition; savedId: string | null } | null>(null)
  const [groupingMenu, setGroupingMenu] = useState<ContextMenuPosition | null>(null)
  const [view, setView] = useState<SessionsTabsView>(SessionsViewState.defaultConst)
  const [filterText, setFilterText] = useState('')
  // ONE set for both trees. A project node keeps its id wherever it is drawn, because it is the same
  // project: folding it away is a statement about that project, not about the section it happens to
  // be in. Two sets would give one twisty two answers in one panel, and a third for `together`.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [menu, setMenu] = useState<TreeMenuState | null>(null)
  const [orphansOpen, setOrphansOpen] = useState(false)
  /**
   * The failure of ONE operation, named by the `sessionId:action` it belongs to. Keyed rather than
   * kept as a single string because this surface admits several operations at once, which is what
   * `IpcFailure.of`'s own label parameter exists for: a later operation answering `ok` used to
   * write `null` over the reason an earlier one had left on screen, before anybody read it.
   */
  const [opError, setOpError] = useState<{ key: string; text: string } | null>(null)
  /**
   * The setup a retry is asking about. `setup-not-acknowledged` is the ONE refusal here that a
   * person can answer, so it is drawn as a question rather than written into the error line: the
   * library hands back the commands to show and the hash to answer with.
   */
  const [setupAsk, setSetupAsk] = useState<
    ({ sessionId: string; key: string } & SessionSetupAgreement) | null
  >(null)
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set())
  const [awaitingAsk, changeAwaitingAsk] = useReducer(
    FinalizeAwait.reduce,
    new Map<string, TerminalTarget>(),
  )
  /**
   * One per content, not one for the panel: the same project node is in the sessions tree and in the
   * tabs tree under one id, so a shared cursor would compare each tree's row against the other's and
   * hand back the node from the wrong one.
   */
  const previous = useRef<Record<TreeContent | TreeStateGroup, TreeResult | null>>(
    { sessions: null, tabs: null, both: null, attention: null, unread: null, running: null, read: null },
  )
  const previousRemote = useRef<Record<'both' | TreeStateGroup, ReadonlyMap<string, TreeResult>>>({
    both: new Map(), attention: new Map(), unread: new Map(), running: new Map(), read: new Map(),
  })
  const currentSnapshots = useRef({ snapshot, remoteSnapshot })

  const trees = useMemo((): SessionsTrees | null => {
    if (!snapshot)
      return null
    // Read once per build, so both trees answer "how long ago did this close" against one moment.
    const now = Date.now()
    const build = (content: TreeContent, stateGroup?: TreeStateGroup): TreeResult => SessionsTreeModel.build(
      snapshot,
      { filters, content, filterText, now, inFront: visibleTargetKeys, stateGroup },
      marks,
      previous.current[stateGroup ?? content],
      undefined,
      commitOpen,
    )
    const remote = (stateGroup?: TreeStateGroup): RemoteSessionsSections | null => remoteSnapshot === null
      ? null
      : RemoteSessionsTreeModel.build(
          remoteSnapshot, snapshot, { filters, filterText, now, inFront: visibleTargetKeys, stateGroup },
          marks, previousRemote.current[stateGroup ?? 'both'],
        )
    if (view === 'together')
      return { view, both: build('both'), remote: remote() }
    else if (view === 'separated')
      return { view, sessions: build('sessions'), tabs: build('tabs'), remote: remote() }
    else if (view === 'states')
      return { view, groups: SessionsTreeModel.groupsConst.map((group) => ({
        ...group, tree: build('both', group.key), remote: remote(group.key),
      })) }
    else
      throw new Error(`Unknown sessions view: ${JSON.stringify(view)}`)
  }, [snapshot, remoteSnapshot, filters, filterText, marks, view, visibleTargetKeys, commitOpen])

  /*
   * The cursor moves AFTER the commit, never during the render that produced the tree. React may run
   * a `useMemo` factory and then throw the result away, and a cursor written in there would be
   * holding a tree that never reached the DOM - so the next build would compare live rows against
   * one nobody saw, and hand out new objects for rows that had not moved.
   */
  useEffect(() => {
    if (trees === null) return
    if (trees.view === 'together') {
      previous.current.both = trees.both
      if (trees.remote !== null) previousRemote.current.both = trees.remote.previous
    }
    else if (trees.view === 'separated') {
      previous.current.sessions = trees.sessions
      previous.current.tabs = trees.tabs
      if (trees.remote !== null) previousRemote.current.both = trees.remote.previous
    }
    else if (trees.view === 'states')
      for (const group of trees.groups) {
        previous.current[group.key] = group.tree
        if (group.remote !== null) previousRemote.current[group.key] = group.remote.previous
      }
    else
      throw new Error(`Unknown sessions view: ${JSON.stringify(trees)}`)
  }, [trees])

  // The click callback stays stable across snapshot ticks, while its ask still reads the document
  // that produced the committed rows. A snapshot dependency here would redraw every memoized row.
  useLayoutEffect(() => {
    currentSnapshots.current = { snapshot, remoteSnapshot }
  }, [snapshot, remoteSnapshot])

  useEffect(() => {
    if (pending === null) return
    const found = FinalizeAwait.findOf(pending.target, snapshot, remoteSnapshot)
    if (found.state === 'unknown-yet') return
    else if (found.state === 'gone') setPending(null)
    else if (found.state === 'found') {
      const live = SessionNodeState.isLive(found.info.life)
      if (live !== pending.live || (found.info.endedAt ?? null) !== pending.endedAt)
        setPending(null)
    } else
      throw new Error(`Unknown pending confirmation state: ${JSON.stringify(found)}`)
  }, [pending, snapshot, remoteSnapshot])

  useEffect(() => {
    if (awaitingAsk.size === 0) return
    const settled: string[] = []
    for (const [targetKey, target] of awaitingAsk) {
      const found = FinalizeAwait.findOf(target, snapshot, remoteSnapshot)
      if (found.state === 'unknown-yet') continue
      else if (found.state === 'gone') {
        settled.push(targetKey)
        continue
      }
      else if (found.state === 'found') {
        if (SessionNodeState.isLive(found.info.life)) continue
        settled.push(targetKey)
        const ask = FinalizeAwait.askOf(target, snapshot, remoteSnapshot)
        if (ask !== null) onFinalizeAsk(ask)
      }
      else
        throw new Error(`Unknown finalize await state: ${JSON.stringify(found)}`)
    }
    if (settled.length > 0)
      changeAwaitingAsk({ kind: 'settled', targetKeys: settled })
  }, [awaitingAsk, snapshot, remoteSnapshot, onFinalizeAsk])

  // Read once, and a read that answers nothing leaves the default standing: this is how the panel
  // looks, so it never latches and never stops the panel from drawing.
  useEffect(() => {
    let disposed = false
    void ports.loadView()
      .then((answer) => {
        if (disposed)
          return
        if (!answer.ok)
          ports.reportError(`The sessions view could not be read: ${answer.error}`)
        else if (answer.value.sessionsView !== null)
          setView(answer.value.sessionsView)
      })
      .catch((thrown: unknown) =>
        ports.reportError(`The sessions view could not be read: ${ErrorText.of(thrown)}`))
    return () => { disposed = true }
  }, [ports])

  // Stored on the press, with no debounce: this is one click now and then, which is the whole reason
  // it is a key of its own rather than a field of the sidebar state written on every drag.
  const switchView = useCallback((next: SessionsTabsView): void => {
    setView(next)
    void ports.saveView(next)
      .then((answer) => {
        if (!answer.ok)
          ports.reportError(`The sessions view could not be stored: ${answer.error}`)
      })
      .catch((thrown: unknown) =>
        ports.reportError(`The sessions view could not be stored: ${ErrorText.of(thrown)}`))
  }, [ports])

  // `onDone` runs only when the library accepted: a stop that was refused leaves a session running,
  // and closing what shows it would hide the one thing still worth looking at.
  const run = useCallback((
    key: string,
    label: string,
    call: () => Promise<IpcResult<SessionsOpResult | RemoteControlResponse>>,
    onDone?: () => void,
  ) => {
    // Written before the call goes out, so the button is dead by the time a second click could land.
    setInFlight((current) => new Set(current).add(key))
    const settle = (failure: string | null): void => {
      setInFlight((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
      // Only this operation's own line is written or cleared. Another one's reason stays until its
      // own call answers.
      setOpError((current) => {
        if (failure !== null) return { key, text: failure }
        return current?.key === key ? null : current
      })
    }
    void call()
      .then((answer) => {
        const failure = SessionsTreeOperation.failureOf(answer, label)
        settle(failure)
        if (failure === null)
          onDone?.()
      })
      .catch((thrown: unknown) => settle(`${label} failed: ${ErrorText.of(thrown)}`))
  }, [])

  /**
   * Retry setup is the one operation whose refusal is a question. A project that edited its
   * `.worktree.json` after the create agreed to it gets `setup-not-acknowledged` back, carrying the
   * commands and the hash - and before this existed there was nowhere to answer it: the create
   * path's blocks live in the launcher, and a failed install lives here. The only way out was
   * starting an unrelated worktree session to re-agree.
   *
   * The hash travels with ONE call and no further, exactly as it does on the create path.
   */
  const retrySetup = useCallback((key: string, sessionId: string, acknowledgeSetup?: string) => {
    setSetupAsk((current) => (current?.key === key ? null : current))
    setInFlight((current) => new Set(current).add(key))
    void ports.retrySetup(sessionId, acknowledgeSetup)
      .then((answer) => {
        setInFlight((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
        const asking = SessionsTreeOperation.setupAskOf(answer)
        if (asking !== null) {
          setSetupAsk({ sessionId, key, commands: asking.commands, hash: asking.hash })
          setOpError((current) => (current?.key === key ? null : current))
          return
        }
        const failure = SessionsTreeOperation.failureOf(answer, 'Retry setup')
        setOpError((current) => {
          if (failure !== null) return { key, text: failure }
          return current?.key === key ? null : current
        })
      })
      .catch((thrown: unknown) => {
        setInFlight((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
        setOpError({ key, text: `Retry setup failed: ${ErrorText.of(thrown)}` })
      })
  }, [ports])

  const { onCloseTerminal, onOpenTerminal, onRerunTerminal } = props
  const perform = useCallback((
    node: SessionTreeNode,
    action: SessionAction,
  ): void => {
    // Only the running form of Finish reaches this operation path, so an accepted Finish takes its
    // terminal with it. Ended Finish is a dialog request and returns before `perform`.
    const targetKey = TerminalTargetCodec.key(node.target)
    const key = SessionsTreeActions.keyOf(targetKey, action)
    const onStopped = node.live
      ? () => {
          onCloseTerminal(node.target)
          changeAwaitingAsk({ kind: 'accepted', targetKey, target: node.target })
        }
      : undefined
    if (node.operationScope === 'local') {
      if (node.target.kind !== 'local')
        throw new Error(`A local operation received a remote target: ${JSON.stringify(node.target)}`)
      const sessionId = node.target.sessionId
      if (action === 'finalize')
        run(
          key,
          'Finish',
          () => ports.finalize(sessionId),
          onStopped,
        )
      // `reopen` is `Resume session` here since 2026-09-10: the catalog item opens the create card
      // on this session, and the card is what calls the library. It cannot reach this branch, and a
      // local row that sent one anyway would be drawing an item nothing in this file draws.
      else if (action === 'remove')
        run(key, 'Remove', () => ports.remove(sessionId), () => onCloseTerminal(node.target))
      else if (action === 'retrySetup')
        retrySetup(key, sessionId)
      else
        throw new Error(`Unknown local session action: ${JSON.stringify(action)}`)
    } else if (node.operationScope === 'remote') {
      if (node.target.kind !== 'remote')
        throw new Error(`A remote operation received a local target: ${JSON.stringify(node.target)}`)
      const target = node.target
      if (action === 'finalize')
        run(
          key,
          'Finish',
          () => remotePorts.finalize(target.remoteEndpointId, target.sessionId),
          onStopped,
        )
      else if (action === 'reopen')
        run(
          key,
          'Rerun',
          () => remotePorts.reopen(target.remoteEndpointId, target.sessionId),
          () => onRerunTerminal(target),
        )
      else
        throw new Error(`Unknown remote session action: ${JSON.stringify(action)}`)
    } else
      throw new Error(`Unknown operation scope: ${JSON.stringify(node.operationScope)}`)
  }, [ports, remotePorts, run, onCloseTerminal, onRerunTerminal])

  // A confirmed action acts on the second click of the same button. Ended Finish returns through
  // the dialog path before confirmation; live Finish and Remove remain armed.
  const request = useCallback((
    node: SessionTreeNode,
    action: SessionAction,
  ): void => {
    if (!node.interactive) return
    // A pair still out is not asked again. The library serializes operations, so the second call
    // would reach a record the first has already moved and be refused for an action that worked.
    const targetKey = TerminalTargetCodec.key(node.target)
    if (inFlight.has(SessionsTreeActions.keyOf(targetKey, action))) return
    if (awaitingAsk.has(targetKey)) return
    let currentNode = node
    if (action === 'finalize') {
      const current = currentSnapshots.current
      const found = FinalizeAwait.findOf(node.target, current.snapshot, current.remoteSnapshot)
      if (found.state === 'unknown-yet' || found.state === 'gone') return
      else if (found.state === 'found') {
        const live = SessionNodeState.isLive(found.info.life)
        if (live && !found.info.admits.includes('finalize')) return
        currentNode = {
          ...node,
          tabTitle: found.info.tabTitle,
          live,
          endedAt: found.info.endedAt ?? null,
        }
        if (!live) {
          setPending(null)
          const ask = FinalizeAsks.of(found.info, node.target, found.scope)
          if (ask !== null) {
            onOpenTerminal(node.target, found.info.tabTitle, 'preview')
            onFinalizeAsk(ask)
          }
          return
        }
      } else
        throw new Error(`Unknown finalize request state: ${JSON.stringify(found)}`)
    }
    // A confirmation is given over the terminal it is about, so the first accepted click puts it
    // on screen. A blocked duplicate above has no visual side effect.
    onOpenTerminal(currentNode.target, currentNode.tabTitle, 'preview')
    if (!SessionsTreeActions.confirms(currentNode, action)) {
      perform(currentNode, action)
      return
    }
    if (pending?.targetKey === targetKey
      && pending.action === action
      && pending.live === currentNode.live
      && pending.endedAt === currentNode.endedAt) {
      setPending(null)
      perform(currentNode, action)
      return
    }
    setPending({
      targetKey,
      target: currentNode.target,
      action,
      live: currentNode.live,
      endedAt: currentNode.endedAt,
    })
  }, [pending, perform, onOpenTerminal, inFlight, awaitingAsk, onFinalizeAsk])

  const toggle = useCallback((nodeId: string) => {
    setCollapsed((current) => SessionsTreeChoices.toggled(current, nodeId))
  }, [])

  // The facts are captured HERE, when the menu opens. A session the snapshot no longer names
  // gets no menu at all: an item acting on a guess would be worse than none.
  const openMenu = useCallback((
    node: SessionTreeNode,
    position: ContextMenuPosition,
  ) => {
    if (!node.interactive) return
    if (node.operationScope === 'remote')
      setMenu({ kind: 'remote-session', position, node })
    else if (node.operationScope === 'local') {
      const facts = sessionFacts(node.sessionId)
      if (facts !== null)
        setMenu({
          kind: 'session',
          position,
          node,
          facts,
        })
    } else
      throw new Error(`Unknown operation scope: ${JSON.stringify(node.operationScope)}`)
  }, [sessionFacts])

  // A row that offers nothing opens nothing: the AD-HOC and NO PROJECT roots name no category and
  // hold no path, and an empty box under the cursor is worse than a right-click that does nothing.
  const openGroupMenu = useCallback((facts: GroupRowFacts, position: ContextMenuPosition) => {
    if (SessionsTreeGroupItems.any(facts))
      setMenu({ kind: 'group', position, facts })
  }, [])

  // The endpoint and the name are the whole of it: what a paired computer offers does not depend on
  // its sessions, and the row is only drawn while that computer is connected.
  const openRemoteMenu = useCallback((
    remoteEndpointId: string,
    displayName: string,
    position: ContextMenuPosition,
  ) => {
    setMenu({ kind: 'remote-computer', position, remoteEndpointId, displayName })
  }, [])

  /*
   * Held stable across a tick, which is the other half of the identity `SessionsTreeModel.build`
   * keeps. `TreeRow` is memoized, so a row is re-rendered when its node OR this object moves; a
   * fresh literal every render made the node identity buy nothing, and the whole tree re-rendered on
   * every poll. What is in here moves when a person does something - opens a menu, arms an action,
   * collapses a row, brings a tab to the front - and not when a session prints a line.
   */
  const chrome: SessionsTreeChrome = useMemo(() => ({
    pending,
    collapsed,
    inFront: activeTargetKey,
    inFlight,
    awaitingAsk,
    toggle,
    request,
    launch: onLaunch,
    openTerminal: onOpenTerminal,
    openMenu,
    openGroupMenu,
    openRemoteMenu,
    openSettings: onOpenSettings,
    disconnect: (remoteEndpointId, sessionIds) => {
      void remotePorts.disconnect(remoteEndpointId, sessionIds).then((answer) => {
        if (!answer.ok) throw new Error(answer.error)
        const entry = remoteSnapshot?.outbound.find((endpoint) => endpoint.remoteEndpointId === remoteEndpointId)
        for (const sessionId of sessionIds ?? entry?.selectedSessionIds ?? [])
          onCloseTerminal({ kind: 'remote', remoteEndpointId, sessionId })
      }).catch((error: unknown) => AppClientUiReport.error(String(error)))
    },
  }), [
    pending, collapsed, activeTargetKey, inFlight, awaitingAsk,
    toggle, request, onLaunch, onOpenTerminal, openMenu, openGroupMenu, openRemoteMenu,
    onOpenSettings, remotePorts, remoteSnapshot, onCloseTerminal,
  ])

  const resetFilters = (): void => {
    setFilters(SessionsFilterState.allConst)
    setFilterText('')
  }

  return (
    <section
      className="jamat-sessions"
      aria-label="Sessions"
      // Anything that is not the armed button itself takes the question back. Without it an armed
      // Remove would sit there through a filter change and answer the next click on a row it no
      // longer belongs to.
      onClick={(event) => {
        const clicked = event.target instanceof HTMLElement ? event.target : null
        const insidePanel = clicked !== null && event.currentTarget.contains(clicked)
        if (insidePanel && !clicked.closest('[data-confirm]'))
          setPending(null)
        /*
         * And then the keyboard goes back where it is used. One handler for the whole panel rather
         * than one per row, because the rule is about the tree and not about a control in it: a row,
         * a twisty, a filter chip and the padding between them all leave the caret on something that
         * does nothing with it. The filter box is the single exception and keeps what the click just
         * gave it. A row that puts ANOTHER session in front is not undone by this: that panel takes
         * the caret when it becomes active, which happens after this click.
         *
         * A portal event still bubbles through this React tree although its target is no DOM child
         * of the panel. `insidePanel` keeps menu choices out of both the cancellation and focus rule.
         */
        if (insidePanel
          && clicked.closest('input, textarea') === null)
          props.onFocusTerminal()
      }}
    >
      <header className="jamat-sessions__head">
        {/* No row of its own for the one verb: `New session` sits on the sidebar's title line,
            which was already drawn and had space to its right. */}
        <SessionsSavedFilters
          saved={savedFilters.saved} filters={filters} filterText={filterText}
          naming={namingFilter} saving={savedFilters.saving} onReset={resetFilters}
          onApply={(saved) => { setFilters(saved.filters); setFilterText(saved.filterText) }}
          onMenu={(savedId, position) => { setMenu(null); setFilterMenu({ savedId, position }) }}
          onCancel={() => setNamingFilter(false)}
          onSave={(name) => {
            void savedFilters.save([...savedFilters.saved, {
              id: crypto.randomUUID(), name, filters, filterText,
            }]).then((stored) => { if (stored) setNamingFilter(false) })
          }}
        />
        <input
          className="jamat-sessions__filter"
          type="text"
          aria-label="Filter sessions"
          placeholder="filter sessions…"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
        />
      </header>

      {savedFilters.error !== null && <p className="jamat-sessions__error" role="alert">
        {savedFilters.error}
        {!savedFilters.ready && <button className="jamat-sessions__retry" type="button" onClick={savedFilters.reload}>Retry</button>}
      </p>}

      {error !== null && (
        <p className="jamat-sessions__error">
          {error}
          <button className="jamat-sessions__retry" type="button" onClick={refresh}>Retry</button>
        </p>
      )}
      {remoteError !== null && (
        <p className="jamat-sessions__error">
          {remoteError}
          <button className="jamat-sessions__retry" type="button" onClick={refreshRemote}>
            Retry
          </button>
        </p>
      )}
      {setupAsk !== null && (
        <div className="jamat-sessions__setup-ask" role="group" aria-label="Setup agreement">
          <p>This project asks to run its own setup before the session starts:</p>
          <ul>
            {setupAsk.commands.map((command) => <li key={command}><code>{command}</code></li>)}
          </ul>
          <p className="jamat-sessions__setup-ask-actions">
            <button
              type="button"
              onClick={() => retrySetup(setupAsk.key, setupAsk.sessionId, setupAsk.hash)}
            >Run these commands</button>
            <button type="button" onClick={() => setSetupAsk(null)}>Cancel</button>
          </p>
        </div>
      )}
      {opError !== null && <p className="jamat-sessions__error">{opError.text}</p>}

      {/* The rows branch exhaustively on a dozen discriminants and throw on anything else, which is
          right and is why this is here: without it one value out of a record nobody planned for
          takes the whole window, not the panel. */}
      <ErrorBoundary what="The sessions tree" onError={ports.reportError}>
        <div className="jamat-sessions__body">
          {trees === null
            ? <p className="jamat-sessions__empty">Reading sessions…</p>
            : <TreeBodies trees={trees} chrome={chrome} />}
        </div>
      </ErrorBoundary>

      {/* Nothing about the Host: that reading is one component in the status bar, and a second copy
          of it here was a second thing to keep in step with the first. */}
      <footer className="jamat-sessions__foot">
        {snapshot !== null && snapshot.orphans.length > 0 && (
          <Orphans
            orphans={snapshot.orphans}
            open={orphansOpen}
            onToggle={() => setOrphansOpen((current) => !current)}
            onAdopt={(runtimeSessionId) =>
              run(`orphan:${runtimeSessionId}`, 'Adopt', () => ports.adoptOrphan(runtimeSessionId))}
          />
        )}
        <button
          className="jamat-sessions__foot-button jamat-sessions__view-toggle"
          type="button"
          aria-haspopup="menu" aria-expanded={groupingMenu !== null}
          title={SessionsViewState.labelsConst[view]}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setMenu(null)
            setFilterMenu(null)
            setGroupingMenu({ x: box.left, y: box.top })
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            switchView(SessionsViewState.defaultConst)
            setGroupingMenu(null)
          }}
        >
          Grouping
        </button>
        <button className="jamat-sessions__foot-button jamat-sessions__filter-toggle" type="button"
          aria-haspopup="menu" aria-expanded={filterMenu !== null}
          data-active={!SessionsFilterState.equal(filters, SessionsFilterState.defaultConst) || filterText.trim() !== ''}
          title="Filter sessions. Right-click to restore default filters (Active)."
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setMenu(null)
            setGroupingMenu(null)
            setFilterMenu({ position: { x: box.left, y: box.top }, savedId: null })
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setFilters(SessionsFilterState.defaultConst)
            setFilterText('')
            setFilterMenu(null)
          }}
        >Filter</button>
      </footer>

      {groupingMenu !== null && <ContextMenu position={groupingMenu} ariaLabel="Session grouping"
        items={(Object.keys(SessionsViewState.labelsConst) as SessionsTabsView[]).map((choice) => ({
          key: choice, label: SessionsViewState.labelsConst[choice], checked: view === choice,
          onSelect: () => switchView(choice),
        }))}
        onClose={() => setGroupingMenu(null)}
      />}

      {filterMenu !== null && <SessionsFilterMenu {...filterMenu}
        filters={filters} saved={savedFilters.saved} canSave={savedFilters.ready && !savedFilters.saving}
        onChange={setFilters} onReset={resetFilters} onSave={() => setNamingFilter(true)}
        onClosedRecently={() => {
          setFilters(SessionsFilterState.closedRecentlyConst)
          setFilterText('')
        }}
        onDelete={(id) => { void savedFilters.save(savedFilters.saved.filter((saved) => saved.id !== id)) }}
        onClose={() => setFilterMenu(null)}
      />}

      {menu !== null && (
        <TreeMenu
          menu={menu}
          commands={props.commands}
          chrome={chrome}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  )
}

/** Whichever of the two row menus is open. One at a time, which is what the one state field says. */
function TreeMenu(props: {
  menu: TreeMenuState
  commands: CommandRegistry
  chrome: SessionsTreeChrome
  onClose(): void
}): React.JSX.Element {
  const { menu, commands, onClose } = props
  if (menu.kind === 'session')
    return (
      <SessionsTreeContextMenu
        position={menu.position}
        commands={commands}
        sessionId={menu.node.sessionId}
        facts={menu.facts}
        plainTab={menu.node.badges.plainTab}
        actions={menu.node.actions}
        onAction={(action) => props.chrome.request(menu.node, action)}
        onClose={onClose}
      />
    )
  else if (menu.kind === 'group')
    return (
      <SessionsTreeGroupMenu
        position={menu.position}
        commands={commands}
        facts={menu.facts}
        onClose={onClose}
      />
    )
  else if (menu.kind === 'remote-session')
    return (
      <ContextMenu
        position={menu.position}
        ariaLabel="Remote session actions"
        className="jamat-tab-menu"
        items={RemoteSessionMenu.items(menu.node, props.chrome, commands)}
        onClose={onClose}
      />
    )
  else if (menu.kind === 'remote-computer')
    return (
      <ContextMenu
        position={menu.position}
        ariaLabel="Remote computer actions"
        className="jamat-tab-menu"
        items={RemoteComputerMenu.items(menu, props.chrome)}
        onClose={onClose}
      />
    )
  else
    throw new Error(`Unknown tree menu: ${JSON.stringify(menu)}`)
}

function TreeBodies(props: {
  trees: SessionsTrees
  chrome: SessionsTreeChrome
}): React.JSX.Element {
  const { trees, chrome } = props
  if (trees.view === 'states')
    return <div className="jamat-sessions__stack">
      {trees.groups.map((group) => <section key={group.key} aria-label={group.title}>
        <h3 className="jamat-sessions__section">{group.title}</h3>
        {(group.tree.nodes.length > 0
          || (group.remote?.outbound.length ?? 0) + (group.remote?.inbound.length ?? 0) === 0)
          && <TreeBody result={group.tree} chrome={chrome} empty="No sessions in this group." />}
        <RemoteBodies remote={group.remote} chrome={chrome} />
      </section>)}
    </div>
  let local: React.JSX.Element
  if (trees.view === 'together') local = <TreeBody result={trees.both} chrome={chrome} />
  else if (trees.view === 'separated')
    local = (
      <>
        <TreeBody result={trees.sessions} chrome={chrome} />
        {/* The one action that belongs to a SECTION rather than to a node, and the only reason this
            heading is a row: a tab has no project to be started from, so the affordance for it has
            nowhere else to sit. It arrives on hover in the same container every other row action
            uses, because a panel where one button is always on screen and the rest are not reads as
            a mistake rather than as emphasis. */}
        <div className="jamat-sessions__section-row jamat-sessions__section-row--tabs">
          <h3 className="jamat-sessions__section">Tabs</h3>
          <span className="jamat-sessions__group-actions">
            <SessionsTreeActionButton
              label="+ Tab"
              ariaLabel="New tab"
              onClick={() => chrome.launch({ purpose: 'tabProfile' })}
            />
          </span>
        </div>
        <TreeBody result={trees.tabs} chrome={chrome} empty="No tabs." />
      </>
    )
  else
    throw new Error(`Unknown sessions view: ${JSON.stringify(trees)}`)
  return (
    <div className="jamat-sessions__stack">
      {local}
      <RemoteBodies remote={trees.remote} chrome={chrome} />
    </div>
  )
}

function RemoteBodies(props: {
  remote: RemoteSessionsSections | null
  chrome: SessionsTreeChrome
}): React.JSX.Element | null {
  const { remote, chrome } = props
  if (remote === null) return null
  return <>
    <RemoteSection title="Remote" computers={remote.outbound} chrome={chrome}
      sessionEmpty="No sessions." onRowMenu={chrome.openRemoteMenu} />
    <RemoteSection title="Remote connections" computers={remote.inbound} chrome={chrome}
      sessionEmpty="No attached sessions." onRowMenu={null} />
  </>
}

function RemoteSection(props: {
  title: string
  computers: readonly RemoteSessionsComputerTree[]
  chrome: SessionsTreeChrome
  sessionEmpty: string
  onRowMenu: RemoteRowMenu | null
}): React.JSX.Element | null {
  if (props.computers.length === 0) return null
  return (
    <>
      <h3 className="jamat-sessions__section">{props.title}</h3>
      <div>
        {props.computers.map((computer) => (
          <RemoteComputer
            key={computer.id}
            computer={computer}
            chrome={props.chrome}
            sessionEmpty={props.sessionEmpty}
            onRowMenu={props.onRowMenu}
          />
        ))}
      </div>
    </>
  )
}

function RemoteComputer(props: {
  computer: RemoteSessionsComputerTree
  chrome: SessionsTreeChrome
  sessionEmpty: string
  onRowMenu: RemoteRowMenu | null
}): React.JSX.Element {
  const { computer, chrome, onRowMenu } = props
  const open = !chrome.collapsed.has(computer.id)
  const only = computer.endpoints.length === 1 ? computer.endpoints[0] : null
  return (
    <div>
      {/* The computer row is the endpoint's own row whenever there is one of them, which is what
          the endpoint level collapsing away means; with several, each endpoint carries its menu. */}
      <RemoteGroupRow
        id={computer.id}
        label={computer.label}
        status={only?.status ?? null}
        open={open}
        onToggle={chrome.toggle}
        onContextMenu={onRowMenu === null || only === null
          ? null
          : (position) => onRowMenu(only.remoteEndpointId, computer.label, position)}
      />
      {open && (
        <div className="jamat-sessions__children">
          {only === null
            ? computer.endpoints.map((endpoint) => (
                <RemoteEndpoint
                  key={endpoint.id}
                  endpoint={endpoint}
                  chrome={chrome}
                  sessionEmpty={props.sessionEmpty}
                  onContextMenu={onRowMenu === null
                    ? null
                    : (position) =>
                        onRowMenu(endpoint.remoteEndpointId, computer.label, position)}
                />
              ))
            : <TreeBody result={only.tree} chrome={chrome} empty={props.sessionEmpty} />}
        </div>
      )}
    </div>
  )
}

function RemoteEndpoint(props: {
  endpoint: RemoteSessionsComputerTree['endpoints'][number]
  chrome: SessionsTreeChrome
  sessionEmpty: string
  onContextMenu: ((position: ContextMenuPosition) => void) | null
}): React.JSX.Element {
  const { endpoint, chrome } = props
  const open = !chrome.collapsed.has(endpoint.id)
  return (
    <div>
      <RemoteGroupRow
        id={endpoint.id}
        label={endpoint.label}
        status={endpoint.status}
        open={open}
        onToggle={chrome.toggle}
        onContextMenu={props.onContextMenu}
      />
      {open && (
        <div className="jamat-sessions__children">
          <TreeBody result={endpoint.tree} chrome={chrome} empty={props.sessionEmpty} />
        </div>
      )}
    </div>
  )
}

function RemoteGroupRow(props: {
  id: string
  label: string
  status: RemoteSessionsComputerTree['endpoints'][number]['status'] | null
  open: boolean
  onToggle(id: string): void
  onContextMenu: ((position: ContextMenuPosition) => void) | null
}): React.JSX.Element {
  const onContextMenu = props.onContextMenu
  return (
    <div
      className="jamat-sessions__group-row"
      onContextMenu={onContextMenu === null
        ? undefined
        : (event) => {
            event.preventDefault()
            onContextMenu({ x: event.clientX, y: event.clientY })
          }}
    >
      <button
        className="jamat-sessions__group"
        type="button"
        aria-expanded={props.open}
        onClick={() => props.onToggle(props.id)}
      >
        <span className="jamat-sessions__twisty" aria-hidden="true">{props.open ? '▾' : '▸'}</span>
        <span className="jamat-sessions__label">{props.label}</span>
        {props.status !== null && (
          <span
            className={`jamat-sessions__remote-status jamat-sessions__remote-status--${props.status}`}
          >
            {props.status}
          </span>
        )}
      </button>
    </div>
  )
}

/**
 * `empty` names the section rather than the state it is empty for. Under a heading of its own, both
 * default sentences are about the tree ABOVE: "No sessions yet." is answered by the sessions there,
 * and a tabs section reading "No session matches this filter." reads as that tree's answer repeated.
 */
function TreeBody(props: {
  result: TreeResult
  chrome: SessionsTreeChrome
  empty?: string
}): React.JSX.Element {
  const { result, chrome, empty } = props
  if (result.emptyState === 'noSessions')
    return <p className="jamat-sessions__empty">{empty ?? 'No sessions yet.'}</p>
  else if (result.emptyState === 'noMatch')
    return <p className="jamat-sessions__empty">{empty ?? 'No session matches this filter.'}</p>
  else if (result.emptyState === 'none')
    return (
      <div>
        {result.nodes.map((node) => <TreeRow key={node.id} node={node} chrome={chrome} />)}
      </div>
    )
  else
    throw new Error(`Unknown tree empty state: ${JSON.stringify(result.emptyState)}`)
}

/**
 * Memoized, and this is the consumer `SessionsTreeModel.withIdentity` was written for. It keeps the
 * previous node OBJECT for every row a tick did not move, which changes nothing at all unless
 * something compares that identity - and nothing did: every row was a plain function re-invoked on
 * every parent render, so the fingerprint pass was a `JSON.stringify` per node per tick buying
 * nothing. The `chrome` beside it is held in a `useMemo` for the same reason; a fresh object there
 * would defeat this on its own.
 */
const TreeRow = memo(function TreeRow(
  props: { node: TreeNode; chrome: SessionsTreeChrome },
): React.JSX.Element {
  const { node, chrome } = props
  if (node.kind === 'category')
    return (
      <GroupRow
        node={node}
        launch={node.categoryId === null
          ? null
          : { category: node.categoryId }}
        chrome={chrome}
      />
    )
  else if (node.kind === 'project')
    return (
      <GroupRow
        node={node}
        title={node.path}
        launch={node.launch === null
          ? null
          : {
              prefill: {
                binding: {
                  mode: 'project',
                  categoryId: node.launch.categoryId,
                  projectName: node.launch.projectName,
                  projectPath: node.launch.projectPath,
                },
              },
            }}
        chrome={chrome}
      />
    )
  else if (node.kind === 'session')
    return <SessionRow node={node} chrome={chrome} />
  else
    throw new Error(`Unknown tree node: ${JSON.stringify(node)}`)
})

/**
 * A root or a project: the same row, with only the name and the actions that belong to it.
 *
 * The twisty is a button and the launch action is a button, so it sits beside it rather than inside
 * it - a button within a button is not markup a browser keeps.
 */
function GroupRow(props: {
  node: GroupTreeNode
  title?: string
  launch?: LauncherIntent | null
  chrome: SessionsTreeChrome
}): React.JSX.Element {
  const { node, chrome, launch = null } = props
  const open = !chrome.collapsed.has(node.id)
  return (
    <div>
      {/* On the row rather than on this container: the children hang in the sibling below, so a
          right-click on a project never bubbles a second menu out of its category's. */}
      <div
        className="jamat-sessions__group-row"
        onContextMenu={(event) => {
          event.preventDefault()
          chrome.openGroupMenu(GroupRowMenu.factsOf(node), { x: event.clientX, y: event.clientY })
        }}
      >
        <button
          className="jamat-sessions__group"
          type="button"
          title={props.title}
          aria-expanded={open}
          onClick={() => chrome.toggle(node.id)}
        >
          <span className="jamat-sessions__twisty" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="jamat-sessions__label">{node.label}</span>
        </button>
        {launch !== null && (
          <span className="jamat-sessions__group-actions">
            <LaunchButton intent={launch} label={node.label} chrome={chrome} />
          </span>
        )}
      </div>
      {open && (
        <div className="jamat-sessions__children">
          {node.children.map((child) => <TreeRow key={child.id} node={child} chrome={chrome} />)}
        </div>
      )}
    </div>
  )
}

/**
 * What a group row hands its menu: the place a new session would be started in, and the folder the
 * row holds. A category has the first and never the second; a project holds a folder whether or not
 * the catalog names it, which is why the two are read apart rather than as one "is this a project".
 */
class GroupRowMenu {
  static factsOf(node: GroupTreeNode): GroupRowFacts {
    if (node.kind === 'category')
      return {
        place: node.categoryId === null ? null : { kind: 'category', categoryId: node.categoryId },
        folder: null,
      }
    else if (node.kind === 'project')
      return {
        place: node.launch === null ? null : { kind: 'project', project: node.launch },
        folder: node.folderSessionId === null
          ? null
          : { path: node.path, sessionId: node.folderSessionId },
      }
    else
      throw new Error(`Unknown group node: ${JSON.stringify(node)}`)
  }
}

/**
 * The launcher opened knowing where. A project skips to New Session; a category opens the project
 * name strip in that root. The accessible name says which row, because the buttons carry one label.
 */
function LaunchButton(props: {
  intent: LauncherIntent
  label: string
  chrome: SessionsTreeChrome
}): React.JSX.Element {
  const { intent, label, chrome } = props
  return (
    <SessionsTreeActionButton
      label="+ Session"
      ariaLabel={`+ Session in ${label}`}
      onClick={() => chrome.launch(intent)}
    />
  )
}

/**
 * A session, and under it whatever was installed for it. The install is drawn nested rather than
 * beside it because it is something that happened TO this session: as a sibling it reads as a
 * second session the user started and does not recognise.
 */
function SessionRow(props: {
  node: SessionTreeNode
  chrome: SessionsTreeChrome
}): React.JSX.Element {
  const { node, chrome } = props
  // What the panel is asked at a glance: of everything listed here, which one am I in. The row says
  // it, not the title, because the tint is about the whole line and a person reads the line.
  const targetKey = TerminalTargetCodec.key(node.target)
  const inFront = chrome.inFront === targetKey
  const marked = node.badges.attention
  const inlineActions = SessionsTreeActions.inlineOf(node, chrome.pending)
  const confirming = inlineActions.some((action) =>
    SessionsTreeActions.isArmed(node, action, chrome.pending))
  const flash = useSessionStateFlash(node.glyph)
  return (
    <div className="jamat-sessions__session" data-session={targetKey}>
      {/* On the row rather than on this container, so a right-click on a nested install lands on
          the install's own row and never bubbles a second menu out of its parent's. */}
      <div
        className={`jamat-sessions__row${inFront ? ' jamat-sessions__row--in-front' : ''}${
          confirming ? ' jamat-sessions__row--confirming' : ''}`}
        aria-current={inFront ? 'true' : undefined}
        data-session-color={node.color ?? undefined}
        onContextMenu={(event) => {
          event.preventDefault()
          chrome.openMenu(node, { x: event.clientX, y: event.clientY })
        }}
      >
        {/* The one-shot tint that says this row's state moved. An element of its own rather than a
            class on the row, because the key is what restarts it, and it lies UNDER the text and
            over every background rule above: a session's own colour and the current-row tint are
            facts about this line that a blink is not allowed to erase. */}
        {flash > 0 && (
          <span key={flash} className="jamat-sessions__flash" aria-hidden="true" />
        )}
        <span
          className={`jamat-sessions__glyph jamat-sessions__glyph--paint-${
            node.badges.commitOpen ? 'danger' : SessionNodeState.paintOf(node.glyph, marked)}`}
          data-glyph={node.glyph}
          data-paint={node.badges.commitOpen ? 'danger' : SessionNodeState.paintOf(node.glyph, marked)}
          title={node.badges.commitOpen ? 'Commit review required' : SessionNodeState.glyphTitleOf(node.glyph, marked)}
          aria-label={node.badges.commitOpen ? 'Commit review required' : SessionNodeState.glyphTitleOf(node.glyph, marked)}
        >
          <SignalGlyph glyph={node.badges.commitOpen ? '!' : SessionNodeState.characterOf(node.glyph, marked)} />
        </span>
        <button
          type="button"
          className="jamat-sessions__title"
          disabled={!node.interactive}
          title={node.note === null ? node.title : `${node.title}\n\n${node.note}`}
          onClick={() => chrome.openTerminal(node.target, node.tabTitle, 'preview')}
          onDoubleClick={() => chrome.openTerminal(node.target, node.tabTitle, 'permanent')}
        >
          {node.title}
        </button>
        <Badges badges={node.badges} />
        <Pills glyph={node.glyph} badges={node.badges} />
        {node.glyph === 'ended' && (
          <ExitPill
            outcome={node.outcome}
            exitCode={node.exitCode}
            endedReason={node.endedReason}
          />
        )}
        {node.setup !== null && (
          <span
            className={`jamat-sessions__setup jamat-sessions__setup--${node.setup}`}
            data-setup={node.setup}
            title={node.setupTitle ?? undefined}
          >
            {SessionsTreeGlyphs.setupTextOf(node.setup)}
          </span>
        )}
        {node.launch !== null && (
          <span
            className={`jamat-sessions__launch jamat-sessions__launch--${node.launch}`}
            data-launch={node.launch}
            title={node.launchTitle ?? undefined}
          >
            {SessionsTreeGlyphs.launchTextOf(node.launch)}
          </span>
        )}
        {node.merge !== null && (
          <span
            className={`jamat-sessions__merge jamat-sessions__merge--${node.merge}`}
            data-merge={node.merge}
            title={node.mergeTitle ?? undefined}
            aria-label={node.mergeTitle ?? undefined}
          >
            {SessionsTreeGlyphs.mergeTextOf(node.merge)}
          </span>
        )}
        <span className="jamat-sessions__actions">
          {inlineActions.map((action) => (
            <ActionButton
              key={action}
              node={node}
              action={action}
              label={action === 'finalize' ? node.finalizeLabel : null}
              chrome={chrome}
            />
          ))}
        </span>
      </div>
      {node.children.length > 0 && (
        <div className="jamat-sessions__children">
          {node.children.map((child) => <TreeRow key={child.id} node={child} chrome={chrome} />)}
        </div>
      )}
    </div>
  )
}

function Badges(props: { badges: SessionBadges }): React.JSX.Element {
  const { badges } = props
  return (
    <>
      {badges.agentId !== null && (
        <span className="jamat-sessions__agent" title={badges.agentId}>
          {AgentGlyph.markOf(badges.agentId)}
        </span>
      )}
      {badges.worktree !== null && <WorktreeMark worktree={badges.worktree} />}
      {(badges.vcs !== null || badges.commitOpen) && (
        <span
          className={`jamat-sessions__vcs${badges.commitOpen ? ' is-commit-open' : ''}`}
          title={badges.commitOpen ? 'Commit dialog open' : `Uncommitted changes (${badges.vcs})`}
          aria-label={badges.commitOpen ? 'Commit dialog open' : `Uncommitted changes (${badges.vcs})`}
        >
          *
        </span>
      )}
    </>
  )
}

/**
 * The one place the unseen mark is NOT on the character: a lost runtime is drawn in danger at the
 * top of the ladder, so its colour cannot also say whether anybody has looked. The pill every lost
 * row already carries takes that job instead - full danger while unseen, dimmed once seen - so the
 * row still gains no mark of its own.
 */
function InterruptedPill(props: { unseen: boolean }): React.JSX.Element {
  const title = props.unseen
    ? "The session's runtime disappeared without exiting - not seen since"
    : "The session's runtime disappeared without exiting"
  return (
    <span
      className={`jamat-sessions__pill jamat-sessions__pill--interrupted${
        props.unseen ? '' : ' jamat-sessions__pill--interrupted-seen'}`}
      title={title}
      aria-label={title}
    >
      interrupted
    </span>
  )
}

/**
 * The words a row carries beside its glyph. `interrupted` is what the red mark means and the reason
 * such a row is in the daily view at all; the other two say which of the two things the row is and
 * whether the person is done with it.
 */
function Pills(props: { glyph: SessionGlyph; badges: SessionBadges }): React.JSX.Element {
  const { glyph, badges } = props
  return (
    <>
      {glyph === 'lost' && <InterruptedPill unseen={badges.attention} />}
      {badges.plainTab && (
        <span
          className="jamat-sessions__pill jamat-sessions__pill--tab"
          title="Lives only as a tab; not part of the tree's flows"
          aria-label="Lives only as a tab; not part of the tree's flows"
        >
          tab
        </span>
      )}
      {badges.completed && (
        <span
          className="jamat-sessions__pill jamat-sessions__pill--completed"
          title="Marked completed by you"
          aria-label="Marked completed by you"
        >
          completed
        </span>
      )}
    </>
  )
}

/**
 * How it ended, drawn from the verdict rather than from the number.
 *
 * A session somebody finished is killed to end it, so its code is whatever the platform gives a
 * killed process - `0xC000013A` on Windows. Reading the number here is what put a red `exit
 * -1073741510` beside a `completed` pill on the same row, two statements contradicting each other
 * about one session. The code is still shown where it means something, which is a session that
 * ended by itself and failed; a finished one keeps it in the tooltip and says nothing.
 */
function ExitPill(props: {
  outcome: SessionOutcome | null
  exitCode: number | null
  endedReason: string | null
}): React.JSX.Element | null {
  const { outcome, exitCode, endedReason } = props
  const code = exitCode === null ? 'no exit code' : `exit ${exitCode}`
  if (outcome === 'finished')
    return (
      <span
        className="jamat-sessions__pill jamat-sessions__exit jamat-sessions__pill--exit-clean"
        title={code}
      >
        finished
      </span>
    )
  // `interrupted` is already the row's own pill beside this one, so saying it twice adds nothing.
  else if (outcome === 'interrupted' || outcome === null) return null
  else if (outcome === 'failed')
    return (
      <span
        className="jamat-sessions__pill jamat-sessions__exit jamat-sessions__pill--exit"
        title={endedReason ?? undefined}
      >
        {code}
      </span>
    )
  else
    throw new Error(`Unknown session outcome: ${JSON.stringify(outcome)}`)
}

/** No diff drawn at all until one has been measured: `+0 -0` is a measurement, absence is not. */
function WorktreeMark(props: { worktree: WorktreeBadge }): React.JSX.Element {
  const { worktree } = props
  // The branch alone left the numbers beside it unexplained: they are lines against the base the
  // worktree was cut from, not a count of anything on screen.
  const title = worktree.diff === null
    ? `Branch ${worktree.branch}`
    : `Branch ${worktree.branch} - +${worktree.diff.added} -${worktree.diff.removed} lines vs base`
  return (
    <span className="jamat-sessions__worktree" title={title} aria-label={title}>
      {worktree.diff !== null && (
        <span>{`+${worktree.diff.added} -${worktree.diff.removed}`}</span>
      )}
      {worktree.baseMoved && (
        <span
          className="jamat-sessions__base"
          title="The branch this worktree was cut from has moved on"
          aria-label="The branch this worktree was cut from has moved on"
        >
          BASE
        </span>
      )}
    </span>
  )
}

/** The name comes with the click: acting on a row shows it, and a tab is opened under a name. */
function ActionButton(props: {
  node: SessionTreeNode
  action: SessionAction
  /** The row's own wording where the action has one; null takes the action's plain name. */
  label: string | null
  chrome: SessionsTreeChrome
}): React.JSX.Element {
  const { node, action, label, chrome } = props
  const targetKey = TerminalTargetCodec.key(node.target)
  const confirms = SessionsTreeActions.confirms(node, action)
  const armed = SessionsTreeActions.isArmed(node, action, chrome.pending)
  const busy = chrome.inFlight.has(SessionsTreeActions.keyOf(targetKey, action))
    || (action === 'finalize' && chrome.awaitingAsk.has(targetKey))
  return (
    <SessionsTreeActionButton
      label={armed
        ? SessionsTreeActions.confirmLabelOf(action, label)
        : label ?? SessionNodeState.actionLabelOf(action)}
      armed={armed}
      // Dead while its own call is out. `reopen`, `retrySetup` and `adoptOrphan` act on the FIRST
      // click, so without this a second one fires a second call, and the library - which runs one
      // operation at a time - refuses it for an action that had already worked.
      disabled={busy}
      // The marker is on both steps of a two-click action: the click that ARMS it must not be the
      // click that cancels it.
      confirm={confirms ? action : undefined}
      onClick={() => chrome.request(node, action)}
    />
  )
}

function Orphans(props: {
  orphans: readonly OrphanInfo[]
  open: boolean
  onToggle(): void
  onAdopt(runtimeSessionId: string): void
}): React.JSX.Element {
  return (
    <div>
      <button
        className="jamat-sessions__foot-button"
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        {`Orphans (${props.orphans.length})`}
      </button>
      {props.open && props.orphans.map((orphan) => (
        <div className="jamat-sessions__orphan" key={orphan.runtimeSessionId}>
          <span className="jamat-sessions__orphan-id">{orphan.runtimeSessionId}</span>
          <button
            className="jamat-sessions__foot-button"
            type="button"
            onClick={() => props.onAdopt(orphan.runtimeSessionId)}
          >
            Adopt
          </button>
        </div>
      ))}
    </div>
  )
}

class SessionsTreeChoices {
  static toggled(collapsed: ReadonlySet<string>, nodeId: string): ReadonlySet<string> {
    const next = new Set(collapsed)
    if (!next.delete(nodeId))
      next.add(nodeId)
    return next
  }
}

class SessionsTreeActions {
  /**
   * A running Finish takes a runtime away. Remove starts in the context menu and temporarily becomes
   * the row's sole button; ended Finish opens a dialog on its first click.
   */
  private static readonly confirmedConst: readonly SessionAction[] =
    ['finalize', 'remove']

  static confirms(node: SessionTreeNode, action: SessionAction): boolean {
    return SessionsTreeActions.confirmedConst.includes(action)
      && (action !== 'finalize' || node.live)
  }

  static isArmed(
    node: SessionTreeNode,
    action: SessionAction,
    pending: PendingConfirm | null,
  ): boolean {
    return SessionsTreeActions.confirms(node, action)
      && pending?.targetKey === TerminalTargetCodec.key(node.target)
      && pending.action === action
      && pending.live === node.live
      && pending.endedAt === node.endedAt
  }

  /** One operation, named the same way wherever it is tracked: in flight, and on its error line. */
  static keyOf(targetKey: string, action: SessionAction): string {
    return `${targetKey}:${action}`
  }

  static inlineOf(
    node: SessionTreeNode,
    pending: PendingConfirm | null,
  ): readonly SessionAction[] {
    const targetKey = TerminalTargetCodec.key(node.target)
    if (pending?.targetKey === targetKey && pending.action === 'remove') return ['remove']
    return node.actions.filter((action) => {
      if (action === 'finalize') return true
      else if (action === 'reopen' || action === 'remove' || action === 'retrySetup') return false
      else
        throw new Error(`Unknown session action: ${JSON.stringify(action)}`)
    })
  }

  static confirmLabelOf(action: SessionAction, label: string | null): string {
    return `${label ?? SessionNodeState.actionLabelOf(action)}?`
  }
}

class SessionsTreeOperation {
  /**
   * The commands and the hash of a `setup-not-acknowledged`, or null for every other answer. It is
   * read off the result rather than off a code alone, because the payload IS the reason that code
   * exists: without the commands there is nothing to show and without the hash nothing to answer.
   */
  static setupAskOf(
    answer: IpcResult<SessionsOpResult>,
  ): SessionSetupAgreement | null {
    if (!answer.ok || answer.value.ok) return null
    if (answer.value.code !== 'setup-not-acknowledged') return null
    return answer.value.setup ?? null
  }

  /** Both shapes, local and remote, are `IpcFailure`'s to read; this only names the operation. */
  static failureOf(
    answer: IpcResult<SessionsOpResult | RemoteControlResponse>,
    label: string,
  ): string | null {
    return IpcFailure.of(answer, label)
  }
}

class RemoteSessionMenu {
  static items(
    node: SessionTreeNode,
    chrome: SessionsTreeChrome,
    commands: CommandRegistry,
  ): readonly { key: string; label: string; onSelect(): void }[] {
    const items = [{
      key: 'open',
      label: 'Open',
      onSelect: () => chrome.openTerminal(node.target, node.tabTitle, 'permanent'),
    }]
    // The one catalog command a remote row runs, and it runs the SAME one a local row does: what is
    // copied is composed from the snapshot this computer already holds, so the endpoint is the whole
    // of the difference. Its title is read off the catalog rather than repeated here.
    const endpointId = TerminalTargetCodec.endpointOf(node.target)
    if (endpointId === null)
      throw new Error(`A remote row was drawn for a local session: ${node.sessionId}`)
    items.push({ key: 'disconnect', label: 'Disconnect',
      onSelect: () => chrome.disconnect(endpointId, [node.sessionId]) })
    items.push({
      key: 'copy-reference',
      label: AppCommands.byId('session.copyReference').title,
      onSelect: () => commands.execute('session.copyReference', {
        sessionId: node.sessionId,
        remoteEndpointId: endpointId,
      }),
    })
    for (const action of node.actions)
      items.push({
        key: action,
        label: action === 'finalize'
          ? node.finalizeLabel ?? SessionNodeState.actionLabelOf(action)
          : SessionNodeState.actionLabelOf(action),
        onSelect: () => chrome.request(node, action),
      })
    return items
  }
}

/**
 * The two things a connected computer's row offers. Neither acts on a session, which is why this is
 * a menu of its own rather than items filtered out of the session one.
 */
class RemoteComputerMenu {
  static items(
    menu: Extract<TreeMenuState, { kind: 'remote-computer' }>,
    chrome: SessionsTreeChrome,
  ): readonly { key: string; label: string; onSelect(): void }[] {
    return [
      {
        key: 'new-session',
        label: 'New session…',
        // The target is already known here, so the card has no computer to ask about. Writing the
        // intent is the whole of it: what the launcher then does with it is the launcher's.
        onSelect: () => chrome.launch({
          purpose: 'remote',
          remote: { remoteEndpointId: menu.remoteEndpointId, displayName: menu.displayName },
        }),
      },
      {
        key: 'disconnect',
        label: 'Disconnect',
        onSelect: () => chrome.disconnect(menu.remoteEndpointId),
      },
      {
        key: 'connect-session',
        label: 'Connect session…',
        onSelect: () => chrome.launch({ purpose: 'remote' }),
      },
      {
        key: 'remote-settings',
        // Where everything this row does NOT say is read: a computer that is offline has no row in
        // the tree at all, and the settings card is where its last success, its next retry, its
        // version and a manual retry live.
        label: 'Open Remote connections settings',
        onSelect: () => chrome.openSettings('remoteControlConnections'),
      },
    ]
  }
}

class SessionsTreeGlyphs {
  /** One word, the same shape the install badge beside it uses. */
  static mergeTextOf(merge: SessionMergeBadge): string {
    if (merge === 'merging') return 'merging…'
    else if (merge === 'conflict') return 'conflict'
    else if (merge === 'merge-failed') return 'merge failed'
    else
      throw new Error(`Unknown session merge badge: ${JSON.stringify(merge)}`)
  }

  /**
   * Two words rather than one, because the row already says `starting` and this is what corrects it:
   * nothing is starting while the Host is still refusing the launch. Why it is refused is in the
   * title, which carries the Host's own sentence.
   */
  static launchTextOf(launch: SessionLaunchBadge): string {
    if (launch === 'waiting') return 'waiting for the host'
    else
      throw new Error(`Unknown session launch badge: ${JSON.stringify(launch)}`)
  }

  static setupTextOf(setup: SessionSetupBadge): string {
    if (setup === 'installing') return 'installing…'
    else if (setup === 'install-failed') return 'install failed'
    // One character and not two words: a skipped setup is the steady state of every project with no
    // known family, so it sat on most rows and crowded out the marks that change. The words it lost
    // are in the title, which is why `setupTitleOf` says what happened as well as why.
    else if (setup === 'install-skipped') return '∅'
    else
      throw new Error(`Unknown session setup badge: ${JSON.stringify(setup)}`)
  }
}
