import type {
  ProjectBinding,
} from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  SessionAgentId,
  SessionColorName,
  SessionOperation,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import {
  AppCommands,
  type CommandDescriptor,
  type NewSessionPlace,
} from '../../../shared/commands'
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
  agentId: SessionAgentId | null
  color: SessionColorName | null
  /** The directory to copy. `null` where there is nothing to copy, which is the default directory. */
  directoryPath: string | null
  /**
   * The catalog project this session belongs to, or null where it belongs to none - an ad-hoc
   * directory, or no directory at all. It is what a new session started from here is pre-bound to,
   * so a session with none simply does not offer that item.
   */
  launch: Extract<ProjectBinding, { kind: 'project' }> | null
  admits: readonly SessionOperation[]
}

/**
 * The place a `session.newHere` opened from a SESSION names: that session's own project. Shared by
 * this menu and the sessions tree's, which ask the same question of the same facts.
 */
export class TabSessionPlace {
  static of(facts: TabSessionFacts): NewSessionPlace {
    if (facts.launch === null)
      throw new Error('A new session was asked for beside a session that belongs to no project')
    return { kind: 'project', project: facts.launch }
  }
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
            SessionCommandRun.at(
              props.commands,
              id,
              sessionId,
              props.facts === null ? null : TabSessionPlace.of(props.facts),
            )
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
    return AppCommands.forSurface('contextMenu')
      // No admits gate on purpose: an ended or lost session is still renameable.
      .filter((descriptor) => descriptor.id !== 'session.details' || onSession)
      .filter((descriptor) => descriptor.id !== 'session.setColor' || onSession)
      // No admits gate either: the launcher creates from scratch rather than beside this session,
      // so what this one still allows says nothing. What it does need is a project to pre-bind to.
      .filter((descriptor) => descriptor.id !== 'session.newHere'
        || onSession && facts?.launch !== null && facts?.launch !== undefined)
      .filter((descriptor) => descriptor.id !== 'session.newBlank'
        || onSession && admits('newBeside'))
      // Only ever the OTHER agent: the one this tab already runs is not an alternative to itself.
      .filter((descriptor) => descriptor.id !== 'session.newInClaude'
        || onSession && admits('newBeside') && facts?.agentId === 'codex')
      .filter((descriptor) => descriptor.id !== 'session.newInCodex'
        || onSession && admits('newBeside') && facts?.agentId === 'claude')
      .filter((descriptor) => descriptor.id !== 'session.fork' || onSession && admits('fork'))
      .filter((descriptor) => descriptor.id !== 'session.restart' || onSession && admits('restart'))
      .filter((descriptor) => descriptor.id !== 'session.compact' || onSession && admits('compact'))
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
