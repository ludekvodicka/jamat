import type { RateWindow } from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { UsageAccount } from '../../../lib-orchestrator/rateMonitor/usageApi.types'

export type PoolRangePreset = 'forecast' | 'week' | 'month' | 'custom'
export type TokenPeriodPreset = 'today' | 'week' | 'month' | 'custom'

export class UsageModel {
  static readonly agentLabels = { claude: 'Claude', codex: 'Codex' }
  static readonly sessionMinutesConst = 300
  static readonly weeklyMinutesConst = 10080
  static readonly poolRangesConst: readonly { value: PoolRangePreset; label: string }[] = [
    { value: 'forecast', label: 'Forecast' }, { value: 'week', label: '7 days' },
    { value: 'month', label: '30 days' }, { value: 'custom', label: 'Custom' },
  ]
  static readonly tokenPeriodsConst: readonly { value: TokenPeriodPreset; label: string }[] = [
    { value: 'today', label: 'Today' }, { value: 'week', label: '7 days' },
    { value: 'month', label: '30 days' }, { value: 'custom', label: 'Custom' },
  ]

  /** Forecast is a day back and a week ahead: the recent burn and when it runs out. */
  static poolRange(preset: Exclude<PoolRangePreset, 'custom'>, now: number): { from: number; to: number } {
    if (preset === 'forecast')
      return { from: now - 86_400_000, to: now + 7 * 86_400_000 }
    else if (preset === 'week')
      return { from: now - 7 * 86_400_000, to: now }
    else if (preset === 'month')
      return { from: now - 30 * 86_400_000, to: now }
    else
      throw new Error(`Unknown pool range: ${JSON.stringify(preset)}`)
  }

  /** Whole local days, today included. */
  static tokenPeriod(preset: Exclude<TokenPeriodPreset, 'custom'>, now: Date): { from: string; to: string } {
    const days = preset === 'today' ? 1 : preset === 'week' ? 7 : preset === 'month' ? 30 : null
    if (days === null)
      throw new Error(`Unknown token period: ${JSON.stringify(preset)}`)
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
    return { from: UsageModel.day(from), to: UsageModel.day(now) }
  }

  static day(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  /** The value of a `datetime-local` input for a moment, in local time. */
  static localInput(at: number): string {
    const date = new Date(at)
    return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  }

  /** The provider-wide window of one duration; a per-model window is a detail, not the quota. */
  static window(account: UsageAccount, durationMinutes: number): RateWindow | null {
    const windows = account.estimated?.windows ?? ('windows' in account.state ? account.state.windows : [])
    return windows.find((item) => item.durationMinutes === durationMinutes && !item.model) ?? null
  }

  /** Null for a fresh measurement: only a reading that is not one is worth words on screen. */
  static readingNote(account: UsageAccount): string | null {
    if (account.estimated)
      return `estimate, ${UsageModel.duration(account.estimated.ageMilliseconds)} old`
    const state = account.state
    if (state.kind === 'ok')
      return null
    else if (state.kind === 'stale' || state.kind === 'unconfigured')
      return state.reason
    else if (state.kind === 'never-read')
      return 'no reading yet'
    else
      throw new Error(`Unknown rate state: ${JSON.stringify(state)}`)
  }

  /** Null for an active account, which is the normal case and needs no label. */
  static accountNote(account: UsageAccount): string | null {
    if (account.accountState === 'active')
      return null
    else if (account.accountState === 'disabled')
      return 'disabled'
    else if (account.accountState === 'needs-login')
      return 'needs login'
    else if (account.accountState === 'pending-login')
      return 'login pending'
    else
      throw new Error(`Unknown account state: ${JSON.stringify(account.accountState)}`)
  }

  /** `45m`, `3h 20m`, `1d 22h`: two units at most, because the third is noise at this scale. */
  static duration(milliseconds: number): string {
    const minutes = Math.max(0, Math.round(milliseconds / 60_000))
    if (minutes < 60)
      return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24)
      return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
    const days = Math.floor(hours / 24)
    return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
  }

  static relative(at: number, now: number): string {
    const delta = at - now
    if (Math.abs(delta) < 60_000)
      return 'now'
    return delta > 0 ? `in ${UsageModel.duration(delta)}` : `${UsageModel.duration(-delta)} ago`
  }

  /** Time alone today, weekday within a week, date beyond it. */
  static when(at: number, now: number): string {
    const date = new Date(at)
    const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    if (new Date(now).toDateString() === date.toDateString())
      return time
    if (Math.abs(at - now) < 6 * 86_400_000)
      return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
    return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
  }

  static tokens(value: number): string {
    const units: readonly [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]
    for (const [size, suffix] of units)
      if (value >= size)
        return `${(value / size).toFixed(value >= size * 100 ? 0 : 1)}${suffix}`
    return String(Math.round(value))
  }

  /** The remaining share of the accounts that have a reading, or null when none has. */
  static remainingShare(remaining: number, known: number): number | null {
    return known === 0 ? null : remaining / known
  }

  /** `ok` above half, `warn` above a fifth, `danger` below: the colour of a remaining quota. */
  static level(remainingPercent: number): 'ok' | 'warn' | 'danger' {
    return remainingPercent > 50 ? 'ok' : remainingPercent > 20 ? 'warn' : 'danger'
  }
}
