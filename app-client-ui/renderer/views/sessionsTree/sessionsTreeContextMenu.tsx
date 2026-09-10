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
import type { TabSessionFacts } from '../../widgets/tabs/tabContextMenu'
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
      SessionsTreeMenuItems.applicable(facts, plainTab),
      facts.color,
      {
        run: (id) => SessionsTreeMenuItems.run(commands, id, sessionId),
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
      // Finish is the row's own button, and Rerun is `Resume session` in the block above since
      // 2026-09-10: the catalog item opens the card that says what it will bring back.
      if (action === 'finalize' || action === 'reopen') continue
      else if (action === 'retrySetup' || action === 'remove')
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
  ): readonly CommandDescriptor[] {
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
      // A live row gets the stop-and-reopen command; an ended row gets the card that brings it back.
      // Never both: it is one operation asked at two moments, and Rerun - the row action that used
      // to be the ended half - left the block below when Resume arrived.
      .filter((descriptor) => descriptor.id !== 'session.resume'
        || placed && admits('restart') && facts.ended)
      .filter((descriptor) => descriptor.id !== 'session.restart'
        || admits('restart') && !facts.ended)
      .filter((descriptor) => descriptor.id !== 'session.compact' || admits('compact'))
      .filter((descriptor) => (descriptor.id !== 'session.commitSvn' && descriptor.id !== 'session.commitGit') || facts.live)
      .filter((descriptor) => descriptor.id !== 'tab.copyProjectFolder'
        || facts.directoryPath !== null)
      .filter((descriptor) => descriptor.id !== 'tab.promote' || plainTab)
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
