import type { Terminal } from '@xterm/xterm'

/**
 * The terminal scroll speed for the agents that scroll themselves.
 *
 * `scrollSensitivity` multiplies the wheel only where XTERM does the scrolling: the viewport over
 * its own scrollback. An agent that takes the mouse does not scroll that way. Claude Code enters the
 * alternate screen and turns on mouse reporting (`?1049h`, `?1000h`, `?1002h`, `?1003h`, `?1006h`),
 * so one notch of the wheel becomes ONE mouse report on the pipe and the agent moves its own
 * transcript by its own step; the option never enters the arithmetic. Codex stays in the normal
 * buffer, so the same option works there - which is exactly how this arrived: the setting moved one
 * agent's screen and not the other's.
 *
 * What is multiplied here is therefore the NOTCH, not the distance: one wheel event becomes as many
 * as the speed asks for, and each is encoded, sent and acted on by the agent as if the wheel had
 * turned that far. Below 100 % it is the other way round - a notch is dropped until the fraction
 * adds up to one - which is what makes the slider symmetrical on a screen we do not scroll.
 *
 * The hook is the one place xterm asks permission, and it is asked about EVERY wheel event over the
 * screen, the ones xterm goes on to scroll itself included. So the repeat asks first whether the
 * application is the one scrolling - it reports the mouse, or it is on the alternate screen, which
 * has no scrollback to move - and otherwise answers `true` and copies nothing. Without that gate the
 * two halves of one setting would both apply to one event and 250 % would scroll six and a quarter
 * times as far.
 */
export class TerminalWheelRepeat {
  private readonly terminal: Terminal
  private readonly factorOf: () => number
  /** Ours, so the copies pass straight through instead of each spawning copies of its own. */
  private readonly repeated: WeakSet<WheelEvent>
  /** The fraction a speed like 2.5 leaves behind, so two notches and three alternate. */
  private pending: number
  /** Which way the wheel was last going: a turn the other way starts the count again. */
  private direction: number

  constructor(terminal: Terminal, factorOf: () => number) {
    this.terminal = terminal
    this.factorOf = factorOf
    this.repeated = new WeakSet()
    this.pending = 0
    this.direction = 0
  }

  /** Installed once per terminal. xterm keeps one handler and offers no way to take it back. */
  static install(terminal: Terminal, factorOf: () => number): void {
    const repeat = new TerminalWheelRepeat(terminal, factorOf)
    terminal.attachCustomWheelEventHandler((event) => repeat.allow(event))
  }

  /** `false` drops the event: xterm neither reports nor translates it, which is a slower wheel. */
  allow(event: WheelEvent): boolean {
    if (this.repeated.has(event)) return true
    // xterm scrolls this one itself, and `scrollSensitivity` has already multiplied it there.
    if (!this.applicationScrolls()) return true
    const factor = this.factorOf()
    // The default is left exactly as it was: no copies, no accumulator, nothing to go wrong for
    // anybody who never touched the slider.
    if (factor === 1) return true
    const vertical = Math.sign(event.deltaY)
    const direction = vertical !== 0 ? vertical : Math.sign(event.deltaX)
    if (direction !== this.direction) {
      this.pending = 0
      this.direction = direction
    }
    this.pending += factor
    const notches = Math.floor(this.pending)
    this.pending -= notches
    if (notches === 0) return false
    const target = event.target
    // A wheel over the screen always has an element under it; without one there is nothing to
    // dispatch to, and the single event xterm already holds is still worth sending.
    if (!(target instanceof Element)) return true
    for (let sent = 1; sent < notches; sent += 1)
      this.dispatch(event, target)
    return true
  }

  /**
   * Whether the wheel is going to the application rather than to the viewport: it reports the mouse,
   * or it is on the alternate screen, which has no scrollback for xterm to move and gets arrow keys
   * instead. Both are read per event, because an agent turns them on while its session is running.
   */
  private applicationScrolls(): boolean {
    if (this.terminal.modes.mouseTrackingMode !== 'none') return true
    return this.terminal.buffer.active.type === 'alternate'
  }

  /**
   * One more turn of the same wheel, sent where the first one landed. It carries the pointer
   * position because that is what the mouse report encodes - a copy at the origin would tell the
   * agent the wheel turned in the top left corner.
   */
  private dispatch(event: WheelEvent, target: Element): void {
    const copy = new WheelEvent('wheel', {
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      bubbles: true,
      cancelable: true,
    })
    this.repeated.add(copy)
    target.dispatchEvent(copy)
  }
}
