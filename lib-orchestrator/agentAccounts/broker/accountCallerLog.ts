import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonShape } from '../../shared/jsonShape'
import { MonthlyJsonl } from './monthlyJsonl'
import { AccountBrokerAnswers } from '../accountBrokerAnswer'
import type { AccountBrokerPurpose, AccountBrokerReason, AccountCallerEntry, AccountCallerSummary, AccountCallersView } from '../accountBrokerApi.types'

/**
 * The picks that reached this Jamat, one JSONL file per UTC month. A read keeps the last 30 days;
 * `prune` deletes the month files that ended before them.
 */
export class AccountCallerLog {
  static readonly windowDaysConst = 30
  static readonly recentLimitConst = 50
  private static readonly dayMsConst = 24 * 60 * 60_000
  private readonly directory: string
  private queue: Promise<void> = Promise.resolve()

  constructor(directory: string) {
    this.directory = directory
  }

  append(entry: AccountCallerEntry): Promise<void> {
    const work = this.queue.then(() => MonthlyJsonl.append(this.directory, entry.at, entry))
    this.queue = work.catch(() => {})
    return work
  }

  async view(now: number): Promise<Omit<AccountCallersView, 'command'>> {
    await this.queue
    const from = now - AccountCallerLog.windowDaysConst * AccountCallerLog.dayMsConst
    const entries: AccountCallerEntry[] = []
    for (const file of await MonthlyJsonl.files(this.directory)) {
      if (MonthlyJsonl.monthEnd(file) <= from) continue
      for (const entry of await MonthlyJsonl.read(this.directory, file, AccountCallerLog.entryOf))
        if (entry.at >= from && entry.at <= now) entries.push(entry)
    }
    entries.sort((a, b) => a.at - b.at)
    return { capturedAt: now, windowDays: AccountCallerLog.windowDaysConst, callers: AccountCallerLog.summaries(entries),
      recent: entries.slice(-AccountCallerLog.recentLimitConst).reverse() }
  }

  async prune(now: number): Promise<void> {
    await this.queue
    const cutoff = now - AccountCallerLog.windowDaysConst * AccountCallerLog.dayMsConst
    for (const file of await MonthlyJsonl.files(this.directory))
      if (MonthlyJsonl.monthEnd(file) <= cutoff) await unlink(join(this.directory, file))
  }

  /** One row per caller, the newest caller first; `entries` are in time order. */
  static summaries(entries: readonly AccountCallerEntry[]): AccountCallerSummary[] {
    const callers = new Map<string, { summary: AccountCallerSummary; accounts: Map<string, { accountId: string; label: string; calls: number }> }>()
    for (const entry of entries) {
      let row = callers.get(entry.caller)
      if (!row) {
        row = { summary: { caller: entry.caller, lastAt: entry.at, calls: 0, fallbacks: 0, purposes: { interactive: 0, background: 0 }, accounts: [] },
          accounts: new Map() }
        callers.set(entry.caller, row)
      }
      row.summary.lastAt = Math.max(row.summary.lastAt, entry.at)
      row.summary.calls += 1
      if (entry.fallback) row.summary.fallbacks += 1
      row.summary.purposes[entry.purpose] += 1
      const account = row.accounts.get(entry.accountId) ?? { accountId: entry.accountId, label: entry.accountLabel, calls: 0 }
      account.label = entry.accountLabel
      account.calls += 1
      row.accounts.set(entry.accountId, account)
    }
    return [...callers.values()]
      .map(({ summary, accounts }) => ({ ...summary, accounts: [...accounts.values()].sort((a, b) => b.calls - a.calls) }))
      .sort((a, b) => b.lastAt - a.lastAt)
  }

  private static entryOf(value: unknown): AccountCallerEntry | null {
    const row = JsonShape.record(value)
    const purposes: readonly string[] = AccountBrokerAnswers.purposesConst
    if (!row || typeof row.at !== 'number' || !Number.isFinite(row.at) || typeof row.caller !== 'string'
      || typeof row.purpose !== 'string' || !purposes.includes(row.purpose) || typeof row.accountId !== 'string'
      || typeof row.accountLabel !== 'string' || typeof row.fallback !== 'boolean' || typeof row.reason !== 'string'
      || typeof row.durationMs !== 'number' || !Number.isFinite(row.durationMs)) return null
    return { at: row.at, caller: row.caller, purpose: row.purpose as AccountBrokerPurpose, accountId: row.accountId,
      accountLabel: row.accountLabel, fallback: row.fallback, reason: row.reason as AccountBrokerReason, durationMs: row.durationMs }
  }
}
