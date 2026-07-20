import type { UsageWindow } from '../../types/session.js'

export class CodexRateLimits {
  static windowsFromResponse(value: unknown): UsageWindow[] {
    const response = CodexRateLimits.asRecord(value)
    if (!response) return []
    const byId = CodexRateLimits.asRecord(response.rateLimitsByLimitId)
    const snapshot = CodexRateLimits.asRecord(byId?.codex) ?? CodexRateLimits.asRecord(response.rateLimits)
    if (!snapshot) return []

    const windows = new Map<number, UsageWindow>()
    for (const key of ['primary', 'secondary'] as const) {
      const window = CodexRateLimits.asRecord(snapshot[key])
      if (!window) continue
      const durationMinutes = CodexRateLimits.finiteNumber(window.windowDurationMins)
      const usedPercent = CodexRateLimits.finiteNumber(window.usedPercent)
      if (durationMinutes === null || durationMinutes <= 0 || usedPercent === null) continue
      const resetsAtSeconds = CodexRateLimits.finiteNumber(window.resetsAt)
      windows.set(durationMinutes, {
        durationMinutes,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetsAt: resetsAtSeconds === null ? null : CodexRateLimits.isoFromSeconds(resetsAtSeconds),
      })
    }
    return [...windows.values()]
  }

  private static asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  }

  private static finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  private static isoFromSeconds(seconds: number): string | null {
    const date = new Date(seconds * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
}
