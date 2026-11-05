import type { ProjectBinding } from '../projectManager/projectManagerApi.types'
import type { SessionColorName } from '../sessionManager/sessionManagerApi.types'

export type CommandId =
  | 'session.new'
  | 'session.history'
  | 'session.newRemote'
  | 'settings.open'
  | 'app.quit'
  | 'app.toggleDevTools'
  | 'app.reload'
  | 'app.restart'
  | 'app.checkForUpdates'
  | 'window.new'
  | 'window.settings'
  | 'debug.open'
  | 'session.details'
  | 'session.setColor'
  | 'session.newHere'
  | 'session.newBeside'
  | 'session.newInClaude'
  | 'session.newInCodex'
  | 'session.fork'
  | 'session.resume'
  | 'session.restart'
  | 'session.compact'
  | 'session.showActions'
  | 'session.finish'
  | 'session.commitSvn'
  | 'session.commitGit'
  | 'tab.openProjectFolder'
  | 'session.openInVsCode'
  | 'tab.copyProjectFolder'
  | 'session.copyReference'
  | 'project.openFolder'
  | 'project.copyFolderPath'
  | 'project.worktreeSetup'
  | 'tab.keepOpen'
  | 'tab.close'
  | 'tab.closeOthers'
  | 'tab.splitRight'
  | 'tab.splitDown'
  | 'tab.moveToNewWindow'
  | 'tab.moveRight'
  | 'tab.moveLeft'
  | 'tab.moveUp'
  | 'tab.moveDown'
  | 'tab.resetLayout'
  | 'view.toggleLeftSidebar'
  | 'view.toggleRightSidebar'
  | 'view.toggleTabSidebar'
  | 'view.fileChanges'
  | 'view.fileBack'
  | 'view.maximizeToggle'
  | 'tools.usage'
  | 'tools.remarkable'

export type CommandMenuSection = 'file' | 'tab' | 'view' | 'tools' | 'window' | 'debug'

/**
 * `sessionsTree` is a session row of the tree; `sessionsTreeGroup` the rows ABOVE it - the category
 * and the project. They are two surfaces rather than one because the rows are two different things:
 * a session row acts on a session it already is, a group row on a place a session could be started
 * in, and no command of either is meaningful on the other.
 */
export type CommandSurface = 'menu' | 'contextMenu' | 'sessionsTree' | 'sessionsTreeGroup'

/**
 * How much the surface that asked for a new session already knew. A project row knows both, so the
 * launcher skips straight to its create form; a category row knows only the category, and the
 * project is still picked there.
 */
export type NewSessionPlace =
  | { kind: 'project'; project: Extract<ProjectBinding, { kind: 'project' }> }
  | { kind: 'category'; categoryId: string }

/**
 * What each command's argument is. Everything absent from this map takes no argument. Two shapes
 * live here: the colour, which its command is meaningless without (`carriesValue`), and the
 * OPTIONAL explicit target - the sessions tree sends the session of the clicked row, while the tab
 * menu and the native menu send nothing and the handler falls back to the session of the active
 * tab. A command with only an optional target is still meaningful bare, so it does not carry
 * `carriesValue` and the rules that flag carries with it do not apply.
 *
 * One map rather than a field on the descriptor, because this is the only place a TYPE can be
 * attached to an id: the descriptor is a runtime object, and a handler has to be given the argument
 * it declared, not `unknown`.
 */
