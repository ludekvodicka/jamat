import type { AccountView } from '../agentAccounts/agentAccountsApi.types'
import { PlanWeight } from '../agentAccounts/planWeight'
import type { RateMonitorSnapshot } from './rateMonitorApi.types'
import type { UsageSnapshot } from './usageApi.types'

export function usageSummary(snapshot: RateMonitorSnapshot, accounts: readonly AccountView[], now: number): UsageSnapshot {
  const cards = accounts.map(account => ({
    key: { agentId: account.agentId, accountId: account.accountId },
    label: account.label,
    state: { kind: 'never-read' as const },
    estimated: null,
    source: null,
    ...snapshot.accounts?.find(rate => rate.key.agentId === account.agentId && rate.key.accountId === account.accountId),
    enabled: account.state !== 'disabled',
    accountState: account.state,
    capacity: account.capacity ?? PlanWeight.capacity(null),
  }))
  return {
    capturedAt: now,
    accounts: cards,
    pools: (['claude', 'codex'] as const).map(agentId => {
      const enabled = cards.filter(card => card.key.agentId === agentId && card.enabled)
      const values = (duration: number): { remaining: number; weight: number }[] => enabled.flatMap(card => {
        const windows = card.estimated?.windows ?? ('windows' in card.state ? card.state.windows : [])
        const window = windows.find(item => item.durationMinutes === duration && !item.model)
        return window ? [{ remaining: Math.max(0, 100 - window.usedPercent), weight: card.capacity.weight }] : []
      })
      const weekly = values(10080), session = values(300)
      const weight = weekly.reduce((sum, value) => sum + value.weight, 0)
      return { agentId, weeklyRemaining: weekly.reduce((sum, value) => sum + value.remaining, 0), weeklyKnown: weekly.length, weeklyCapacity: enabled.length * 100,
        sessionRemaining: session.reduce((sum, value) => sum + value.remaining, 0), sessionKnown: session.length, sessionCapacity: enabled.length * 100,
        accountCount: enabled.length, weeklyLeftPercent: weight > 0 ? weekly.reduce((sum, value) => sum + value.weight * value.remaining, 0) / weight : null }
    }),
  }
}
