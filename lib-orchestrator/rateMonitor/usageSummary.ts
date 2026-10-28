import type { AccountView } from '../agentAccounts/agentAccountsApi.types'
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
  }))
  return {
    capturedAt: now,
    accounts: cards,
    pools: (['claude', 'codex'] as const).map(agentId => {
      const enabled = cards.filter(card => card.key.agentId === agentId && card.enabled)
      const values = (duration: number): number[] => enabled.flatMap(card => {
        const windows = card.estimated?.windows ?? ('windows' in card.state ? card.state.windows : [])
        const window = windows.find(item => item.durationMinutes === duration && !item.model)
        return window ? [Math.max(0, 100 - window.usedPercent)] : []
      })
      const weekly = values(10080), session = values(300)
      return { agentId, weeklyRemaining: weekly.reduce((sum, value) => sum + value, 0), weeklyKnown: weekly.length, weeklyCapacity: enabled.length * 100,
        sessionRemaining: session.reduce((sum, value) => sum + value, 0), sessionKnown: session.length, sessionCapacity: enabled.length * 100 }
    }),
  }
}
