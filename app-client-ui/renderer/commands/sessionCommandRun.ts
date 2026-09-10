import type { CommandId } from '../../shared/commands'
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
   * Every command whose target is a session. All of them take an id and nothing else: the one that
   * took a PLACE, `session.newHere`, belongs to a project row now, and the row's own menu runs it.
   */
  private static readonly targetedConst: ReadonlySet<CommandId> = new Set<CommandId>([
    'session.details',
    'session.newBeside',
    'session.newInClaude',
    'session.newInCodex',
    'session.fork',
    'session.resume',
    'session.restart',
    'session.compact',
    'session.commitSvn',
    'session.commitGit',
    'tab.openProjectFolder',
    'tab.copyProjectFolder',
    'session.copyReference',
    'tab.promote',
  ])

  static targets(id: CommandId): boolean {
    return SessionCommandRun.targetedConst.has(id)
  }

  static at(commands: CommandRegistry, id: CommandId, sessionId: string): void {
    switch (id) {
      case 'session.details':
      case 'session.newBeside':
      case 'session.newInClaude':
      case 'session.newInCodex':
      case 'session.fork':
      case 'session.resume':
      case 'session.restart':
      case 'session.compact':
      case 'session.commitSvn':
      case 'session.commitGit':
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