export interface CommandArgById {
  'session.details': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.setColor': { color: SessionColorName | null; sessionId?: string; remoteEndpointId?: string }
  'session.newHere': { place: NewSessionPlace }
  'session.newBeside': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.newInClaude': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.newInCodex': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.fork': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.resume': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.restart': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.compact': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.showActions': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.finish': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.commitSvn': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.commitGit': { sessionId?: string; remoteEndpointId?: string } | undefined
  'tab.openProjectFolder': { sessionId?: string; remoteEndpointId?: string } | undefined
  'session.openInVsCode': { sessionId?: string; remoteEndpointId?: string } | undefined
  'tab.copyProjectFolder': { sessionId?: string; remoteEndpointId?: string } | undefined
  /**
   * The one session command that also works on a session of ANOTHER computer, which is why its
   * argument names an endpoint beside the session: the block is composed from what that computer
   * already sent, so the row of a paired computer runs this very command rather than a second one.
   * Both fields stay optional - without either it is the session of the tab in front, on this
   * machine - so it carries no value and the rules about value-carrying commands do not apply.
   */
  'session.copyReference': { sessionId?: string; remoteEndpointId?: string } | undefined
  /**
   * The project's own path, and a session of that project to prove it with: a directory grant is
   * taken against a session's filesystem root, and a project row has sessions under it by
   * construction - the row exists because they were found there.
   */
  'project.openFolder': { path: string; sessionId: string }
  'project.copyFolderPath': { path: string }
  /** The whole project, because the settings card names it as well as reads its file. */
  'project.worktreeSetup': { project: Extract<ProjectBinding, { kind: 'project' }> }
}

export type CommandArgOf<K extends CommandId> =
  K extends keyof CommandArgById ? CommandArgById[K] : void

/**
 * A command whose argument is NOT optional. Its handler reads a field straight off that argument, so
 * a bare run hands it `undefined` and throws inside whatever click ran it, with the compiler silent.
 *
 * `CommandRegistry.execute(id)` refuses these BY TYPE. What used to hold that line was three
 * hand-written safeguards outside the type - two catalog tests and one switch - and adding
 * `'contextMenu'` to one descriptor's `surfaces` walked straight past all three.
 */
export type ValueCarryingCommandId = {
  [K in keyof CommandArgById]: undefined extends CommandArgById[K] ? never : K
}[keyof CommandArgById]

/** Everything else: meaningful with no argument, which is all the native menu can ever send. */
export type BareCommandId = Exclude<CommandId, ValueCarryingCommandId>

export interface CommandDescriptor {
  id: CommandId
  title: string
  /** Where it runs: role/main = the main process, renderer = through the 'menu:command' event. */
  target: 'main' | 'renderer'
  /** Renderer target: main always reaches main; any follows the focused workspace with main fallback. */
  windowScope?: 'any' | 'main'
  menu?: { section: CommandMenuSection; group: number }
  surfaces: readonly CommandSurface[]
  /**
   * Which block of the context menu this belongs to. A separator is drawn between two blocks that
   * both have something in them, so a command filtered out takes no separator with it.
   */
  contextMenuGroup?: number
  /**
   * This command is only meaningful with a value. The native menu can send an id and nothing else,
   * so such a command must not declare the `menu` surface; `commands.test.ts` holds that.
   */
  carriesValue?: true
  accelerator?: string
  /**
   * Two strokes, `<leader> <second>`, which is a key Electron cannot register at all: it holds one
   * combination per item. So this is never an `accelerator` - the field above means "a key the menu
   * fires and `TerminalKeyGate` therefore takes off the terminal", and neither is true here. The
   * menu PRINTS this one, `ShellChord` in the window delivers it by reading exactly this field, and
   * the strokes never reach a command a second time because none of them is registered.
   */
  chord?: string
  /** false = Electron does not register the key, the item only displays it. */
  registerAccelerator?: boolean
  /**
   * May run while a terminal holds focus, and therefore a key the terminal does NOT get: the native
   * menu is about to run the command, so `TerminalKeyGate` keeps xterm from also turning it into
   * bytes. A command without an accelerator can only be reached by clicking, so it never contends.
   *
   * `false` says the terminal keeps the key. Nothing at runtime can stop a registered accelerator
   * from firing, so such a command must also set `registerAccelerator: false`; the gate test in
   * `scripts/tokensGate.test.ts` is what holds that.
   */
  terminalSafe: boolean
  /**
   * Electron's own menu item, keyboard handling included. A role item still DECLARES its key
   * above: the menu never passes an accelerator on for one - Electron owns it - but this
   * catalog is the single list of what claims a key, and `TerminalKeyGate` builds its map from
   * exactly that list. A role whose key is absent here is a key the gate has never heard of,
   * and the terminal would turn it into bytes beside whatever the role did.
   */
  role?: 'quit' | 'toggleDevTools'
}
