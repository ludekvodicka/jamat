import type {
  SessionAgentId,
  SessionColorName,
  SessionOperation,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppCommands, type CommandDescriptor } from '../../../shared/commands'
import { PanelKeysConst } from '../../../shared/tabTransfer'
import type { CommandRegistry } from '../../commands/commandRegistry'
import { SessionCommandRun } from '../../commands/sessionCommandRun'
import { CommandMenuEntries } from '../commandMenuEntries'
import { ContextMenu, type ContextMenuPosition } from '../contextMenu'
import './tabContextMenu.css'

export type TabContextMenuPosition = ContextMenuPosition

/**
 * What this tab's session is, as far as the menu needs to know.
 *
 * `admits` is the library's answer and is never recomputed here: which operations make sense is a
 * question about the record, and a second derivation in a drawing surface is a copy that drifts.
 */
export interface TabSessionFacts {
  live: boolean
  agentId: SessionAgentId | null
  color: SessionColorName | null
  /** The directory to copy. `null` where there is nothing to copy, which is the default directory. */
  directoryPath: string | null
  /**
   * Whether this session has stopped - ended or lost. `admits` cannot answer it: `restart` is
   * admitted at both moments, and the two moments are two different menu items. Resume brings an
   * ended session back; Restart replaces the process of a live one.
   */
  ended: boolean
  admits: readonly SessionOperation[]
}

/**
 * The tab's menu, drawn by the renderer rather than by Electron. A native menu would need a second
 * path for commands the renderer already owns, and its items would be built in the main process
 * from the same catalog anyway. The items ARE the catalog: a command that declares the
 * 'contextMenu' surface appears here without this file changing.
 */
export function TabContextMenu(props: {
  position: TabContextMenuPosition
  commands: CommandRegistry
  panelKey: string | null
  /** The parameters of the tab the menu was opened on: some items only apply to some panels. */
  params: Record<string, unknown>
  /** What the tab's session is, or null where the tab has none. */
  facts: TabSessionFacts | null
  /** Whether this is the window's provisional tab, which is the only one worth keeping open. */
  preview: boolean
  onClose(): void
}): React.JSX.Element {
  return (
    <ContextMenu
      position={props.position}
      ariaLabel="Tab actions"
      className="jamat-tab-menu"
      items={CommandMenuEntries.of(
        TabContextMenuItems.forPanel(props.panelKey, props.params, props.facts, props.preview),
        props.facts?.color ?? null,
        {
          /*
           * Aimed at THIS tab's session, not at whatever is active when the item is clicked.
           *
           * Bare was defensible while the only way to change the active panel was to click, because
           * this menu activates its tab before opening. A remote controller does not click: an
           * `open-session` or `focus-panel` from `app-client-cli` or a peer activates another panel
           * with no focus change, so the window's `blur` listener leaves the menu standing - drawn
           * for session A, filtered against A's `admits`, and running on B.
           */
          run: (id) => {
            const sessionId = typeof props.params.sessionId === 'string'
              ? props.params.sessionId
              : null
            if (sessionId === null || !SessionCommandRun.targets(id)) {
              // Everything left here runs with no argument. A value-carrying command reaching this
              // branch is a catalog edit nobody followed through - `project.openFolder` gaining the
              // `contextMenu` surface is one word - and running it bare throws `undefined.path`
              // inside a React `onSelect`, where nothing catches it.
              if (AppCommands.carriesValue(id))
                throw new Error(`This menu cannot supply the value ${JSON.stringify(id)} needs`)
              props.commands.execute(id)
              return
            }
            SessionCommandRun.at(props.commands, id, sessionId)
          },
          setColor: (color) => props.commands.execute('session.setColor', {
            color,
            ...(typeof props.params.sessionId === 'string'
              ? { sessionId: props.params.sessionId }
              : {}),
          }),
        },
      )}
      onClose={props.onClose}
    />
  )
}

/**
 * Which of the catalog's context-menu commands apply to THIS tab. The catalog stays the source of
 * the items and `CommandMenuEntries` draws them; what neither can know is which panel the menu was
 * opened on and what the session behind it admits.
 */
class TabContextMenuItems {
  static forPanel(
    panelKey: string | null,
    params: Record<string, unknown>,
    facts: TabSessionFacts | null,
    preview: boolean,
  ): readonly CommandDescriptor[] {
    // A session panel and nothing else: a file viewer carries a `sessionId` too, and forking from a
    // file is not a thing.
    const onSession = panelKey === PanelKeysConst.terminal && facts !== null
    const admits = (operation: SessionOperation): boolean =>
      facts !== null && facts.admits.includes(operation)
    // The four below open the create card, and a card has to open somewhere: a session that names no
    // directory - one the control API founded without one - has no place to hand it.
    const placed = facts !== null && facts.directoryPath !== null
    return AppCommands.forSurface('contextMenu')
      // No admits gate on purpose: an ended or lost session is still renameable.
      .filter((descriptor) => descriptor.id !== 'session.details' || onSession)
      .filter((descriptor) => descriptor.id !== 'session.setColor' || onSession)
      .filter((descriptor) => descriptor.id !== 'session.newBeside'
        || onSession && placed && admits('newBeside'))
      // Only ever the OTHER agent: the one this tab already runs is not an alternative to itself.
      .filter((descriptor) => descriptor.id !== 'session.newInClaude'
        || onSession && placed && admits('newBeside') && facts?.agentId === 'codex')
      .filter((descriptor) => descriptor.id !== 'session.newInCodex'
        || onSession && placed && admits('newBeside') && facts?.agentId === 'claude')
      .filter((descriptor) => descriptor.id !== 'session.fork'
        || onSession && placed && admits('fork'))
      // The same operation at two moments, and never both at once: over a session that has stopped
      // the word is Resume and the card says what it will bring back, over a live one it is Restart.
      .filter((descriptor) => descriptor.id !== 'session.resume'
        || onSession && placed && admits('restart') && facts?.ended === true)
      .filter((descriptor) => descriptor.id !== 'session.restart'
        || onSession && admits('restart') && facts?.ended === false)
      .filter((descriptor) => descriptor.id !== 'session.compact' || onSession && admits('compact'))
      .filter((descriptor) => (descriptor.id !== 'session.commitSvn' && descriptor.id !== 'session.commitGit')
        || onSession && facts?.live === true && typeof params.remoteEndpointId !== 'string')
      .filter((descriptor) => descriptor.id !== 'tab.copyProjectFolder'
        || facts?.directoryPath !== null && facts?.directoryPath !== undefined)
      // A session and nothing else, the same gate the details dialog takes: a file viewer carries a
      // `sessionId` too, and no admits gate either - an ended session is still worth naming.
      .filter((descriptor) => descriptor.id !== 'session.copyReference' || onSession)
      .filter((descriptor) => descriptor.id !== 'tab.promote' || params.presentation === 'tab')
      .filter((descriptor) => descriptor.id !== 'tab.keepOpen' || preview)
      .filter((descriptor) => descriptor.id !== 'tab.openProjectFolder'
        || typeof params.sessionId === 'string' && params.sessionId.length > 0)
      .filter((descriptor) => descriptor.id !== 'tab.moveToNewWindow' || panelKey !== PanelKeysConst.welcome)
  }
}
