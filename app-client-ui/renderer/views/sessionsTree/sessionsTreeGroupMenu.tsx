import {
  AppCommands,
  type CommandDescriptor,
  type CommandId,
  type NewSessionPlace,
} from '../../../shared/commands'
import type { CommandRegistry } from '../../commands/commandRegistry'
import { CommandMenuEntries } from '../../widgets/commandMenuEntries'
import {
  ContextMenu,
  type ContextMenuEntry,
  type ContextMenuPosition,
} from '../../widgets/contextMenu'

/**
 * What a group row is, as far as its menu needs to know: a place a session could be started in, and
 * - on a project row only - a folder to open or copy.
 *
 * Both are nullable and independently so, which is what the four kinds of group row need: a catalog
 * category has a place and no folder, an ad-hoc project row a folder and no place, an ordinary
 * project row both, and the AD-HOC and NO PROJECT roots neither.
 */
export interface GroupRowFacts {
  place: NewSessionPlace | null
  folder: { path: string; sessionId: string } | null
}

/**
 * The menu of the rows ABOVE a session - the category and the project. It is the session row's menu
 * built the same way out of the same catalog, and it is a second surface rather than a filter on the
 * first because the rows are two different things: nothing that acts on a session can act here, and
 * nothing here acts on one.
 */
export function SessionsTreeGroupMenu(props: {
  position: ContextMenuPosition
  commands: CommandRegistry
  /** What the clicked row is, captured when the menu opened: a menu lives for a moment. */
  facts: GroupRowFacts
  onClose(): void
}): React.JSX.Element {
  return (
    <ContextMenu
      position={props.position}
      ariaLabel="Project actions"
      className="jamat-tab-menu"
      items={SessionsTreeGroupItems.forRow(props.commands, props.facts)}
      onClose={props.onClose}
    />
  )
}

export class SessionsTreeGroupItems {
  static forRow(
    commands: CommandRegistry,
    facts: GroupRowFacts,
  ): readonly ContextMenuEntry[] {
    return CommandMenuEntries.of(
      SessionsTreeGroupItems.applicable(facts),
      // No row here carries a colour: a colour belongs to a session, and this menu has none.
      null,
      {
        run: (id) => SessionsTreeGroupItems.run(commands, id, facts),
        setColor: () => {
          throw new Error('A group row has no colour to set')
        },
      },
    )
  }

  /**
   * Whether a row offers anything at all, asked before the menu is opened: a right-click that draws
   * an empty box is worse than one that draws nothing. That is the AD-HOC and NO PROJECT roots,
   * which name no category and hold no path of their own.
   */
  static any(facts: GroupRowFacts): boolean {
    return SessionsTreeGroupItems.applicable(facts).length > 0
  }

  private static applicable(facts: GroupRowFacts): readonly CommandDescriptor[] {
    return AppCommands.forSurface('sessionsTreeGroup')
      .filter((descriptor) => descriptor.id !== 'session.newHere' || facts.place !== null)
      .filter((descriptor) => descriptor.id !== 'project.openFolder' || facts.folder !== null)
      .filter((descriptor) => descriptor.id !== 'project.copyFolderPath' || facts.folder !== null)
      // A category row names no project, and a project's own setup is a file inside one.
      .filter((descriptor) =>
        descriptor.id !== 'project.worktreeSetup' || facts.place?.kind === 'project')
  }

  private static run(commands: CommandRegistry, id: CommandId, facts: GroupRowFacts): void {
    switch (id) {
      case 'session.newHere':
        if (facts.place === null)
          throw new Error('A new session was asked for in a row that names no place')
        commands.execute(id, { place: facts.place })
        return
      case 'project.openFolder':
        if (facts.folder === null)
          throw new Error('A project folder was asked for in a row that holds none')
        commands.execute(id, facts.folder)
        return
      case 'project.copyFolderPath':
        if (facts.folder === null)
          throw new Error('A project folder was asked for in a row that holds none')
        commands.execute(id, { path: facts.folder.path })
        return
      case 'project.worktreeSetup':
        if (facts.place?.kind !== 'project')
          throw new Error('Worktree setup was asked for in a row that names no project')
        commands.execute(id, { project: facts.place.project })
        return
      default:
        throw new Error(`A group row of the sessions tree cannot run ${JSON.stringify(id)}`)
    }
  }
}
