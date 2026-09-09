import type { HostPingResult } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import type { DebugSectionId } from '../../shared/debugSections.types'
import { ErrorText } from '../../shared/errorText'

export interface HostPingLoopDeps {
  ping: () => Promise<HostPingResult>
  publish: (result: HostPingResult) => void
}

/**
 * The one timer that keeps a latency reading moving while somebody is looking at it.
 *
 * **A deliberate exception, held in bounds by how it is built.** The rule it stands beside is one
 * poll and one listing: the session manager owns the only cadence in this client, and a second timer
 * meant two opinions about what unreachable means. This one asks a different question over a
 * different route - `GET /hello`, answered out of the Host's memory - and never touches
 * `runtime.list`.
 *
 * It also differs from V1's freeze in every particular. There, one timer per terminal panel fired
 * every five seconds whatever was on screen, and its handler walked the disk six levels deep; ten
 * tabs were ten scans and the main process stopped keeping up. Here there is ONE timer for the whole
 * client, it stands still unless the window can be seen AND the section that shows a ping is the
 * active one, and a request that is still in flight skips the next tick instead of stacking behind it.
 */
export class HostPingLoop {
  private static readonly intervalMillisecondsConst = 5_000
  private windowVisible = false
  private activeSection: DebugSectionId | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = false

  constructor(private readonly deps: HostPingLoopDeps) {}

  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible
    this.settle()
  }

  setActiveSection(section: DebugSectionId | null): void {
    this.activeSection = section
    this.settle()
  }

  /** A closed gate is a timer that is not armed at all, rather than one that ticks and does nothing. */
  private gateOpen(): boolean {
    return this.windowVisible && this.activeSection === 'host'
  }

  private settle(): void {
    if (this.gateOpen()) this.arm()
    else this.clearTimer()
  }

  private arm(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.detach(this.tick())
      },
      HostPingLoop.intervalMillisecondsConst,
    )
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    // The gate can close between arming and firing, and a ping that is still out is a ping that has
    // not answered: either way this tick is skipped and the loop simply arms itself again.
    if (!this.gateOpen() || this.inFlight) {
      this.settle()
      return
    }
    this.inFlight = true
    try {
      this.deps.publish(await this.deps.ping())
    } finally {
      this.inFlight = false
      this.settle()
    }
  }

  /** Nobody waits for a tick, so an escape from one would be an unhandled rejection in main. */
  private detach(work: Promise<void>): void {
    void work.catch((error: unknown) =>
      AppClientUiReport.error(`the Host ping loop failed: ${ErrorText.of(error)}`))
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
