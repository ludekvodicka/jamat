import type { AccountAgentId, AccountId, AccountView } from './agentAccountsApi.types'
import type { RateAccountState, RateWindow } from '../rateMonitor/rateMonitorApi.types'

export interface DefaultAccountChoice { accountId: AccountId; noFreeAccount: boolean; resetsAt?: string | null }

export function accountWindows(rate: RateAccountState | undefined): readonly RateWindow[] {
  if (!rate) return []
  if (rate.estimated) return rate.estimated.windows
  switch (rate.state.kind) {
    case 'ok':
    case 'stale': return rate.state.windows
    case 'never-read':
    case 'unconfigured': return []
    default: throw new Error(`Unknown rate state: ${JSON.stringify(rate.state)}`)
  }
}

export function chooseDefault(agentId: AccountAgentId, accounts: readonly AccountView[], rates: readonly RateAccountState[]): DefaultAccountChoice {
  const eligible = accounts.filter(account => account.agentId === agentId && account.state === 'active').map(account => {
    const windows = accountWindows(rates.find(rate => rate.key.agentId === agentId && rate.key.accountId === account.accountId))
    const session = windows.find(window => window.durationMinutes === 300 && window.model === undefined)
    const weekly = windows.find(window => window.durationMinutes === 10_080 && window.model === undefined)
    const reset = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : NaN
    return { account, session, weekly, known: session !== undefined || weekly !== undefined, reset: Number.isFinite(reset) ? reset : Infinity }
  }).filter(({ session, weekly }) => (session?.usedPercent ?? 0) < 90 && (weekly?.usedPercent ?? 0) < 100)
  eligible.sort((a, b) => {
    if (a.known !== b.known) return a.known ? -1 : 1
    if (a.reset !== b.reset) return a.reset < b.reset ? -1 : 1
    const aUsed = a.session?.usedPercent ?? Infinity
    const bUsed = b.session?.usedPercent ?? Infinity
    if (aUsed !== bUsed) return aUsed < bUsed ? -1 : 1
    if (a.account.isMain !== b.account.isMain) return a.account.isMain ? -1 : 1
    return a.account.accountId.localeCompare(b.account.accountId)
  })
  const chosen = eligible[0]
  return chosen ? { accountId: chosen.account.accountId, noFreeAccount: false, resetsAt: chosen.weekly?.resetsAt ?? null }
    : { accountId: 'main', noFreeAccount: true, resetsAt: null }
}
