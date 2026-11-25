import type { RateWindow } from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { AccountCapacity } from '../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import type { PoolSeries, UsageAccount } from '../../../lib-orchestrator/rateMonitor/usageApi.types'

export type PoolRangePreset = 'forecast' | 'day' | 'week' | 'month' | 'custom'
export type TokenPeriodPreset = 'today' | 'week' | 'month' | 'custom'

export class UsageModel {
  static readonly agentLabels = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }
  static readonly sessionMinutesConst = 300
  static readonly weeklyMinutesConst = 10080
  /** The server projects at most 31 days ahead (`usage.history`). */
  static readonly projectionDaysConst = 31
  static readonly poolRangesConst: readonly { value: PoolRangePreset; label: string }[] = [
    { value: 'forecast', label: 'Forecast' }, { value: 'day', label: '24 hours' }, { value: 'week', label: '7 days' },
    { value: 'month', label: '30 days' }, { value: 'custom', label: 'Custom' },
  ]
  static readonly tokenPeriodsConst: readonly { value: TokenPeriodPreset; label: string }[] = [
    { value: 'today', label: 'Today' }, { value: 'week', label: '7 days' },
    { value: 'month', label: '30 days' }, { value: 'custom', label: 'Custom' },
  ]

  /**
   * The range read from `usage.history`. Forecast starts half a day before the current weekly window
   * (a day back without a reset time) and reaches a week ahead. The 24 hour, 7 and 30 day ranges read
   * the whole projection horizon, so the Runs out figure stays true and `poolView` can stretch the
   * longer two to the empty pool.
   */
  static poolRange(preset: Exclude<PoolRangePreset, 'custom'>, now: number, cycleStart: number | null): { from: number; to: number } {
    if (preset === 'forecast')
      return { from: cycleStart === null ? now - 86_400_000 : cycleStart - 12 * 3_600_000, to: now + 7 * 86_400_000 }
    else if (preset === 'day')
      return { from: now - 86_400_000, to: now + UsageModel.projectionDaysConst * 86_400_000 }
    else if (preset === 'week')
      return { from: now - 7 * 86_400_000, to: now + UsageModel.projectionDaysConst * 86_400_000 }
    else if (preset === 'month')
      return { from: now - 30 * 86_400_000, to: now + UsageModel.projectionDaysConst * 86_400_000 }
    else
      throw new Error(`Unknown pool range: ${JSON.stringify(preset)}`)
  }

  /**
   * The drawn bounds. Forecast and Custom draw what they read. 24 hours adds six hours of projection
   * and never stretches: it is the close view of the recent burn. The 7 and 30 day ranges add a few
   * days of projection, and more when that is what it takes to show the pool running empty.
   */
  static poolView(preset: PoolRangePreset, series: PoolSeries): { from: number; to: number } | undefined {
    const range = series.displayRange
    if (preset === 'forecast' || preset === 'custom' || !range)
      return range
    if (preset === 'day')
      return { from: range.from, to: Math.min(series.until, series.now + 6 * 3_600_000) }
    const ahead = preset === 'week' ? 2 * 86_400_000 : preset === 'month' ? 7 * 86_400_000 : null
    if (ahead === null)
      throw new Error(`Unknown pool range: ${JSON.stringify(preset)}`)
    const empty = series.poolEmptyAt
    const end = empty === null ? series.now + ahead : Math.max(series.now + ahead, empty + (empty - range.from) / 20)
    return { from: range.from, to: Math.min(series.until, end) }
  }

  /**
   * The earliest start of an enabled account's current weekly window, or null when no account has a
   * reset time. Floored to the hour: a reset time derived from seconds-until-reset drifts between
   * readings, and every change would read the history again.
   */
  static cycleStart(accounts: readonly UsageAccount[], now: number): number | null {
    const week = UsageModel.weeklyMinutesConst * 60_000
    const starts = accounts.flatMap(account => {
      const reset = account.enabled ? Date.parse(UsageModel.window(account, UsageModel.weeklyMinutesConst)?.resetsAt ?? '') : NaN
      return Number.isFinite(reset) ? [reset - Math.ceil((reset - now) / week) * week] : []
    })
    return starts.length === 0 ? null : Math.floor(Math.min(...starts) / 3_600_000) * 3_600_000
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

  /** What an account's weight in the weekly pool stands for. */
  static planTitle(capacity: AccountCapacity): string {
    return `${capacity.tier ?? 'Plan unknown'}: weight ${capacity.weight} in the weekly pool and the account choice`
  }

  /** `ok` above half, `warn` above a fifth, `danger` below: the colour of a remaining quota. */
  static level(remainingPercent: number): 'ok' | 'warn' | 'danger' {
    return remainingPercent > 50 ? 'ok' : remainingPercent > 20 ? 'warn' : 'danger'
  }
}
