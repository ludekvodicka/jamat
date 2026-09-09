import { AppCommands, type CommandDescriptor } from '../../../../shared/commands'

/**
 * Which keystrokes a focused terminal keeps, and which it must let go of.
 *
 * The problem it exists for is that Electron's native menu owns every accelerator and fires it
 * whatever has the focus. Without this, `Ctrl+T` would open a tab AND put a `\x14` into whatever the
 * agent is reading: the command runs once and the byte still arrives. So the gate decides one thing
 * only - whether xterm may turn this event into bytes - and never runs a command itself. Delivering
 * one is the menu's job, and a second delivery is exactly what V1 shipped by adding a keydown
 * listener of its own beside the menu.
 *
 * It reads the catalog rather than `CommandRegistry`, and the difference matters: the registry holds
 * the renderer-target commands only, so a main-target accelerator would look unclaimed and its byte
 * would reach the shell as well as the window.
 */
export class TerminalKeyGate {
  /** Built once and kept: this runs on every keydown of a focused terminal. */
  private static acceleratorCache: Map<string, CommandDescriptor> | null = null

  /** true = the keystroke is the terminal's and becomes bytes; false = xterm never sees it. */
  static allowXterm(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true
    const accelerator = TerminalKeyGate.acceleratorOf(event)
    if (accelerator === null) return true
    // The reserved list is what a terminal cannot work without, and the design-time gate keeps every
    // command off it. Answering here as well means one of them arriving anyway is still harmless.
    if ((AppCommands.reservedTerminalKeysConst as readonly string[]).includes(accelerator))
      return true
    const command = TerminalKeyGate.accelerators().get(accelerator)
    if (command === undefined) return true
    // The whole point: the menu is about to run this command, so the byte must not also be sent.
    if (command.terminalSafe) return false
    // A command that is NOT terminal-safe belongs to the terminal while one has the focus. That it
    // does not fire anyway is not this gate's to enforce - a menu accelerator fires regardless of
    // focus - so the invariant that such a command registers no accelerator is checked by the gate
    // test instead. Today no command is in this branch.
    return true
  }

  /**
   * The event as Electron would have spelled the accelerator, or null for a keystroke that cannot be
   * one: a bare modifier. The vocabulary is Electron's own, because that is what the catalog holds.
   */
  static acceleratorOf(event: KeyboardEvent): string | null {
    const key = TerminalKeyGate.keyNameOf(event.key)
    if (key === null) return null
    const parts: string[] = []
    if (event.ctrlKey) parts.push('Ctrl')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    if (event.metaKey) parts.push('Cmd')
    parts.push(key)
    return parts.join('+')
  }

  private static keyNameOf(key: string): string | null {
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return null
    if (key === ' ') return 'Space'
    if (key === 'Escape') return 'Esc'
    if (key === 'ArrowUp') return 'Up'
    if (key === 'ArrowDown') return 'Down'
    if (key === 'ArrowLeft') return 'Left'
    if (key === 'ArrowRight') return 'Right'
    // Letters, digits and punctuation alike: Electron spells them as the character, upper case.
    if (key.length === 1) return key.toUpperCase()
    // Enter, Tab, Backspace, Delete, Home, End, PageUp, PageDown, F1 to F24 are already its words.
    return key
  }

  private static accelerators(): Map<string, CommandDescriptor> {
    if (TerminalKeyGate.acceleratorCache !== null) return TerminalKeyGate.acceleratorCache
    const built = new Map<string, CommandDescriptor>()
    for (const command of AppCommands.all())
      if (command.accelerator !== undefined) built.set(command.accelerator, command)
    TerminalKeyGate.acceleratorCache = built
    return built
  }
}
