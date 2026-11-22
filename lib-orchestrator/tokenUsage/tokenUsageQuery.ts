import type { TokenBucket, TokenSessionBucket, TokenUsageQuery, TokenUsageRow } from './tokenUsageApi.types'

export function tokenUsageRows(buckets: readonly TokenBucket[], query: Omit<TokenUsageQuery, 'groupBy'> & { groupBy: Exclude<TokenUsageQuery['groupBy'], 'session'> },
  labels: { projects: Readonly<Record<string, string>>; accounts: Readonly<Record<string, string>> }): TokenUsageRow[] {
  const rows = new Map<string, TokenUsageRow>()
  for (const bucket of buckets) {
    if (bucket.day < query.from || bucket.day > query.to || query.agentId && query.agentId !== bucket.agentId) continue
    let key: string, label: string
    switch (query.groupBy) {
      case 'day': key = bucket.day; label = key; break
      case 'hour': key = String(bucket.hour).padStart(2, '0'); label = `${key}:00`; break
      case 'project': key = bucket.projectKey; label = labels.projects[key] ?? key; break
      case 'account':
        key = bucket.accountId
        label = labels.accounts[`${bucket.agentId}/${key}`] ?? (key === 'main' ? 'Main' : key)
        break
      default: throw new Error(`Unknown token grouping: ${query.groupBy}`)
    }
    const id = `${bucket.agentId}/${key}`
    const row = rows.get(id) ?? { key, label, agentId: bucket.agentId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    row.input += bucket.input
    row.output += bucket.output
    row.cacheRead += bucket.cacheRead
    row.cacheWrite += bucket.cacheWrite
    rows.set(id, row)
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key) || a.agentId.localeCompare(b.agentId))
}

export function tokenUsageSessionRows(
  buckets: readonly TokenSessionBucket[],
  query: Pick<TokenUsageQuery, 'from' | 'to' | 'agentId'>,
  labels: { sessions: Readonly<Record<string, string>>; projects: Readonly<Record<string, string>> },
): TokenUsageRow[] {
  const rows = new Map<string, TokenUsageRow>()
  for (const bucket of buckets) {
    if (bucket.day < query.from || bucket.day > query.to || query.agentId && query.agentId !== bucket.agentId) continue
    const id = `${bucket.agentId}/${bucket.nativeId}`
    let row = rows.get(id)
    if (!row) {
      const explicit = labels.sessions[id]?.trim()
      const shortId = bucket.nativeId.length > 12 ? bucket.nativeId.slice(0, 8) : bucket.nativeId
      const project = bucket.projectKey && bucket.projectKey !== 'unknown'
        ? (labels.projects[bucket.projectKey] ?? bucket.projectKey)
        : ''
      const label = explicit || (project ? `${project} · ${shortId}` : shortId)
      row = { key: bucket.nativeId, label, agentId: bucket.agentId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      rows.set(id, row)
    }
    row.input += bucket.input
    row.output += bucket.output
    row.cacheRead += bucket.cacheRead
    row.cacheWrite += bucket.cacheWrite
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key) || a.agentId.localeCompare(b.agentId))
}
