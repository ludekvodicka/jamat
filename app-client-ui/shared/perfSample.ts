/**
 * How fast this client is answering, as four numbers that fail apart.
 *
 * A frame counter was asked for and would have lied: Chromium stops `requestAnimationFrame` when
 * nothing invalidates layout, so it reads 60 on an idle window and 0 on a hidden one, and it says
 * nothing at all about a keystroke waiting on the main process, on the Host, or on the agent. A
 * keystroke crosses three event loops and one foreign process, so what is worth drawing is one
 * number per place it can be held up.
 *
 * Every number is a MAX over the window since the previous sample, never an average: the symptom is
 * a spike of seconds every so often, and an average over a second hides exactly that.
 */
export interface PerfSample {
  /** The main process's own event-loop delay, which is where a keystroke is relayed. */
  mainLoopDelayP95Ms: number
  mainLoopDelayMaxMs: number
  /**
   * The slowest Host call this client made in the window, measured around the HTTP round trip: the
   * session poll alone makes one every two seconds, so this costs nothing to collect. Null where
   * the client called the Host not at all.
   */
  hostCallMaxMs: number | null
  /**
   * A keystroke to the first byte that came back for the same terminal, measured in the main process
   * across the Host, the PTY and the agent. It is the one number that answers "why can I not type":
   * an agent that is not reading its stdin shows here and in none of the others. Null where nobody
   * typed in the window.
   */
  echoMaxMs: number | null
  /**
   * The longest synchronous piece of work the main process did in the window, and its name: an IPC
   * channel, a frame published to a window, a snapshot composed for one. Null where nothing took
   * long enough to be worth naming.
   *
   * It is what turns a red `M` from a symptom into an address. `monitorEventLoopDelay` says the loop
   * was held; only a ledger over the doors work comes through says by what.
   */
  mainWorst: { label: string; milliseconds: number } | null
}

/** The sample plus what only the window itself can measure. */
export interface PerfReading extends PerfSample {
  /** How late a timer set for 50 ms actually ran, at its worst: the renderer's own loop. */
  rendererLagMs: number
  /** The round trip of the sampling call itself, renderer to main and back. */
  mainRoundTripMs: number
}

export class PerfSampleConst {
  /** Under this, nothing is worth noticing. */
  static readonly goodMsConst = 50
  /** Over this, somebody is waiting for the machine rather than the other way round. */
  static readonly badMsConst = 200

  static toneOf(milliseconds: number): 'good' | 'slow' | 'bad' {
    if (milliseconds < PerfSampleConst.goodMsConst) return 'good'
    if (milliseconds < PerfSampleConst.badMsConst) return 'slow'
    return 'bad'
  }
}
