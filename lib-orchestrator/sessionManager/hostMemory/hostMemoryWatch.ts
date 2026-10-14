import type { HostHealthResult } from '../../../app-host/app/wire/hostWire.js'
import type { HostCallResult } from '../../hostClient/hostClient.types'
import type { HostMemoryReading } from '../sessionManagerApi.types'
import { HostMemoryReadings } from './hostMemoryReadings'

export interface HostMemoryWatchDeps {
  /** Null when the running Host does not offer `host.health`. */
  read: () => Promise<HostCallResult<HostHealthResult> | null>
  now: () => number
}

/**
 * The Host's memory reading this client holds. It owns no clock: the session poll hands it the Host
 * it sees, and it asks the Host at most once per ten minutes, or at once when that Host changed.
 * The reading moves only when an answer arrives, so the poll does not move the snapshot's revision.
 */
export class HostMemoryWatch {
  static readonly readEveryMillisecondsConst = 10 * 60_000
  private readonly read: HostMemoryWatchDeps['read']
  private readonly now: () => number
  private hostInstanceId: string | null = null
  private readAt: number | null = null
  private inFlight = false
  private readingValue: HostMemoryReading | null = null

  constructor(deps: HostMemoryWatchDeps) {
    this.read = deps.read
    this.now = deps.now
  }

  reading(): HostMemoryReading | null {
    return this.readingValue
  }

  /** True when the reading changed, which is the only time the snapshot has to be recomposed. */
  async observe(hostInstanceId: string | null): Promise<boolean> {
    let changed = false
    if (hostInstanceId !== this.hostInstanceId) {
      this.hostInstanceId = hostInstanceId
      this.readAt = null
      changed = this.readingValue !== null
      this.readingValue = null
    }
    if (hostInstanceId === null || this.inFlight) return changed
    const now = this.now()
    if (this.readAt !== null && now - this.readAt < HostMemoryWatch.readEveryMillisecondsConst) return changed
    this.inFlight = true
    this.readAt = now
    try {
      const answer = await this.read()
      // An answer from the Host that has since been replaced says nothing about the one running now.
      if (this.hostInstanceId !== hostInstanceId) return changed
      // A failed read keeps the last reading: the presence already says the Host cannot be reached.
      if (answer !== null && !answer.ok) return changed
      this.readingValue = answer === null ? HostMemoryReadings.notReportedConst : HostMemoryReadings.of(answer.value)
      return true
    } finally {
      this.inFlight = false
    }
  }
}
