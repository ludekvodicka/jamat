import type {
  ProjectBinding,
} from '../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  SessionColorName,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { WindowRole } from './windowInfo'

export type CommandId =
  | 'session.new'
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
  | 'debug.newProbe'
  | 'tab.new'
  | 'session.details'
  | 'session.setColor'
  | 'session.newHere'
  | 'session.newBlank'
  | 'session.newInClaude'
  | 'session.newInCodex'
  | 'session.fork'
  | 'session.restart'
  | 'session.compact'
  | 'tab.openProjectFolder'
  | 'tab.copyProjectFolder'
  | 'session.copyReference'
  | 'project.openFolder'
  | 'project.copyFolderPath'
  | 'project.worktreeSetup'
  | 'tab.promote'
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
  'session.details': { sessionId?: string } | undefined
  'session.setColor': { color: SessionColorName | null; sessionId?: string }
  'session.newHere': { place: NewSessionPlace }
  'session.newBlank': { sessionId?: string } | undefined
  'session.newInClaude': { sessionId?: string } | undefined
  'session.newInCodex': { sessionId?: string } | undefined
  'session.fork': { sessionId?: string } | undefined
  'session.restart': { sessionId?: string } | undefined
  'session.compact': { sessionId?: string } | undefined
  'tab.openProjectFolder': { sessionId?: string } | undefined
  'tab.copyProjectFolder': { sessionId?: string } | undefined
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
  'tab.promote': { sessionId?: string } | undefined
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

/**
 * Which of the two launcher cards the more reachable key opens. `session-first` is what the catalog
 * declares - Ctrl+T opens New Session and Ctrl+Shift+T opens New Tab - and `tab-first` is the two of
 * them the other way round.
 *
 * It exists because two people share this application and want opposite answers, which is the one
 * thing a fixed decision cannot give either of them. It is deliberately not a key editor: a pair of
 * fixed keys that can be swapped keeps every rule the catalog holds about keys true under both
 * values, and a free remap would not.
 */
export type LauncherKeyPreference = 'session-first' | 'tab-first'

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

/** The one source of commands: the native menu, the renderer registry and the tab context menu read it. */
export class AppCommands {
  /**
   * Keys that belong to the terminal; no descriptor may take one (enforced by commands.test.ts).
   *
   * Escape and the four clipboard keys are on the list for the same reason as the rest: the terminal
   * answers them itself - cancel, copy, paste and the interrupt - and a menu accelerator fires
   * whatever has the focus, so a command taking one would break the terminal from a distance.
   */
  static readonly reservedTerminalKeysConst = [
    'Esc',
    'Ctrl+R',
    'Ctrl+J',
    'Ctrl+Enter',
    'Shift+Enter',
    'Ctrl+C',
    'Ctrl+V',
    'Ctrl+Shift+C',
    'Ctrl+Shift+V',
  ] as const

