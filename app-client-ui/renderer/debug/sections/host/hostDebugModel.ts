import type {
  HostDebugStatus,
  HostPingResult,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { type HostReading, HostStatusReading } from '../../../statusBar/hostStatusItem'

/** Exact string match, and a missing version on either side is never read as a match. */
export type HostVersionVerdict = 'current' | 'stale' | 'unknown'

export type HostProtocolVerdict = 'match' | 'mismatch' | 'unknown'

export interface HostDebugState {
  /** Null until the first read answers; the reader is what fills it. */
  status: HostDebugStatus | null
  /** A ping THIS section asked for is still out. The loop's own pings never set it. */
  pinging: boolean
  lastPing: HostPingResult | null
  /** What an action failed with. Reading failures belong to the reader, which reports its own. */
  problem: string | null
}

export type HostDebugInput =
  | { input: 'status-arrived'; status: HostDebugStatus }
  | { input: 'ping-started' }
  /**
   * The same input for a ping this section asked for and one the main process took on its own,
   * and `mine` is which. Reading them alike let a loop result arriving mid-ping clear the flag
   * and open the button for a second manual ping while the first was still out.
   */
  | { input: 'ping-answered'; result: HostPingResult; mine?: true }
  | { input: 'start-host' }
  | { input: 'failed'; detail: string }

export type HostDebugEffect = { effect: 'ping' } | { effect: 'start-host' }

export interface HostDebugStep {
  state: HostDebugState
  effects: readonly HostDebugEffect[]
}

/**
 * What the host section knows and what it decides, with no I/O in sight. Reading the status is the
 * snapshot reader's job and drawing is the component's; this is the machine between them.
 *
 * Every verdict here is a derivation of facts that travelled. Nothing on the wire says "healthy":
 * a field like that would be a fourth opinion about presence, computed in the main process, out of
 * date by the time it is drawn, and impossible to disagree with when it is wrong.
 */
export class HostDebugModel {
  /**
   * Nothing read and nothing asked. The ping is not started here on purpose: every node of the host
   * tree runs this machine, and only the one that DRAWS a ping should be asking for one - the same
   * line the auto-ping gate in the main process draws.
   */
  static initial(): HostDebugState {
    return { status: null, pinging: false, lastPing: null, problem: null }
  }

  static transition(state: HostDebugState, input: HostDebugInput): HostDebugStep {
    if (input.input === 'status-arrived')
      return { state: { ...state, status: input.status }, effects: [] }
    else if (input.input === 'ping-started')
      // A ping that is still out is not asked again from here either: the loop in the main process
      // holds the same rule, and the two must not add up to two requests.
      return state.pinging
        ? { state, effects: [] }
        : { state: { ...state, pinging: true }, effects: [{ effect: 'ping' }] }
    else if (input.input === 'ping-answered') {
      // Only this section's own ping clears its own flag.
      const pinging = input.mine === true ? false : state.pinging
      // And the drawn ping is the LATEST one, not the last to arrive: a loop result can be
      // older than a manual one it lands behind, and reading it as newer walks the panel
      // backwards to a moment that has already passed.
      const lastPing = state.lastPing !== null && state.lastPing.at > input.result.at
        ? state.lastPing
        : input.result
      return { state: { ...state, pinging, lastPing }, effects: [] }
    }
    else if (input.input === 'start-host')
      return { state: { ...state, problem: null }, effects: [{ effect: 'start-host' }] }
    else if (input.input === 'failed')
      // The latch goes with it. `pinging` is cleared only by `ping-answered`, so a rejected invoke -
      // which skips that dispatch entirely - left the button `disabled` for the life of the window
      // with nothing said. The terminal panel fixed the same shape and wrote it up.
      return { state: { ...state, pinging: false, problem: input.detail }, effects: [] }
    else
      throw new Error(`Unknown host debug input: ${JSON.stringify(input)}`)
  }

  /**
   * The V1 design, unchanged: exact string comparison, three states, and a missing version on either
   * side is `unknown`. The honest limit is that both sides read the same `app-host/package.json`, so
   * this catches a version that moved, not an edit to a source file.
   */
  static versionVerdict(status: HostDebugStatus): HostVersionVerdict {
    const running = status.descriptor?.hostVersion ?? null
    if (running === null || status.expectedHostVersion === null)
      return 'unknown'
    return running === status.expectedHostVersion ? 'current' : 'stale'
  }

  /** Major only: the minor is what a compatible addition moves. */
  static protocolVerdict(status: HostDebugStatus): HostProtocolVerdict {
    if (status.descriptor === null)
      return 'unknown'
    return status.descriptor.protocol.major === status.clientProtocol.major ? 'match' : 'mismatch'
  }

  /**
   * Delegated, not repeated. The status bar and the sessions tree already read presence through
   * `HostStatusReading`, and a third switch on the same three-valued field is a third answer waiting
   * to disagree with the other two.
   */
  static headline(status: HostDebugStatus): HostReading {
    return HostStatusReading.of({
      presence: status.presence,
      hostVersion: status.descriptor?.hostVersion ?? null,
      hostInstanceId: status.descriptor?.hostInstanceId ?? null,
      liveCount: status.counts.live,
      lastStartError: status.controller.lastStartError,
    })
  }
}
