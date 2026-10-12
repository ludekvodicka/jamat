import type {
  RemoteControlActivityEntry,
  RemoteControlActivityKind,
  RemoteControlActivityPage,
} from './remoteControlApi.types'

/**
 * What changed, with what changed in it, for a caller that reads with a long poll: every successful
 * write and every change of sessions, tabs and commit reviews, numbered from 1 since this client
 * started. The WebSocket event stream beside it keeps its two payload-less kinds, because an older CLI
 * or peer refuses an event kind it does not know; this log is read only by a caller that asks for it.
 */
export class RemoteControlActivityLog {
  static readonly maximumWaitMillisecondsConst = 30_000
  private revision = 0
  private readonly entries: RemoteControlActivityEntry[] = []
  private readonly waiters = new Set<() => void>()

  constructor(
    private readonly limit = 2_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error(`Invalid activity log limit: ${JSON.stringify(limit)}`)
  }

  publish(kind: RemoteControlActivityKind, data: Record<string, unknown> = {}): RemoteControlActivityEntry {
    const entry = { revision: ++this.revision, kind, at: this.now(), data }
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.shift()
    for (const wake of [...this.waiters]) wake()
    return entry
  }

  /**
   * The entries after `after`, waiting at most `waitMs` for the first one. No `after` reads every
   * entry still kept. A number above the newest one comes from an earlier client start and reads from
   * the start; a number below the oldest kept one answers what is kept with `truncated`, so the
   * caller knows entries before them are gone and takes fresh reads.
   */
  async read(after: number | undefined, waitMs: number): Promise<RemoteControlActivityPage> {
    const page = this.page(after)
    if (page.entries.length > 0 || page.truncated || waitMs <= 0) return page
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.min(waitMs, RemoteControlActivityLog.maximumWaitMillisecondsConst))
      timer.unref?.()
      this.waiters.add(done)
    })
    return this.page(after)
  }

  private page(after: number | undefined): RemoteControlActivityPage {
    const oldest = this.entries[0]?.revision ?? this.revision + 1
    const from = after === undefined || after > this.revision ? 0 : after
    const truncated = after !== undefined && after <= this.revision && from < oldest - 1
    const entries = this.entries.filter((entry) => entry.revision > from)
    return { entries, last: this.revision, truncated }
  }
}