  private static readonly catalogConst: readonly CommandDescriptor[] = [
    /*
     * The one way into the launcher: it opens on its project screen, so a second command that only
     * opened the same screen was two menu items for one action. The overlay's own keys (F1, F3, F4,
     * F6, F7, F8, arrows, type-to-jump) are keydown inside the card and never enter this catalog -
     * which is also why F2 was free for the rename below: it gated the manage mode the launcher
     * retired on 2026-08-11 and has answered nothing since.
     *
     * It held Ctrl+N until 2026-08-31, when the two launcher cards became a swappable pair and one
     * accelerator per descriptor meant the third key had to go. Ctrl+N going rather than Ctrl+T is
     * what the pair is FOR: two keys opening the same launcher is the mistake that retired Ctrl+P
     * on 2026-08-11, and the key the pair is worth having is the one people reach for. Ctrl+N went
     * to the network card below on the same day.
     */
    {
      id: 'session.new',
      title: 'New Session',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'file', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+T',
      terminalSafe: true,
    },
    /*
     * The third profile of the same launcher, and the key the pair above freed. It is NOT part of
     * that pair: the preference swaps which card the two local keys open, and this one always opens
     * the network card, so `acceleratorOf` answers Ctrl+N under either value.
     *
     * A card rather than a second overlay, and a command rather than a mode of `session.new`,
     * because what it asks for is a different first question: which computer. The tree's context
     * action on a connected computer writes the same intent with the answer already filled in.
     */
    {
      id: 'session.newRemote',
      title: 'New Remote Session',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'file', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+N',
      terminalSafe: true,
    },
    // Ctrl+, is what every editor uses for settings and belongs to no terminal binding: readline
    // reads a bare comma, and the key is on neither the reserved list nor any other descriptor.
    {
      id: 'settings.open',
      title: 'Settings',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'file', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+,',
      terminalSafe: true,
    },
    {
      id: 'app.quit',
      title: 'Quit',
      target: 'main',
      menu: { section: 'file', group: 1 },
      surfaces: ['menu'],
      // Declared, not passed on: Electron's `quit` role binds this itself. It is here so the
      // gate knows the key is claimed. Windows and Linux; the first release platform is win32.
      accelerator: 'Ctrl+Q',
      terminalSafe: true,
      role: 'quit',
    },
    // The other half of the swappable pair. Ctrl+Shift+T shadows nothing a terminal answers: xterm
    // encodes no `Ctrl+Shift+<letter>`, which is the same ground Ctrl+Shift+D and Ctrl+Shift+I
    // already stand on.
    {
      id: 'tab.new',
      title: 'New Tab',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+Shift+T',
      terminalSafe: true,
    },
    /*
     * The session block of the tab menu and of the sessions tree's menu. Every one of these acts on
     * ONE session: the tree names the clicked row's session through `CommandArgById`, and without
     * that argument the handler falls back to the session behind the tab the menu was opened on.
     * Which of them appear is decided by what that session ADMITS - the library's answer, read off
     * the snapshot, never re-derived here. The details dialog is the one exception: a name, a note
     * and a colour make sense for an ended session too, so it gates only on the tab being a
     * session's.
     *
     * The colour is the one command in this catalog that carries a value, which is why it may not
     * declare the `menu` surface: the native menu can send an id and nothing more.
     */
    // First of the block, and first of the whole menu, because it is the one row reached for
    // repeatedly: a colour is how a person tells one of a dozen rows from the next, and it is set
    // again and again while the rest of this block is opened once per session.
    {
      id: 'session.setColor',
      title: 'Session Appearance',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 0,
      carriesValue: true,
      terminalSafe: true,
    },
    // The one session command with a key, which is V1's key for the same dialog. An accelerator is
    // registered by the native menu item and by nothing else, so it declares the `menu` surface as
    // well - legal here because it carries no value, only an optional target. It sits in the Tab
    // section's first group, beside the two other things done to the tab in front.
    //
    // Named for what the dialog IS rather than for one of the things it does: it sets a name, a note
    // and a colour, and "Rename session" said only the first of the three.
    {
      id: 'session.details',
      title: 'Session properties…',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 0 },
      surfaces: ['menu', 'contextMenu', 'sessionsTree'],
      contextMenuGroup: 0,
      accelerator: 'F2',
      terminalSafe: true,
    },
    // The only one of this block that asks before it acts: the rest start something beside the
    // session in front, this opens the launcher pre-bound to the place the click named - a project,
    // or a category with the project still to pick. It is `session.new` with the place filled in,
    // which is exactly why it is a second command: a place is a value, and the native menu can send
    // an id and nothing more, so `Ctrl+N` and the File menu keep pointing at the bare one.
    {
      id: 'session.newHere',
      title: 'New session…',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree', 'sessionsTreeGroup'],
      contextMenuGroup: 1,
      carriesValue: true,
      terminalSafe: true,
    },
    {
      id: 'session.newBlank',
      title: 'New blank session',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 1,
      terminalSafe: true,
    },
    // Two commands rather than one with a title that changes: a catalog title is static, and the
    // filter shows only the one naming the OTHER agent, so the menu still carries a single item.
    {
      id: 'session.newInClaude',
      title: 'New session in Claude',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 1,
      terminalSafe: true,
    },
    {
      id: 'session.newInCodex',
      title: 'New session in Codex',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 1,
      terminalSafe: true,
    },
    {
      id: 'session.fork',
      title: 'Fork session',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 1,
      terminalSafe: true,
    },
    {
      id: 'session.restart',
      title: 'Restart session',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 1,
      terminalSafe: true,
    },
    {
      id: 'session.compact',
      title: 'Compact session',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 1,
      terminalSafe: true,
    },
    {
      id: 'tab.openProjectFolder',
      title: 'Open project folder',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 2,
      terminalSafe: true,
    },
    {
      id: 'tab.copyProjectFolder',
      title: 'Copy project folder',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 2,
      terminalSafe: true,
    },
    // Beside the folder pair, because it is the third thing somebody copies out of a session, and
    // the only one meant for a SECOND agent: the machine, the agent's own conversation id, the
    // directory and the transcript, in one block to paste.
    {
      id: 'session.copyReference',
      title: 'Copy unique session id',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 2,
      terminalSafe: true,
    },
    // The same two words on a project row, and two commands rather than a widened argument on the
    // pair above: those take a session and fall back to the tab in front, while a project row has a
    // path and no session of its own. One required argument each says so in the type.
    {
      id: 'project.openFolder',
      title: 'Open project folder',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['sessionsTreeGroup'],
      contextMenuGroup: 2,
      carriesValue: true,
      terminalSafe: true,
    },
    {
      id: 'project.copyFolderPath',
      title: 'Copy project folder',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['sessionsTreeGroup'],
      contextMenuGroup: 2,
      carriesValue: true,
      terminalSafe: true,
    },
    {
      id: 'project.worktreeSetup',
      title: 'Worktree setup…',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['sessionsTreeGroup'],
      contextMenuGroup: 2,
      carriesValue: true,
      terminalSafe: true,
    },
    // Only ever FOR a plain tab - on its own tab, and on its tree row - which is why both menus
    // filter on what the tab or row is rather than the catalog: a session of the tree has nothing
    // to be promoted into.
    {
      id: 'tab.promote',
      title: 'Keep as a session',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu', 'sessionsTree'],
      contextMenuGroup: 3,
      terminalSafe: true,
    },
    // Only ever for the ONE provisional tab, so the tab menu filters on what that tab is. It says
    // the same thing a move or a double-click says, for someone who reaches for the menu instead.
    {
      id: 'tab.keepOpen',
      title: 'Keep Open',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu'],
      contextMenuGroup: 3,
      terminalSafe: true,
    },
    {
      id: 'tab.close',
      title: 'Close Tab',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 0 },
      surfaces: ['menu', 'contextMenu'],
      contextMenuGroup: 3,
      accelerator: 'Ctrl+W',
      terminalSafe: true,
    },
    {
      id: 'tab.closeOthers',
      title: 'Close Other Tabs',
      target: 'renderer',
      windowScope: 'any',
      surfaces: ['contextMenu'],
      contextMenuGroup: 3,
      terminalSafe: true,
    },
    {
      id: 'tab.splitRight',
      title: 'Split Right',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 1 },
      surfaces: ['menu', 'contextMenu'],
      contextMenuGroup: 3,
      accelerator: 'Ctrl+Shift+Right',
      terminalSafe: true,
    },
    {
      id: 'tab.splitDown',
      title: 'Split Down',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 1 },
      surfaces: ['menu', 'contextMenu'],
      contextMenuGroup: 3,
      accelerator: 'Ctrl+Shift+Down',
      terminalSafe: true,
    },
    {
      id: 'tab.moveToNewWindow',
      title: 'Move to New Window',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 1 },
      surfaces: ['menu', 'contextMenu'],
      contextMenuGroup: 3,
      terminalSafe: true,
    },
    /*
     * The four moves, and the one group of this catalog whose keys are a CHORD: `Alt+T` arms, and
     * the second stroke picks a direction. It is `chord` rather than `accelerator` because Electron
     * holds one combination per item and can register neither half of this; the menu prints it and
     * `ShellChord` in the window delivers it, reading these very strings so that what a person sees
     * in the menu and what the window answers to cannot come apart. That is the one exception to
     * "the native menu is the single deliverer", and it is safe for the reason the field's own note
     * gives: nothing here is registered, so no stroke is dispatched twice.
     *
     * They are V1's keys, unchanged, because a key people already have in their fingers is the whole
     * point of porting the commands at all: n for the next group, p for the previous, u and d.
     */
    {
      id: 'tab.moveRight',
      title: 'Move Right',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 2 },
      surfaces: ['menu'],
      chord: 'Alt+T Alt+N',
      terminalSafe: true,
    },
    {
      id: 'tab.moveLeft',
      title: 'Move Left',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 2 },
      surfaces: ['menu'],
      chord: 'Alt+T Alt+P',
      terminalSafe: true,
    },
    {
      id: 'tab.moveUp',
      title: 'Move Up',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 2 },
      surfaces: ['menu'],
      chord: 'Alt+T Alt+U',
      terminalSafe: true,
    },
    {
      id: 'tab.moveDown',
      title: 'Move Down',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 2 },
      surfaces: ['menu'],
      chord: 'Alt+T Alt+D',
      terminalSafe: true,
    },
    {
      id: 'tab.resetLayout',
      title: 'Reset Layout',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tab', group: 3 },
      surfaces: ['menu'],
      terminalSafe: true,
    },
    // Ctrl+B shadows readline's backward-char and tmux's prefix, the same trade Ctrl+T and Ctrl+W
    // already make. Neither key is on the reserved list, and VSCode sets the same precedent.
    {
      id: 'view.toggleLeftSidebar',
      title: 'Toggle Left Sidebar',
      target: 'renderer',
      windowScope: 'main',
      menu: { section: 'view', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+B',
      terminalSafe: true,
    },
    {
      id: 'view.toggleRightSidebar',
      title: 'Toggle Right Sidebar',
      target: 'renderer',
      windowScope: 'main',
      menu: { section: 'view', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+Alt+B',
      terminalSafe: true,
    },
    {
      id: 'view.toggleTabSidebar',
      title: 'Toggle File Tools',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'view', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+G',
      terminalSafe: true,
    },
    {
      id: 'view.fileChanges',
      title: 'File Changes',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'view', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+H',
      terminalSafe: true,
    },
    {
      id: 'view.fileBack',
      title: 'Back in Split Files',
      target: 'renderer',
      windowScope: 'any',
      surfaces: [],
      terminalSafe: true,
    },
    {
      id: 'view.maximizeToggle',
      title: 'Maximize Group',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'view', group: 0 },
      surfaces: ['menu'],
      accelerator: 'F11',
      terminalSafe: true,
    },
    {
      id: 'app.toggleDevTools',
      title: 'Toggle DevTools',
      target: 'main',
      menu: { section: 'view', group: 1 },
      surfaces: ['menu'],
      // Declared for the gate, bound by Electron's own role. Nothing was doubled before this line
      // existed, and the reason was luck: this xterm encodes nothing for `Ctrl+Shift+<letter>`, so
      // the byte that would have arrived beside the role was empty.
      accelerator: 'Ctrl+Shift+I',
      terminalSafe: true,
      role: 'toggleDevTools',
    },
    {
      id: 'tools.remarkable',
      title: 'Remarkable',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tools', group: 0 },
      surfaces: ['menu'],
      terminalSafe: true,
    },
    // The only way anybody asks for an update, and it belongs to the main process because the
    // updater lives there: nothing is downloaded until this is clicked and answered. Its own group,
    // so a separator keeps a question about the whole application apart from a panel. No
    // accelerator - a key for something asked once a month would cost the terminal one for nothing.
    {
      id: 'app.checkForUpdates',
      title: 'Check for Updates…',
      target: 'main',
      menu: { section: 'tools', group: 1 },
      surfaces: ['menu'],
      terminalSafe: true,
    },
    // Opening a window is the main process's own work, which is also why `assertCovers` in the
    // renderer never has to know about it. Ctrl+Shift+D takes no reserved terminal key.
    {
      id: 'window.new',
      title: 'New Window',
      target: 'main',
      menu: { section: 'window', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+Shift+N',
      terminalSafe: true,
    },
    {
      id: 'window.settings',
      title: 'Window Settings',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'window', group: 0 },
      surfaces: ['menu'],
      terminalSafe: true,
    },
    {
      id: 'debug.open',
      title: 'Debug Window',
      target: 'main',
      menu: { section: 'debug', group: 0 },
      surfaces: ['menu'],
      accelerator: 'Ctrl+Shift+D',
      terminalSafe: true,
    },
    // Developer scaffolding, and it had Ctrl+T until a plain tab needed the key. It keeps its panel
    // key for ever either way - saved layouts carry it - so only the way in moved.
    {
      id: 'debug.newProbe',
      title: 'New Lifecycle Probe',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'debug', group: 0 },
      surfaces: ['menu'],
      terminalSafe: true,
    },
    // No accelerator and deliberately no `role: 'reload'`: the role would register Ctrl+R, which is
    // the shell's reverse-search.
    {
      id: 'app.reload',
      title: 'Reload',
      target: 'main',
      menu: { section: 'debug', group: 0 },
      surfaces: ['menu'],
      terminalSafe: true,
    },
    // A whole-app restart, not a window reload: a main-process change needs the bundle rebuilt and
    // the process replaced, which Reload above cannot do. Its own group, so a separator keeps the
    // action that ends the client apart from the ones that do not.
    {
      id: 'app.restart',
      title: 'Restart App',
      target: 'main',
      menu: { section: 'debug', group: 1 },
      surfaces: ['menu'],
      terminalSafe: true,
    },
  ]

  static all(): readonly CommandDescriptor[] {
    return AppCommands.catalogConst
  }

  /** What the catalog declares, and therefore what a surface shows when nobody has said otherwise. */
  static readonly launcherKeyDefaultConst: LauncherKeyPreference = 'session-first'

  /**
   * The two launcher commands, as a pair rather than as two ids spelled out by every consumer.
   * `swappedConst` is the whole of what the preference does, which is why it lives beside the
   * catalog that declares both keys.
   */
  private static readonly launcherPairConst = {
    'session.new': 'tab.new',
    'tab.new': 'session.new',
  } as const satisfies Partial<Record<CommandId, CommandId>>

  /**
   * The accelerator a menu item registers and a tooltip prints, given the preference.
   *
   * It is a SWAP and never a remap, which is the property everything else depends on: the same two
   * keys are claimed under either value, so the reserved-key rule, the one-command-per-accelerator
   * rule and `TerminalKeyGate`'s map are unchanged by it and read the catalog directly. What moves
   * is only which of the two cards a key opens.
   */
  static acceleratorOf(
    descriptor: CommandDescriptor,
    preference: LauncherKeyPreference = AppCommands.launcherKeyDefaultConst,
  ): string | undefined {
    if (preference === 'session-first') return descriptor.accelerator
    else if (preference === 'tab-first') {
      const partner = AppCommands.launcherPairConst[
        descriptor.id as keyof typeof AppCommands.launcherPairConst
      ]
      return partner === undefined
        ? descriptor.accelerator
        : AppCommands.byId(partner).accelerator
    }
    else
      throw new Error(`Unknown launcher key preference: ${JSON.stringify(preference)}`)
  }

  /**
   * For a surface that draws ONE command of its own - a button on a sidebar's title line naming the
   * key that does the same thing. It reads the accelerator here rather than repeating it, because a
   * tooltip that says a key the catalog no longer registers is worse than no tooltip.
   */
  static byId(id: CommandId): CommandDescriptor {
    const found = AppCommands.catalogConst.find((descriptor) => descriptor.id === id)
    if (!found)
      throw new Error(`Unknown command: ${JSON.stringify(id)}`)
    return found
  }

  /**
   * The runtime shadow of `ValueCarryingCommandId`, for a caller holding a plain `CommandId` - the
   * tab menu, whose ids arrive from a filtered catalog rather than as literals. The catalog's own
   * `carriesValue` flag is the source; `commands.test.ts` holds the flagged set and the type equal,
   * so the two cannot drift and this predicate cannot start lying.
   */
  static carriesValue(id: CommandId): id is ValueCarryingCommandId {
    return AppCommands.byId(id).carriesValue === true
  }

  static forSurface(surface: CommandSurface): readonly CommandDescriptor[] {
    return AppCommands.catalogConst.filter((descriptor) => descriptor.surfaces.includes(surface))
  }

  static rendererFor(role: WindowRole): readonly CommandDescriptor[] {
    if (role === 'main')
      return AppCommands.catalogConst.filter((descriptor) => descriptor.target === 'renderer')
    else if (role === 'holder')
      return AppCommands.catalogConst.filter(
        (descriptor) => descriptor.target === 'renderer' && descriptor.windowScope === 'any',
      )
    else
      throw new Error(`Unknown workspace role: ${JSON.stringify(role)}`)
  }
}
