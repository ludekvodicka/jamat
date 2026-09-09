import { AppCommands, type BareCommandId, type CommandDescriptor } from '../../shared/commands'

/** One stroke of a chord, as the catalog spells it and as a keydown is compared against it. */
interface ChordStroke {
  alt: boolean
  ctrl: boolean
  shift: boolean
  key: string
}

/**
 * `Alt+T` and then a direction, which is how V1 moved a panel and what people's fingers still do.
 *
 * It is the ONE keydown listener in this window that runs a command, and the exception is narrow by
 * construction: Electron holds a single combination per menu item, so the four commands this
 * delivers register nothing, and no stroke is dispatched twice. The rule it bends - the native menu
 * is the only deliverer - exists because V1 ran a listener BESIDE the menu for keys the menu already
 * had, and every one of those commands ran twice.
 *
 * What it answers to is read out of the catalog's `chord` strings rather than written again here, so
 * the keys the menu PRINTS and the keys this window acts on are the same two strokes by
 * construction. A malformed chord throws where the shell mounts rather than on a keystroke.
 *
 * It consumes what it acts on, propagation included: the leader arrives while a terminal has the
 * focus, and a stroke left to travel would reach xterm and be sent to the agent as `ESC t`.
 */
export class ShellChord {
  /** How long the second stroke has. V1's window, and long enough that it is not a race. */
  static readonly windowMillisecondsConst = 1_500

  private readonly run: (id: BareCommandId) => void
  private readonly now: () => number
  private readonly leader: ChordStroke
  private readonly commands: readonly { stroke: ChordStroke; id: BareCommandId }[]
  /** When the leader was pressed, or null while no chord is open. */
  private armedAt: number | null = null

  constructor(run: (id: BareCommandId) => void, now: () => number = Date.now) {
    this.run = run
    this.now = now
    const parsed = ShellChord.fromCatalog()
    this.leader = parsed.leader
    this.commands = parsed.commands
  }

  /** Capture, so the stroke is taken before the focused element - a terminal - can read it. */
  start(): () => void {
    const listener = (event: KeyboardEvent): void => {
      if (!this.handle(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }

  /** true = this stroke belonged to the chord and must go no further. */
  handle(event: KeyboardEvent): boolean {
    // A modifier of its own is not a stroke: holding Alt down across both halves fires `Alt` before
    // the letter, and treating that as "something else was pressed" would cancel every chord typed
    // the way the menu spells it.
    if (ShellChord.isModifier(event.key)) return false
    const open = this.armedAt !== null
      && this.now() - this.armedAt <= ShellChord.windowMillisecondsConst
    // Any stroke closes the chord, including the one that completes it and the one that abandons it.
    this.armedAt = null
    if (open) {
      const command = this.commands.find((entry) => ShellChord.matches(entry.stroke, event))
      if (command !== undefined) {
        this.run(command.id)
        return true
      }
      // Not a direction, so the chord is over - but the stroke may be a fresh leader, and pressing
      // the leader twice must arm rather than swallow the second one.
    }
    if (!ShellChord.matches(this.leader, event)) return false
    this.armedAt = this.now()
    return true
  }

  /**
   * The chords of the catalog as strokes. Every one of them has to open the same way: a second
   * leader would be a second chord, and this window arms one.
   */
  private static fromCatalog(): {
    leader: ChordStroke
    commands: readonly { stroke: ChordStroke; id: BareCommandId }[]
  } {
    let leader: ChordStroke | null = null
    const commands: { stroke: ChordStroke; id: BareCommandId }[] = []
    for (const descriptor of AppCommands.all()) {
      if (descriptor.chord === undefined) continue
      const strokes = descriptor.chord.split(' ').map(ShellChord.strokeOf)
      if (strokes.length !== 2)
        throw new Error(`A chord is two strokes: ${descriptor.id} declares ${descriptor.chord}`)
      if (leader !== null && !ShellChord.sameStroke(leader, strokes[0]))
        throw new Error(`A second chord leader: ${descriptor.id} declares ${descriptor.chord}`)
      leader = strokes[0]
      commands.push({ stroke: strokes[1], id: ShellChord.bareIdOf(descriptor) })
    }
    if (leader === null)
      throw new Error('The catalog declares no chord')
    return { leader, commands }
  }

  /**
   * A command needing a value cannot be delivered by a keystroke: the stroke carries none, and
   * `CommandRegistry.execute` takes the bare ids for exactly that reason.
   */
  private static bareIdOf(descriptor: CommandDescriptor): BareCommandId {
    if (descriptor.carriesValue)
      throw new Error(`A chord cannot carry a value: ${descriptor.id}`)
    return descriptor.id as BareCommandId
  }

  /** Electron's own spelling, which is what the catalog holds: `Alt+T`, `Ctrl+Shift+K`. */
  private static strokeOf(part: string): ChordStroke {
    const names = part.split('+')
    const key = names[names.length - 1]?.toLowerCase() ?? ''
    if (key === '')
      throw new Error(`A chord stroke names no key: ${part}`)
    const modifiers = names.slice(0, -1).map((name) => name.toLowerCase())
    for (const modifier of modifiers)
      if (modifier !== 'alt' && modifier !== 'ctrl' && modifier !== 'shift')
        throw new Error(`A chord stroke carries an unknown modifier: ${part}`)
    return {
      alt: modifiers.includes('alt'),
      ctrl: modifiers.includes('ctrl'),
      shift: modifiers.includes('shift'),
      key,
    }
  }

  /** Exact, so `Ctrl+Alt+T` is somebody else's key and travels on. */
  private static matches(stroke: ChordStroke, event: KeyboardEvent): boolean {
    return event.altKey === stroke.alt
      && event.ctrlKey === stroke.ctrl
      && event.shiftKey === stroke.shift
      && !event.metaKey
      && event.key.toLowerCase() === stroke.key
  }

  private static sameStroke(one: ChordStroke, other: ChordStroke): boolean {
    return one.alt === other.alt && one.ctrl === other.ctrl
      && one.shift === other.shift && one.key === other.key
  }

  private static isModifier(key: string): boolean {
    return key === 'Alt' || key === 'Control' || key === 'Shift' || key === 'Meta'
  }
}
