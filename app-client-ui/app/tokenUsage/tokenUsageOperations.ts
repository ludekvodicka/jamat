import { z } from 'zod'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { tokenUsageRows } from '../../../lib-orchestrator/tokenUsage/tokenUsageQuery'
import type { AgentAccounts } from '../../../lib-orchestrator/agentAccounts/agentAccounts'
import type { AppOperationMap } from '../../shared/appOperationMap'
import type { TokenUsageWorker } from './tokenUsageWorker'

export class TokenUsageOperations {
  private readonly worker: Pick<TokenUsageWorker, 'snapshot' | 'refresh'>
  private readonly accounts: Pick<AgentAccounts, 'list'>
  constructor(worker: Pick<TokenUsageWorker, 'snapshot' | 'refresh'>, accounts: Pick<AgentAccounts, 'list'>) {
    this.worker = worker
    this.accounts = accounts
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
      const at = Date.parse(value)
      return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value
    })
    op('usage.tokens', { kind: 'read', description: 'Local token totals grouped for the selected inclusive calendar period.',
      input: z.strictObject({ from: day, to: day, groupBy: z.enum(['day', 'project', 'hour', 'account']),
        agentId: z.enum(['claude', 'codex']).optional() }).refine(query => query.from <= query.to),
      run: async query => {
        const accounts = await this.accounts.list(), snapshot = this.worker.snapshot()
        const rows = tokenUsageRows(snapshot.buckets, query, { projects: snapshot.labels,
          accounts: { ...snapshot.accountLabels, ...Object.fromEntries(accounts.map(account => [`${account.agentId}/${account.accountId}`, account.label])) } })
        return { ok: true, value: { rows, progress: snapshot.progress } }
      },
    })
    op('usage.rescan', { kind: 'write', description: 'Rebuild local token statistics from the main transcript directories.',
      input: z.strictObject({}), run: async () => { void this.worker.refresh(true); return { ok: true, value: {} } },
    })
  }
}
