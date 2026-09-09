import type {
  BareCommandId,
  CommandArgById,
  CommandArgOf,
  CommandDescriptor,
  CommandId,
} from '../../shared/commands'

/**
 * 'passthrough' is not an error: a command this registry does not hold is a command with a main
 * target, which the native menu runs on its own.
 *
 * The terminal was expected to consult this registry and turned out not to. `TerminalKeyGate` reads
 * the catalog instead, precisely because a main-target accelerator is 'passthrough' here: asking
 * this registry would call such a key unclaimed and let its byte reach the shell as well as the
 * window. Nothing about that needed this file to change, which was the point.
 */
export type DispatchOutcome = 'handled' | 'passthrough'

/** The renderer half of the one dispatch path: the menu names a command, this runs it. */
export class CommandRegistry {
  private readonly handlers = new Map<CommandId, (arg?: unknown) => void>()

  /**
   * The handler is given exactly what its command declares in `CommandArgById`, and `void` for every
   * command that declares nothing - so the commands that existed before the colour submenu are
   * unchanged in signature and at their call sites.
   */
  register<K extends CommandId>(id: K, run: (arg: CommandArgOf<K>) => void): void {
    if (this.handlers.has(id))
      throw new Error(`Command is already registered: ${id}`)
    this.handlers.set(id, run as (arg?: unknown) => void)
  }

  /**
   * Two ways in. The native menu sends an id alone, and the bare overload takes `BareCommandId`
   * rather than the whole union, so a command whose handler reads a required field cannot reach
   * `handler(undefined)` through it. The arg overload carries either a value the command is
   * meaningless without - the colour of a swatch - or the optional session the tree's row menu
   * names, which every one of those commands also answers without.
   */
  execute(id: BareCommandId): DispatchOutcome
  execute<K extends keyof CommandArgById>(id: K, arg: CommandArgById[K]): DispatchOutcome
  execute(id: CommandId, arg?: unknown): DispatchOutcome {
    const handler = this.handlers.get(id)
    if (!handler)
      return 'passthrough'
    handler(arg)
    return 'handled'
  }

  /** Called at boot: a renderer command with no handler must fail the start, not a user's click. */
  assertCovers(commands: readonly CommandDescriptor[]): void {
    const missing = commands
      .filter((descriptor) => descriptor.target === 'renderer' && !this.handlers.has(descriptor.id))
      .map((descriptor) => descriptor.id)
    if (missing.length > 0)
      throw new Error(`Renderer commands without a handler: ${missing.join(', ')}`)
  }
}
