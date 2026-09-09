import { JsonShape } from '../../shared/jsonShape'
import { JsonNumber } from '../../shared/jsonNumber'
import type { RateWindow } from '../rateMonitorApi.types'

/**
 * The `account/rateLimits/read` result reduced to the windows a surface draws.
 *
 * Tolerant in one direction only: a field that is not there is not invented, and a window that
 * cannot say how long it is or how much of it is spent is dropped rather than drawn as a zero. The
 * server is free to grow fields, and none of them can break this.
 */
export class CodexRateLimitMapping {
  /** Both are read; either may be absent, and 0.146.0 answers `secondary: null` on a weekly plan. */
  private static readonly windowKeysConst = ['primary', 'secondary'] as const
  /** The one limit that is the account's own. The map beside it also carries per-model entries. */
  private static readonly ownLimitIdConst = 'codex'

  static windowsOf(value: unknown): readonly RateWindow[] {
    const response = JsonShape.record(value)
    if (response === null) return []
    // `rateLimitsByLimitId.codex` wins over the flat `rateLimits`, which is the same snapshot under
    // an older name: newer servers answer both, older ones only the flat one.
    const byLimitId = JsonShape.record(response.rateLimitsByLimitId)
    const snapshot = JsonShape.record(byLimitId?.[CodexRateLimitMapping.ownLimitIdConst])
      ?? JsonShape.record(response.rateLimits)
    if (snapshot === null) return []
    // Keyed by length, so a server naming the same window twice answers one window rather than two.
    const windows = new Map<number, RateWindow>()
    for (const key of CodexRateLimitMapping.windowKeysConst) {
      const window = CodexRateLimitMapping.windowOf(snapshot[key])
      if (window !== null) windows.set(window.durationMinutes, window)
    }
    return [...windows.values()]
  }

  private static windowOf(value: unknown): RateWindow | null {
    const record = JsonShape.record(value)
    if (record === null) return null
    const durationMinutes = JsonNumber.finite(record.windowDurationMins)
    const usedPercent = JsonNumber.finite(record.usedPercent)
    if (durationMinutes === null || durationMinutes <= 0 || usedPercent === null) return null
    const resetsAtSeconds = JsonNumber.finite(record.resetsAt)
    return {
      durationMinutes,
      // Clamped rather than trusted: a percentage is what a meter is drawn from, and a server that
      // counts an overrun past 100 would draw a bar out of its own box.
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetsAt: resetsAtSeconds === null
        ? null
        : CodexRateLimitMapping.isoOfSeconds(resetsAtSeconds),
    }
  }

  /** Codex counts the reset in epoch SECONDS; the wire type carries an ISO string. */
  private static isoOfSeconds(seconds: number): string | null {
    const moment = new Date(seconds * 1000)
    return Number.isNaN(moment.getTime()) ? null : moment.toISOString()
  }
}
