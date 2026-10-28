import { projectPool } from '../../../lib-orchestrator/rateMonitor/poolProjection'
import { usageSummary } from '../../../lib-orchestrator/rateMonitor/usageSummary'
import type { AgentAccounts } from '../../../lib-orchestrator/agentAccounts/agentAccounts'
import { z } from 'zod'

import type { RateMonitor } from '../../../lib-orchestrator/rateMonitor/rateMonitor'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import type { AppOperationMap } from '../../shared/appOperationMap'

/** How much of each provider's rate limit is spent, as the status bar and the Debug window read it. */
export class RateMonitorOperations {
  private readonly rateMonitor: RateMonitor
  private readonly accounts: Pick<AgentAccounts, 'list'>

  constructor(rateMonitor: RateMonitor, accounts: Pick<AgentAccounts, 'list'>) {
    this.rateMonitor = rateMonitor
    this.accounts = accounts
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('usage.history', {
      kind: 'read', description: 'Recorded weekly pool and its reset-aware projection.',
      input: z.strictObject({ agentId: z.enum(['claude', 'codex']), from: z.number().finite(), to: z.number().finite(),
        burnHours: z.union([z.literal(1), z.literal(3), z.literal(6)]) }).refine(value => value.to > value.from && value.to - value.from <= 90 * 86_400_000),
      run: async request => {
        const now = Date.now()
        const accounts = (await this.accounts.list()).filter(account => account.agentId === request.agentId && account.state !== 'disabled')
        const samples = await this.rateMonitor.readHistory({ from: Math.min(request.from, now - 90 * 86_400_000), to: now })
        const series = projectPool(samples, accounts, now, Math.min(request.to, now + 31 * 86_400_000), request.burnHours,
          { from: request.from, to: request.to })
        return { ok: true, value: series }
      },
    })
    op('usage.get', {
      kind: 'read', description: 'Quota pools and account cards.', input: z.strictObject({}),
      run: async () => ({ ok: true, value: usageSummary(this.rateMonitor.snapshot(), await this.accounts.list(), Date.now()) }),
    })
    op('rate.get', {
      kind: 'read',
      description: 'The latest rate-limit reading of every provider, with its revision.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.rateMonitor.snapshot() }),
    })
    op('rate.refresh', {
      kind: 'read',
      description: 'Read the providers again and answer once the reads settled; the monitor keeps its own floor.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: await this.rateMonitor.refresh() }),
    })
    op('rate.debugStatus', {
      kind: 'read',
      description: 'Every window the providers answered, both timestamps and when the OAuth token expires; never a token.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.rateMonitor.debugStatus() }),
    })
  }
}
