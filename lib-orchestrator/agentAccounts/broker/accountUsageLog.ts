import { JsonShape } from '../../shared/jsonShape'
import type { TokenBucket } from '../../tokenUsage/tokenUsageApi.types'
import { AccountBrokerAnswers } from '../accountBrokerAnswer'
import type { AccountBrokerPurpose, AccountUsageCounts, AccountUsageEntry } from '../accountBrokerApi.types'
import { MonthlyJsonl } from './monthlyJsonl'

/**
 * The token usage that broker callers reported, one JSONL file per UTC month and no pruning: a run
 * is about 200 bytes. The entries are read once and then kept in memory beside each append, because
 * the token statistics read them on every refresh.
 */
export class AccountUsageLog {
  private static readonly projectPrefixConst = 'third-party/'
  private readonly directory: string
  private queue: Promise<void> = Promise.resolve()
  private loaded: Promise<AccountUsageEntry[]> | null = null

  constructor(directory: string) {
    this.directory = directory
  }

  append(entry: AccountUsageEntry): Promise<void> {
    const work = this.queue.then(async () => {
      const entries = await this.entries()
      await MonthlyJsonl.append(this.directory, entry.at, entry)
      entries.push(entry)
    })
    this.queue = work.catch(() => {})
    return work
  }

  /**
   * One token bucket per reported model, in the caller's own project key, so the token statistics
   * group a caller apart from the session projects; `labels` names each key.
   */
  async buckets(): Promise<{ buckets: TokenBucket[]; labels: Record<string, string> }> {
    await this.queue
    const buckets: TokenBucket[] = [], labels: Record<string, string> = {}
    for (const entry of await this.entries()) {
      const date = new Date(entry.at), projectKey = AccountUsageLog.projectPrefixConst + entry.caller
      labels[projectKey] = `${entry.caller} (3rd party)`
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      for (const [model, counts] of Object.entries(entry.models))
        buckets.push({ day, hour: date.getHours(), projectKey, agentId: 'claude', accountId: entry.accountId, model, ...counts })
    }
    return { buckets, labels }
  }

  private entries(): Promise<AccountUsageEntry[]> {
    this.loaded ??= this.load().catch(error => { this.loaded = null; throw error })
    return this.loaded
  }

  private async load(): Promise<AccountUsageEntry[]> {
    const entries: AccountUsageEntry[] = []
    for (const file of (await MonthlyJsonl.files(this.directory)).sort())
      entries.push(...await MonthlyJsonl.read(this.directory, file, AccountUsageLog.entryOf))
    return entries
  }

  private static entryOf(value: unknown): AccountUsageEntry | null {
    const row = JsonShape.record(value)
    const purposes: readonly string[] = AccountBrokerAnswers.purposesConst
    const models = JsonShape.record(row?.models)
    if (!row || !models || typeof row.at !== 'number' || !Number.isFinite(row.at) || typeof row.caller !== 'string'
      || typeof row.purpose !== 'string' || !purposes.includes(row.purpose) || typeof row.accountId !== 'string') return null
    const counts: Record<string, AccountUsageCounts> = {}
    for (const [model, item] of Object.entries(models)) {
      const usage = JsonShape.record(item)
      if (!usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(AccountBrokerAnswers.count)) return null
      counts[model] = { input: usage.input as number, output: usage.output as number,
        cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number }
    }
    return { at: row.at, caller: row.caller, purpose: row.purpose as AccountBrokerPurpose, accountId: row.accountId, models: counts }
  }
}
