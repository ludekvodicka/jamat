import { JsonShape } from '../../shared/jsonShape'
import type { RateExtra, RateWindow } from '../rateMonitorApi.types'
import { RateMonitorLimits } from '../rateMonitorLimits'

export interface ClaudeUsageReading {
  windows: readonly RateWindow[]
  extras: readonly RateExtra[]
}

/**
 * The usage endpoint's body, reduced to windows. Undocumented and visibly experimental: the observed
 * response carried nine null buckets under codenames (`tangelo`, `nimbus_quill`, `cinder_cove`, ...)
 * beside the two that mean something, and which of them exist is the server's business rather than
 * this mapper's. So nothing here enumerates what to ignore - it reads the fields it knows and leaves
 * the rest where they are, which is why a new codename tomorrow is not a change to this file.
 *
 * A window is matched on what it IS, its length and its model, never on where in the body it sat.
 * What was not answered is not a window: an absent bucket produces nothing rather than a zero, which
 * is the difference between "this account has no weekly cap" and "the weekly cap is untouched".
 */
export class ClaudeUsageResponse {
  private static readonly scopedWeeklyKindConst = 'weekly_scoped'

  static of(body: unknown): ClaudeUsageReading {
    const record = JsonShape.record(body)
    if (record === null) return { windows: [], extras: [] }
    const session = RateMonitorLimits.sessionMinutes
    const weekly = RateMonitorLimits.weeklyMinutes
    // Keyed by what identifies a window, so the same one reaching this twice lands once.
    const windows = new Map<string, RateWindow>()
    ClaudeUsageResponse.addBucket(windows, record['five_hour'], session, null)
    ClaudeUsageResponse.addBucket(windows, record['seven_day'], weekly, null)
    // The flat model-scoped pair was null on the account this was captured from, and the same
    // percentage arrived under `limits[]` instead. Both are read because neither is guaranteed: the
    // pair is what an account that populates it answers with, the list is what this one did.
    ClaudeUsageResponse.addBucket(windows, record['seven_day_opus'], weekly, 'opus')
    ClaudeUsageResponse.addBucket(windows, record['seven_day_sonnet'], weekly, 'sonnet')
    ClaudeUsageResponse.addScopedWeeklies(windows, record['limits'])
    return {
      windows: [...windows.values()],
      extras: ClaudeUsageResponse.extrasOf(record['extra_usage']),
    }
  }

  /** One of the flat buckets, which carry their percentage as `utilization`. */
  private static addBucket(
    into: Map<string, RateWindow>,
    value: unknown,
    durationMinutes: number,
    model: string | null,
  ): void {
    const bucket = JsonShape.record(value)
    if (bucket === null) return
    ClaudeUsageResponse.add(into, bucket['utilization'], bucket['resets_at'], durationMinutes, model)
  }

  /**
   * `limits[]` restates the session and the weekly window that the flat fields already carry, and
   * adds the one thing they do not: a weekly scoped to a model, named only there. Only that kind is
   * taken, and the restatements would land on a key that is already spoken for anyway.
   */
  private static addScopedWeeklies(into: Map<string, RateWindow>, value: unknown): void {
    if (!Array.isArray(value)) return
    for (const member of value) {
      const entry = JsonShape.record(member)
      if (entry === null) continue
      if (entry['kind'] !== ClaudeUsageResponse.scopedWeeklyKindConst) continue
      const model = ClaudeUsageResponse.scopedModelOf(entry['scope'])
      if (model === null) continue
      const weekly = RateMonitorLimits.weeklyMinutes
      ClaudeUsageResponse.add(into, entry['percent'], entry['resets_at'], weekly, model)
    }
  }

  private static scopedModelOf(value: unknown): string | null {
    const model = JsonShape.record(JsonShape.record(value)?.['model'])
    const name = model?.['display_name']
    if (typeof name !== 'string') return null
    const cleaned = name.trim().toLowerCase()
    return cleaned.length > 0 ? cleaned : null
  }

  /** First writer wins, which keeps a flat field authoritative where an account fills it in. */
  private static add(
    into: Map<string, RateWindow>,
    percent: unknown,
    resetsAt: unknown,
    durationMinutes: number,
    model: string | null,
  ): void {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return
    const key = `${durationMinutes}:${model ?? ''}`
    if (into.has(key)) return
    const window: RateWindow = {
      durationMinutes,
      // The percentage is the width of a meter, and a server that ever answers 130 must not draw one
      // that leaves its track.
      usedPercent: Math.min(100, Math.max(0, percent)),
      resetsAt: typeof resetsAt === 'string' && resetsAt.length > 0 ? resetsAt : null,
    }
    if (model !== null) window.model = model
    into.set(key, window)
  }

  /**
   * Extra usage has no window of its own, so it is a line of text and nothing else. Only the fields
   * whose meaning is unambiguous are read: the account this was captured from had it switched off,
   * so the shape of an ENABLED one was never observed, and `used_credits` beside a `decimal_places`
   * is exactly the pair a guess would report wrong.
   */
  private static extrasOf(value: unknown): readonly RateExtra[] {
    const record = JsonShape.record(value)
    if (record === null) return []
    if (record['is_enabled'] !== true) {
      const reason = record['disabled_reason']
      const detail = typeof reason === 'string' && reason.length > 0 ? reason : 'off'
      return [{ label: 'Extra usage', detail }]
    }
    const utilization = record['utilization']
    if (typeof utilization !== 'number' || !Number.isFinite(utilization))
      return [{ label: 'Extra usage', detail: 'on' }]
    return [{ label: 'Extra usage', detail: `${Math.round(utilization)}% used` }]
  }

}
