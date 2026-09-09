/**
 * A command registered before the thing it runs against exists. Every command in this shell is
 * registered once, at composition, while the sidebar handle it toggles and the overlays it opens
 * live only for as long as the component that renders them - so the binding is late on purpose.
 * Running one before the binding lands is a wiring mistake and says so rather than doing nothing.
 *
 * Opening twice is opening once: the shell holds one flag per overlay, so a second Ctrl+N cannot
 * stack a second card. That is the binding's own business, not this class's.
 */
export class LateBoundCommand<T = void> {
  private target: ((argument: T) => void) | null = null

  constructor(private readonly subject: string) {}

  bind(target: (argument: T) => void): void {
    this.target = target
  }

  open(argument: T): void {
    if (!this.target)
      throw new Error(`The ${this.subject} command ran before the shell bound it`)
    this.target(argument)
  }
}
