import { z } from 'zod'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { tokenUsageRows, tokenUsageSessionRows } from '../../../lib-orchestrator/tokenUsage/tokenUsageQuery'
import type { AgentAccounts } from '../../../lib-orchestrator/agentAccounts/agentAccounts'
import type { AccountUsageLog } from '../../../lib-orchestrator/agentAccounts/accountCallerLogView'
import type { TokenOrigin } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'
import type { AppOperationMap } from '../../../lib-orchestrator/clientApi/appOperationMap'
import type { TokenUsageWorker } from './tokenUsageWorker'

export class TokenUsageOperations {
  private readonly worker: Pick<TokenUsageWorker, 'snapshot' | 'refresh'>
  private readonly accounts: Pick<AgentAccounts, 'list'>
  private readonly reported: Pick<AccountUsageLog, 'buckets'>
  constructor(worker: Pick<TokenUsageWorker, 'snapshot' | 'refresh'>, accounts: Pick<AgentAccounts, 'list'>, reported: Pick<AccountUsageLog, 'buckets'>) {
    this.worker = worker
    this.accounts = accounts
    this.reported = reported
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
      const at = Date.parse(value)
      return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value
    })
    op('usage.tokens', { kind: 'read', description: 'Local token totals grouped for the selected inclusive calendar period.',
      input: z.strictObject({ from: day, to: day, groupBy: z.enum(['day', 'project', 'hour', 'account', 'session']),
        agentId: z.enum(['claude', 'codex', 'antigravity']).optional(), origin: z.enum(['jamat', 'thirdParty']).optional() })
        .refine(query => query.from <= query.to),
      run: async query => {
        const accounts = await this.accounts.list(), snapshot = this.worker.snapshot(), reported = await this.reported.buckets()
        const counted = (origin: TokenOrigin): boolean => query.origin === undefined || query.origin === origin
        if (query.groupBy === 'session') {
          const rows = counted('jamat')
            ? tokenUsageSessionRows(snapshot.sessionBuckets, query, { sessions: snapshot.sessionLabels, projects: snapshot.labels })
            : []
          return { ok: true, value: { rows, progress: snapshot.progress } }
        }
        const buckets = [...counted('jamat') ? snapshot.buckets : [], ...counted('thirdParty') ? reported.buckets : []]
        const rows = tokenUsageRows(buckets, { ...query, groupBy: query.groupBy }, { projects: { ...snapshot.labels, ...reported.labels },
          accounts: { ...snapshot.accountLabels, ...Object.fromEntries(accounts.map(account => [`${account.agentId}/${account.accountId}`, account.label])) } })
        return { ok: true, value: { rows, progress: snapshot.progress } }
      },
    })
    op('usage.rescan', { kind: 'write', description: 'Rebuild local token statistics from the main transcript directories.',
      input: z.strictObject({}), run: async () => { void this.worker.refresh(true); return { ok: true, value: {} } },
    })
  }
}
