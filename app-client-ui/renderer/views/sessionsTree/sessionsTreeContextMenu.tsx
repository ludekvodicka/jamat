import type {
  SessionOperation,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppCommands, type CommandDescriptor, type CommandId } from '../../../shared/commands'
import type { CommandRegistry } from '../../commands/commandRegistry'
import { SessionCommandRun } from '../../commands/sessionCommandRun'
import { CommandMenuEntries } from '../../widgets/commandMenuEntries'
import {
  ContextMenu,
  type ContextMenuEntry,
  type ContextMenuPosition,
} from '../../widgets/contextMenu'
import { type TabSessionFacts, TabSessionPlace } from '../../widgets/tabs/tabContextMenu'
import { type SessionAction, SessionNodeState } from './sessionNodeState'

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
  /** Whether the row is a plain tab's, which is the one row "Keep as a session" is for. */
  plainTab: boolean
  actions: readonly SessionAction[]
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
        props.plainTab,
        props.actions,
        props.onAction,
      )}
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
    plainTab: boolean,
    actions: readonly SessionAction[],
    onAction: (action: SessionAction) => void,
  ): readonly ContextMenuEntry[] {
    const commandItems = CommandMenuEntries.of(
      SessionsTreeMenuItems.applicable(facts, plainTab, actions),
      facts.color,
      {
        run: (id) => SessionsTreeMenuItems.run(commands, id, sessionId, facts),
        setColor: (color) => commands.execute('session.setColor', { color, sessionId }),
      },
    )
    const operations = SessionsTreeMenuItems.operations(actions, onAction)
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
      if (action === 'finalize') continue
      else if (action === 'reopen' || action === 'retrySetup' || action === 'remove')
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

  private static applicable(
    facts: TabSessionFacts,
    plainTab: boolean,
    actions: readonly SessionAction[],
  ): readonly CommandDescriptor[] {
    const admits = (operation: SessionOperation): boolean => facts.admits.includes(operation)
    return AppCommands.forSurface('sessionsTree')
      // No gate on details, setColor or openProjectFolder: renaming and colouring ask nothing of
      // the runtime, so an ended or lost session keeps both, and the folder tab needs only the
      // session the row already is.
      // The launcher creates from scratch rather than beside this session, so `admits` says nothing
      // about it either; what it needs is a project to pre-bind to.
      .filter((descriptor) => descriptor.id !== 'session.newHere' || facts.launch !== null)
      .filter((descriptor) => descriptor.id !== 'session.newBlank' || admits('newBeside'))
      // Only ever the OTHER agent: the one this session already runs is not an alternative to itself.
      .filter((descriptor) => descriptor.id !== 'session.newInClaude'
        || admits('newBeside') && facts.agentId === 'codex')
      .filter((descriptor) => descriptor.id !== 'session.newInCodex'
        || admits('newBeside') && facts.agentId === 'claude')
      .filter((descriptor) => descriptor.id !== 'session.fork' || admits('fork'))
      // A live row gets the stop-and-reopen command. An ended row appends the same capability below
      // as Rerun, so drawing the catalog item there would offer one operation twice under two names.
      .filter((descriptor) => descriptor.id !== 'session.restart'
        || admits('restart') && !actions.includes('reopen'))
      .filter((descriptor) => descriptor.id !== 'session.compact' || admits('compact'))
      .filter((descriptor) => descriptor.id !== 'tab.copyProjectFolder'
        || facts.directoryPath !== null)
      .filter((descriptor) => descriptor.id !== 'tab.promote' || plainTab)
  }

  /**
   * Every plain item of this surface takes the optional target, and the case list is what tells
   * the type system so. A command that joins the surface without joining this list fails the click
   * loudly instead of quietly acting on the active tab of some other row's window.
   */
  private static run(
    commands: CommandRegistry,
    id: CommandId,
    sessionId: string,
    facts: TabSessionFacts,
  ): void {
    // The launcher's place is the one thing the shared runner cannot derive: it opens pre-bound to
    // the project this row's session belongs to, and starts nothing by itself.
    SessionCommandRun.at(
      commands,
      id,
      sessionId,
      facts.launch === null ? null : TabSessionPlace.of(facts),
    )
  }
}
