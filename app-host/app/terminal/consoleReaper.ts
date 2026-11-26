import { TerminalDescendants, type TerminalDescendant } from './terminalDescendants.js'

export interface ConsoleRoot { alive: boolean; processStartedAt: number | null }

/**
 * Ends the ConPTY console that a terminal leaves behind when its process ends by itself.
 *
 * node-pty 1.2.0-beta.12 (and beta.18) drops its PTY record in the exit thread before `kill()` can
 * reach `ClosePseudoConsole`, so every natural exit kept one `conhost.exe --headless` under the Host
 * until the Host ended (129 consoles, 1.2 GB after three days). node-pty names no console PID, so a
 * console is paired with a terminal by time: `CreatePseudoConsole` starts it just before the terminal
 * process. node-pty's bundled `conpty.dll` does not leak, but it reported every exit about 2 s later
 * and made Stop 2.7 s slower.
 *
 * A console is ended only when it is older than `minimumAgeMsConst`, no live terminal process started
 * within `pairingMsConst` after it, and no live terminal is still without a start identity. The stop
 * checks PID and start time again, so a reused PID is left alone. Two terminals started within the
 * pairing window keep each other's console: the error is always a console left running, never a live
 * terminal's console ended.
 *
 * A terminal that ends within seconds of its start leaves a console too young for the sweep its exit
 * triggers, so a sweep that held a console back for age or start identity sweeps again when that wait
 * is over.
 */
export class ConsoleReaper {
  static readonly settleMsConst = 15_000
  static readonly minimumAgeMsConst = 60_000
  static readonly pairingMsConst = 5_000
  private readonly roots: () => readonly ConsoleRoot[]
  private readonly list: () => Promise<TerminalDescendant[]>
  private readonly stop: (consoles: readonly TerminalDescendant[]) => Promise<void>
  private readonly now: () => number
  private readonly report: (message: string) => void
  private timer: ReturnType<typeof setTimeout> | null
  private sweeping: Promise<void> | null
  private disposed: boolean

  constructor(roots: () => readonly ConsoleRoot[], deps: {
    list?: () => Promise<TerminalDescendant[]>
    stop?: (consoles: readonly TerminalDescendant[]) => Promise<void>
    now?: () => number
    report?: (message: string) => void
  } = {}) {
    this.roots = roots
    this.list = deps.list ?? (() => TerminalDescendants.consolesOf(process.pid))
    this.stop = deps.stop ?? (consoles => TerminalDescendants.stop(consoles))
    this.now = deps.now ?? Date.now
    this.report = deps.report ?? (message => console.error(message))
    this.timer = null
    this.sweeping = null
    this.disposed = false
  }

  /** A terminal process ended: sweep once the burst of exits settles. */
  exited(): void {
    if (this.disposed || process.platform !== 'win32') return
    this.schedule(ConsoleReaper.settleMsConst)
  }

  sweep(): Promise<void> {
    this.sweeping ??= this.sweepOnce().finally(() => { this.sweeping = null })
    return this.sweeping
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  static orphans(consoles: readonly TerminalDescendant[], roots: readonly ConsoleRoot[], now: number): TerminalDescendant[] {
    const live = roots.filter(root => root.alive)
    if (live.some(root => root.processStartedAt === null)) return []
    const starts = live.map(root => root.processStartedAt!)
    return consoles.filter(console => now - console.startedAt >= ConsoleReaper.minimumAgeMsConst
      && !starts.some(start => start >= console.startedAt && start - console.startedAt <= ConsoleReaper.pairingMsConst))
  }

  /** Milliseconds until a console held back now could be ended, or null when none waits. */
  static retryIn(consoles: readonly TerminalDescendant[], roots: readonly ConsoleRoot[], now: number): number | null {
    const live = roots.filter(root => root.alive)
    if (live.some(root => root.processStartedAt === null)) return consoles.length > 0 ? ConsoleReaper.settleMsConst : null
    const waits = consoles
      .filter(console => !live.some(root => root.processStartedAt! >= console.startedAt
        && root.processStartedAt! - console.startedAt <= ConsoleReaper.pairingMsConst))
      .map(console => ConsoleReaper.minimumAgeMsConst - (now - console.startedAt))
      .filter(wait => wait > 0)
    return waits.length > 0 ? Math.min(...waits) + 1_000 : null
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.sweep() }, ms)
    this.timer.unref?.()
  }

  private async sweepOnce(): Promise<void> {
    try {
      const consoles = await this.list()
      if (this.disposed) return
      const roots = this.roots()
      const now = this.now()
      const orphans = ConsoleReaper.orphans(consoles, roots, now)
      if (orphans.length > 0) await this.stop(orphans)
      const wait = ConsoleReaper.retryIn(consoles, roots, now)
      if (wait !== null && !this.disposed && this.timer === null) this.schedule(wait)
    } catch (error) {
      this.report(`Ending the consoles of ended terminals failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
