import { basename, join } from 'node:path'
import type { SessionUsageRecord } from '../sessionManager/sessionUsageView'
import type { TokenAccountResolver } from './tokenUsageSource'
import { usageJson, usageNumber, usageObject, type TokenUsageSource, type UsageParserState, type UsageRecord } from './tokenUsageSource'

export class ClaudeUsageParser {
  static accountResolver(records: readonly SessionUsageRecord[]): TokenAccountResolver {
    const segments = new Map<string, SessionUsageRecord['accountSegments'][number][]>()
    for (const record of records)
      if (record.agentId === 'claude') segments.set(record.nativeSessionId, [...segments.get(record.nativeSessionId) ?? [], ...record.accountSegments])
    for (const spans of segments.values()) spans.sort((a, b) => b.from - a.from)
    return (nativeId, at) => segments.get(nativeId)?.find(span => span.from <= at && (span.to === null || at < span.to))?.accountId ?? 'main'
  }

  static source(home: string): TokenUsageSource {
    return { agentId: 'claude', root: join(home, 'projects'), accepts: name => name.endsWith('.jsonl'),
      initial: file => ({ nativeId: basename(file, '.jsonl'), cwd: '', model: 'unknown', rolloutAccount: null, cumulative: null }),
      parse: ClaudeUsageParser.parse }
  }

  static parse(line: string, state: UsageParserState): UsageRecord | null {
    const row = usageJson(line)
    if (!row) return null
    if (typeof row.cwd === 'string') state.cwd = row.cwd
    if (typeof row.sessionId === 'string') state.nativeId = row.sessionId
    if (row.type !== 'assistant') return null
    const message = usageObject(row.message), usage = usageObject(message?.usage)
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (!message || !usage || !Number.isFinite(at)) return null
    if (typeof message.model === 'string') state.model = message.model
    return { at, nativeId: state.nativeId, cwd: state.cwd, model: state.model, rolloutAccount: null,
      dedupe: typeof message.id === 'string' && typeof row.requestId === 'string' ? JSON.stringify([message.id, row.requestId]) : null,
      input: usageNumber(usage.input_tokens), output: usageNumber(usage.output_tokens),
      cacheRead: usageNumber(usage.cache_read_input_tokens), cacheWrite: usageNumber(usage.cache_creation_input_tokens) }
  }
}
