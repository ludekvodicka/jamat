import type {
  SessionOperation,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppCommands, type CommandDescriptor, type CommandId } from '../../../shared/commands'
import type { CommandRegistry } from '../../commands/commandRegistry'
import { SessionCommandRun } from '../../commands/sessionCommandRun'
import { CommandMenuEntries } from '../../widgets/commandMenuEntries'
import {
  ContextMenu,
  type ContextMenuAction,
  type ContextMenuEntry,
  type ContextMenuPosition,
  type ContextMenuSubmenu,
} from '../../widgets/contextMenu'
import type { TabSessionFacts } from '../../widgets/tabs/tabContextMenu'
import { type SessionAction, SessionNodeState } from './sessionNodeState'
import type { ScriptRunNode, ScriptRunOpen } from './sessionsTreeModel'

/**
 * The session row's menu. Its general commands come from the same catalog as the tab menu, followed
 * by the secondary operations currently admitted for this session. Every command runs with the
 * CLICKED row's session, which may have no tab open in this window at all. The container class is
 * the tab menu's on purpose: one builder, one stylesheet, one look.
 */
export function SessionsTreeContextMenu(props: {
  position: ContextMenuPosition
  commands: CommandRegistry
  /** The clicked row's session; every executed command names it. */
  sessionId: string
  /** What that session is, captured when the menu opened: a menu lives for a moment. */
  facts: TabSessionFacts
  actions: readonly SessionAction[]
  /** The `Scripts` submenu; absent or null for a session that has no run to list. */
  scripts?: ContextMenuSubmenu | null
  groupItem?: ContextMenuEntry
  /** Brings the session's workflow forward; absent for a session without one or on a peer. */
  onShowWorkflow?: () => void
  onAction(action: SessionAction): void
  onClose(): void
}): React.JSX.Element {
  return (
    <ContextMenu
      position={props.position}
      ariaLabel="Session actions"
      className="jamat-tab-menu"
      items={SessionsTreeMenuItems.forNode(
        props.commands,
        props.sessionId,
        props.facts,
        props.actions,
        props.scripts ?? null,
        props.onAction,
        props.onShowWorkflow ?? null,
      ).flatMap((item) => item.key === 'session.setColor' && props.groupItem !== undefined
        ? [item, props.groupItem] : [item])}
      onClose={props.onClose}
    />
  )
}

/**
 * Which catalog commands and current operations apply to THIS row. The command gates mirror the tab
 * menu's one for one, minus the "is this tab a session's" question the tree never has to ask: every
 * row here IS a session.
 */
class SessionsTreeMenuItems {
  static forNode(
    commands: CommandRegistry,
    sessionId: string,
    facts: TabSessionFacts,
    actions: readonly SessionAction[],
    scripts: ContextMenuSubmenu | null,
    onAction: (action: SessionAction) => void,
    showWorkflow: (() => void) | null,
  ): readonly ContextMenuEntry[] {
    const commandItems = CommandMenuEntries.of(
      SessionsTreeMenuItems.applicable(facts),
      facts.color,
      {
        run: (id) => SessionsTreeMenuItems.run(commands, id, sessionId),
        setColor: (color) => commands.execute('session.setColor', { color, sessionId }),
      },
    )
    const operations = [
      ...(showWorkflow === null ? [] : [{ key: 'tree-showWorkflow', label: 'Show workflow', onSelect: showWorkflow }]),
      ...(scripts === null ? [] : [scripts]),
      ...SessionsTreeMenuItems.operations(actions, onAction),
    ]
    if (operations.length === 0) return commandItems
    return [
      ...commandItems,
      { kind: 'separator', key: 'tree-operations' },
      ...operations,
    ]
  }

  private static operations(
    actions: readonly SessionAction[],
    onAction: (action: SessionAction) => void,
  ): readonly ContextMenuEntry[] {
    const items: ContextMenuEntry[] = []
    for (const action of actions) {
      // Finish and Close are the row's own buttons, and Rerun is `Resume session` in the block above
      // since 2026-09-10: the catalog item opens the card that says what it will bring back.
      if (action === 'finalize' || action === 'close' || action === 'reopen') continue
      else if (action === 'retrySetup' || action === 'remove' || action === 'updateMain')
        items.push({
          key: `tree-${action}`,
          label: action === 'remove' ? 'Remove…' : SessionNodeState.actionLabelOf(action),
          onSelect: () => onAction(action),
        })
      else
        throw new Error(`Unknown session action: ${JSON.stringify(action)}`)
    }
    return items
  }

