import type { CommandId, NewSessionPlace } from '../../shared/commands'
import type { CommandRegistry } from './commandRegistry'

/**
 * Running a menu command AT a named session, rather than at whatever is active when it is clicked.
 *
 * The sessions tree always did this - its rows are not the active tab, so it had no choice. The tab
 * menu ran everything bare on the ground that it activates its tab before opening, which is true at
 * the moment it opens and stops being true a moment later: `app-client-cli` or a peer sending
 * `open-session` or `focus-panel` activates another panel with no focus change, the window's `blur`
 * listener therefore does not close the menu, and the next click lands on the session that arrived.
 * The items were drawn for one session and the confirm dialog names none, so nothing on screen says
 * otherwise.
 */
export class SessionCommandRun {
  /**
   * Every command whose target is a session. `session.newHere` is in the list and takes a PLACE
   * rather than an id: it opens the launcher pre-bound to the row's project and starts nothing.
   */
  private static readonly targetedConst: ReadonlySet<CommandId> = new Set<CommandId>([
    'session.newHere',
    'session.details',
    'session.newBlank',
    'session.newInClaude',
    'session.newInCodex',
    'session.fork',
    'session.restart',
    'session.compact',
    'tab.openProjectFolder',
    'tab.copyProjectFolder',
    'session.copyReference',
    'tab.promote',
  ])

  static targets(id: CommandId): boolean {
    return SessionCommandRun.targetedConst.has(id)
  }

  static at(
    commands: CommandRegistry,
    id: CommandId,
    sessionId: string,
    place: NewSessionPlace | null,
  ): void {
    switch (id) {
      case 'session.newHere':
        if (place === null)
          throw new Error('A new session was asked for beside a session with no place')
        commands.execute(id, { place })
        return
      case 'session.details':
      case 'session.newBlank':
      case 'session.newInClaude':
      case 'session.newInCodex':
      case 'session.fork':
      case 'session.restart':
      case 'session.compact':
      case 'tab.openProjectFolder':
      case 'tab.copyProjectFolder':
      case 'session.copyReference':
      case 'tab.promote':
        commands.execute(id, { sessionId })
        return
      default:
        throw new Error(`${JSON.stringify(id)} cannot be aimed at a session`)
    }
  }
}
