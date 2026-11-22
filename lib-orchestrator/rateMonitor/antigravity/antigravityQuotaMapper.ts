import { JsonShape } from '../../shared/jsonShape'
import type { RateExtra, RateWindow } from '../rateMonitorApi.types'
import { RateMonitorLimits } from '../rateMonitorLimits'

export interface AntigravityQuotaMapped {
  readonly windows: readonly RateWindow[]
  readonly extras: readonly RateExtra[]
}

interface ParsedBucket {
  readonly id: string
  readonly durationMinutes: number
  readonly scope: string
  readonly usedPercent: number
  readonly resetsAt: string | null
}

/**
 * Maps Antigravity CLI's `statusLine` `quota` object (`{ [bucketId]: { remaining_fraction?,
 * remaining_amount?, reset_time?, reset_in_seconds?, disabled? } }`) into Jamat's `RateWindow`
 * and `RateExtra` model.
 *
 * Antigravity tracks model pools (e.g. `gemini-5h`, `gemini-weekly`, `claude-weekly`, `3p-weekly`)
 * as remaining fractions `0..1`, plus optional non-fractional credit pools (`remaining_amount`).
 * When a duration has a single bucket (or a `gemini` bucket alongside third-party pools), that
 * primary bucket becomes the plain `S`/`W` window so the status bar and estimator read it directly;
 * additional pools of the same duration keep their cleaned pool name as `model`.
 */
export class AntigravityQuotaMapper {
  private static readonly fiveHourThresholdSecondsConst = 18_600
  private static readonly durationSuffixesConst: readonly {
    readonly pattern: RegExp
    readonly minutes: (match: RegExpExecArray) => number
  }[] = [
    { pattern: /(?:^|[-_\s])(5h|five[-_ ]?hour|5[-_ ]?hour|session)$/i, minutes: () => RateMonitorLimits.sessionMinutes },
    { pattern: /(?:^|[-_\s])(weekly|7d|seven[-_ ]?day|week)$/i, minutes: () => RateMonitorLimits.weeklyMinutes },
    { pattern: /(?:^|[-_\s])(\d+)h$/i, minutes: (match) => Number(match[1]) * 60 },
    { pattern: /(?:^|[-_\s])(\d+)d$/i, minutes: (match) => Number(match[1]) * 1_440 },
  ]

  static map(quota: unknown, at?: number, planTier?: string | null): AntigravityQuotaMapped {
    const record = JsonShape.record(quota)
    if (record === null) return { windows: [], extras: [] }

    const parsed: ParsedBucket[] = []
    const extras: RateExtra[] = []

    if (typeof planTier === 'string' && planTier.trim().length > 0)
      extras.push({ label: 'Plan', detail: planTier.trim() })

    for (const [id, rawBucket] of Object.entries(record)) {
      const bucket = JsonShape.record(rawBucket)
      if (bucket === null || bucket.disabled === true) continue

      const remainingFraction = bucket.remaining_fraction
      if (typeof remainingFraction === 'number' && Number.isFinite(remainingFraction)) {
        const clamped = Math.max(0, Math.min(1, remainingFraction))
        const usedPercent = Math.round((1 - clamped) * 1_000) / 10
        const resetInSeconds = typeof bucket.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds)
          ? bucket.reset_in_seconds
          : null
        const resetsAt = AntigravityQuotaMapper.resetsAtOf(bucket.reset_time, resetInSeconds, at)
        const { durationMinutes, scope } = AntigravityQuotaMapper.durationAndScopeOf(id, resetInSeconds)
        parsed.push({ id, durationMinutes, scope, usedPercent, resetsAt })
        continue
      }

      const remainingAmount = bucket.remaining_amount
      if (typeof remainingAmount === 'number' && Number.isFinite(remainingAmount)) {
        extras.push({
          label: AntigravityQuotaMapper.extraLabelOf(id),
          detail: `${remainingAmount} remaining`,
        })
      }
    }

    const windows = AntigravityQuotaMapper.assignModels(parsed)
    return { windows, extras }
  }

  private static resetsAtOf(resetTime: unknown, resetInSeconds: number | null, at: number | undefined): string | null {
    if (typeof resetTime === 'string' && resetTime.trim().length > 0) {
      const parsed = Date.parse(resetTime)
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
    }
    if (resetInSeconds !== null && resetInSeconds >= 0 && typeof at === 'number' && Number.isFinite(at)) {
      const computed = new Date(at + resetInSeconds * 1_000)
      if (Number.isFinite(computed.getTime())) return computed.toISOString()
    }
    return null
  }

  private static durationAndScopeOf(
    id: string,
    resetInSeconds: number | null,
  ): { durationMinutes: number; scope: string } {
    const trimmed = id.trim()
    for (const entry of AntigravityQuotaMapper.durationSuffixesConst) {
      const match = entry.pattern.exec(trimmed)
      if (match === null) continue
      const minutes = entry.minutes(match)
      if (!Number.isFinite(minutes) || minutes <= 0) continue
      const scope = trimmed.slice(0, match.index).replace(/[-_\s]+$/g, '').toLowerCase()
      return { durationMinutes: minutes, scope }
    }
    const durationMinutes = resetInSeconds !== null && resetInSeconds > 0
      && resetInSeconds <= AntigravityQuotaMapper.fiveHourThresholdSecondsConst
      ? RateMonitorLimits.sessionMinutes
      : RateMonitorLimits.weeklyMinutes
    return { durationMinutes, scope: trimmed.toLowerCase() }
  }

  private static assignModels(buckets: readonly ParsedBucket[]): readonly RateWindow[] {
    const byDuration = new Map<number, ParsedBucket[]>()
    for (const bucket of buckets) {
      const list = byDuration.get(bucket.durationMinutes) ?? []
      list.push(bucket)
      byDuration.set(bucket.durationMinutes, list)
    }

    const windows: RateWindow[] = []
    for (const [, group] of byDuration) {
      const plain = AntigravityQuotaMapper.primaryBucketOf(group)
      for (const bucket of group) {
        const window: RateWindow = {
          durationMinutes: bucket.durationMinutes,
          usedPercent: bucket.usedPercent,
          resetsAt: bucket.resetsAt,
        }
        if (bucket !== plain && bucket.scope.length > 0)
          window.model = bucket.scope
        windows.push(window)
      }
    }

    windows.sort((left, right) => {
      const leftScoped = left.model === undefined ? 0 : 1
      const rightScoped = right.model === undefined ? 0 : 1
      if (leftScoped !== rightScoped) return leftScoped - rightScoped
      if (left.durationMinutes !== right.durationMinutes) return left.durationMinutes - right.durationMinutes
      return (left.model ?? '').localeCompare(right.model ?? '')
    })
    return windows
  }

  private static primaryBucketOf(group: readonly ParsedBucket[]): ParsedBucket | null {
    const unprefixed = group.find((bucket) => bucket.scope.length === 0)
    if (unprefixed !== undefined) return unprefixed
    if (group.length === 1) return group[0]!
    const exactGemini = group.find((bucket) => bucket.scope === 'gemini')
    if (exactGemini !== undefined) return exactGemini
    return null
  }

  private static extraLabelOf(id: string): string {
    return id
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(' ')
  }
}