  private static applicable(facts: TabSessionFacts): readonly CommandDescriptor[] {
    const admits = (operation: SessionOperation): boolean => facts.admits.includes(operation)
    // The four that open the create card need a place to open it on, which a session founded with no
    // directory at all does not have.
    const placed = facts.directoryPath !== null
    return AppCommands.forSurface('sessionsTree')
      // No gate on details, setColor or openProjectFolder: renaming and colouring ask nothing of
      // the runtime, so an ended or lost session keeps both, and the folder tab needs only the
      // session the row already is.
      .filter((descriptor) => descriptor.id !== 'session.newBeside'
        || placed && admits('newBeside'))
      // Only ever the OTHER agent: the one this session already runs is not an alternative to itself.
      .filter((descriptor) => descriptor.id !== 'session.newInClaude'
        || placed && admits('newBeside') && facts.agentId === 'codex')
      .filter((descriptor) => descriptor.id !== 'session.newInCodex'
        || placed && admits('newBeside') && facts.agentId === 'claude')
      .filter((descriptor) => descriptor.id !== 'session.fork' || placed && admits('fork'))
      // Resume uses the selected record directly; only creation commands need a launcher binding.
      .filter((descriptor) => descriptor.id !== 'session.resume'
        || admits('restart') && facts.ended)
      .filter((descriptor) => descriptor.id !== 'session.restart'
        || admits('restart') && !facts.ended)
      .filter((descriptor) => descriptor.id !== 'session.compact' || admits('compact'))
      .filter((descriptor) => (descriptor.id !== 'session.commitSvn' && descriptor.id !== 'session.commitGit') || facts.live)
      .filter((descriptor) => (descriptor.id !== 'tab.copyProjectFolder' && descriptor.id !== 'session.openInVsCode')
        || facts.directoryPath !== null)
  }

  /**
   * Every plain item of this surface takes the optional target, and the case list is what tells
   * the type system so. A command that joins the surface without joining this list fails the click
   * loudly instead of quietly acting on the active tab of some other row's window.
   */
  private static run(commands: CommandRegistry, id: CommandId, sessionId: string): void {
    SessionCommandRun.at(commands, id, sessionId)
  }
}

/**
 * The `Scripts ›` submenu: every run of a session, newest first, in the library's own lines. A row
 * still has its terminal; a finished run has only its log, and a log is local to the computer that
 * ran it, so a remote session lists its rows alone.
 */
export class SessionsTreeScriptsMenu {
  static itemOf(
    runs: readonly ScriptRunNode[],
    scope: 'local' | 'remote',
    openTerminal: (open: ScriptRunOpen) => void,
    /** Null while this build has no log viewer: a saved log is then listed but cannot be opened. */
    openLog: ((runId: string) => void) | null,
  ): ContextMenuSubmenu | null {
    const listed = scope === 'local' ? runs : runs.filter((run) => run.open !== null)
    if (listed.length === 0) return null
    return {
      key: 'tree-scripts',
      label: 'Scripts',
      children: listed.map((run) => SessionsTreeScriptsMenu.runItemOf(run, openTerminal, openLog)),
    }
  }

  private static runItemOf(
    run: ScriptRunNode,
    openTerminal: (open: ScriptRunOpen) => void,
    openLog: ((runId: string) => void) | null,
  ): ContextMenuAction {
    const item = { key: `script-${run.runId}`, label: run.summary, title: run.logDetail }
    const open = run.open
    if (open !== null) return { ...item, onSelect: () => openTerminal(open) }
    const log = run.log
    if (log === 'saved')
      return openLog === null
        ? { ...item, disabled: true, onSelect: () => {} }
        : { ...item, onSelect: () => openLog(run.runId) }
    else if (log === 'unavailable' || log === 'none') return { ...item, disabled: true, onSelect: () => {} }
    else
      throw new Error(`Unknown script log state: ${JSON.stringify(log satisfies never)}`)
  }
}
