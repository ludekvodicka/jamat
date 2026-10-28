import { basename, join } from 'node:path'
import type { AccountView } from '../agentAccounts/agentAccountsApi.types'
import type { TokenAccountResolver } from './tokenUsageSource'
import { usageJson, usageNumber, usageObject, type TokenUsageSource, type UsageParserState, type UsageRecord } from './tokenUsageSource'

export class CodexUsageParser {
  static readonly accountLabels = { 'codex/other-codex-account': 'Other Codex account' }
  static accountResolver(accounts: readonly AccountView[]): TokenAccountResolver {
    const identities = new Map(accounts.filter(account => account.agentId === 'codex' && account.identity !== null)
      .map(account => [account.identity!.key, account.accountId]))
    return (_nativeId, _at, rolloutAccount) => rolloutAccount === null ? 'main' : identities.get(rolloutAccount) ?? 'other-codex-account'
  }

  static source(home: string): TokenUsageSource {
    return { agentId: 'codex', root: join(home, 'sessions'), accepts: name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
      initial: file => ({ nativeId: basename(file, '.jsonl'), cwd: '', model: 'unknown', rolloutAccount: null, cumulative: null }),
      parse: CodexUsageParser.parse }
  }

  static parse(line: string, state: UsageParserState): UsageRecord | null {
    const row = usageJson(line), payload = usageObject(row?.payload)
    if (!row || !payload) return null
    if (row.type === 'session_meta') {
      if (typeof payload.id === 'string') state.nativeId = payload.id
      if (typeof payload.cwd === 'string') state.cwd = payload.cwd
      if (typeof payload.creator_account_id === 'string') state.rolloutAccount = payload.creator_account_id
      return null
    }
    if (row.type === 'turn_context') {
      if (typeof payload.model === 'string') state.model = payload.model
      if (typeof payload.cwd === 'string') state.cwd = payload.cwd
      return null
    }
    if (row.type !== 'event_msg' || payload.type !== 'token_count') return null
    const info = usageObject(payload.info), total = usageObject(info?.total_token_usage), last = usageObject(info?.last_token_usage)
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if ((!total && !last) || !Number.isFinite(at)) return null
    const counters = (value: Record<string, unknown>) => ({ input: usageNumber(value.input_tokens),
      output: usageNumber(value.output_tokens), cached: usageNumber(value.cached_input_tokens) })
    let delta: ReturnType<typeof counters>
    if (total) {
      const current = counters(total), previous = state.cumulative
      state.cumulative = current
      if (previous && current.input === previous.input && current.output === previous.output && current.cached === previous.cached) return null
      const reset = previous === null || current.input < previous.input || current.output < previous.output || current.cached < previous.cached
      delta = reset ? counters(last ?? total) : { input: current.input - previous.input,
        output: current.output - previous.output, cached: current.cached - previous.cached }
    } else if (last) delta = counters(last)
    else return null
    const cached = Math.min(delta.input, delta.cached)
    return { at, nativeId: state.nativeId, cwd: state.cwd, model: state.model, rolloutAccount: state.rolloutAccount,
      dedupe: null, input: delta.input - cached, output: delta.output, cacheRead: cached, cacheWrite: 0 }
  }
}
