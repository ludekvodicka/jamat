import type { AccountAgentId, AccountId, AccountQuota, AccountView } from './agentAccountsApi.types'
import type { RateAccountKey, RateAccountState, RateWindow } from '../rateMonitor/rateMonitorApi.types'
import { PlanWeight } from './planWeight'

export interface DefaultAccountChoice { accountId: AccountId; noFreeAccount: boolean; resetsAt?: string | null }

/** Weekly percent an account spent per hour over the last day and over the last three hours. */
export interface AccountBurn { key: RateAccountKey; day: number; recent: number }

/** `paced` spreads spend by the pace to each reset; `soonest-reset` spends the quota that expires first. */
export type AccountChoiceRule = 'paced' | 'soonest-reset'

const hour = 3_600_000

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

export function accountQuota(rate: RateAccountState | undefined): AccountQuota | null {
  const windows = accountWindows(rate)
  const session = windows.find(window => window.durationMinutes === 300 && window.model === undefined)
  const weekly = windows.find(window => window.durationMinutes === 10_080 && window.model === undefined)
  if (session === undefined && weekly === undefined) return null
  return { sessionUsedPercent: session?.usedPercent ?? null, weeklyUsedPercent: weekly?.usedPercent ?? null, weeklyResetsAt: weekly?.resetsAt ?? null }
}

/** A plain session or weekly window at its limit: what a session of that account shows as exhausted. */
export function accountExhausted(rate: RateAccountState | undefined): boolean {
  return accountWindows(rate).some(window => window.model === undefined
    && (window.durationMinutes === 300 || window.durationMinutes === 10_080) && window.usedPercent >= 100)
}

/**
 * Weekly percent kept for the phone and other clients of an account until shortly before its reset,
 * so that little of it expires: 5% until a day before, 2% until 12 hours, 1% until the last hour.
 */
export function weeklyReserve(hoursToReset: number): number {
  return hoursToReset > 24 ? 5 : hoursToReset > 12 ? 2 : hoursToReset > 1 ? 1 : 0
}

/**
 * The account a new session should use. Each account with quota above its reserve gets a target
 * share of the agent's spend over the last day: accounts take, in order of weekly reset, at most the
 * pace that empties them exactly at their reset (weighted quota above the reserve per hour left), and
 * spend beyond every pace splits by pace. The account furthest below its target share of the last
 * three hours wins. Without spend this is the soonest weekly reset. The rule `soonest-reset` takes the
 * soonest reset above its reserve at once. Accounts in their reserve come next, soonest reset first;
 * unknown quotas last.
 */
export function chooseDefault(agentId: AccountAgentId, accounts: readonly AccountView[], rates: readonly RateAccountState[],
  burns: readonly AccountBurn[] = [], now = Date.now(), rule: AccountChoiceRule = 'paced'): DefaultAccountChoice {
  const active = accounts.filter(account => account.agentId === agentId && account.state === 'active').map(account => {
    const windows = accountWindows(rates.find(rate => rate.key.agentId === agentId && rate.key.accountId === account.accountId))
    const session = windows.find(window => window.durationMinutes === 300 && window.model === undefined)
    const weekly = windows.find(window => window.durationMinutes === 10_080 && window.model === undefined)
    const parsed = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : NaN
    const reset = Number.isFinite(parsed) ? parsed : Infinity
    const hours = Number.isFinite(reset) ? Math.max(0.1, (reset - now) / hour) : 7 * 24
    const free = weekly ? 100 - weekly.usedPercent - weeklyReserve(hours) : 100
    const burn = burns.find(value => value.key.agentId === agentId && value.key.accountId === account.accountId)
    return { account, session, weekly, known: session !== undefined || weekly !== undefined, reset, hours, free,
      weight: PlanWeight.of(account), day: burn?.day ?? 0, recent: burn?.recent ?? 0 }
  })
  const eligible = active.filter(({ session, weekly }) => (session?.usedPercent ?? 0) < 90 && (weekly?.usedPercent ?? 0) < 100)
  eligible.sort((a, b) => {
    if (a.known !== b.known) return a.known ? -1 : 1
    if (a.reset !== b.reset) return a.reset < b.reset ? -1 : 1
    const aUsed = a.session?.usedPercent ?? Infinity
    const bUsed = b.session?.usedPercent ?? Infinity
    if (aUsed !== bUsed) return aUsed < bUsed ? -1 : 1
    if (a.account.isMain !== b.account.isMain) return a.account.isMain ? -1 : 1
    return a.account.accountId.localeCompare(b.account.accountId)
  })
  const preferred = eligible.filter(candidate => candidate.known && candidate.free > 0)
  const chosen = preferred.length === 0 ? eligible[0] : preferred[preferredIndex(rule, preferred, active.reduce((sum, value) => sum + value.weight * value.day, 0))]
  return chosen ? { accountId: chosen.account.accountId, noFreeAccount: false, resetsAt: chosen.weekly?.resetsAt ?? null }
    : { accountId: 'main', noFreeAccount: true, resetsAt: null }
}

function preferredIndex(rule: AccountChoiceRule, order: readonly { weight: number; free: number; hours: number; recent: number }[], spend: number): number {
  switch (rule) {
    case 'paced': return pacedIndex(order, spend)
    case 'soonest-reset': return 0
    default: throw new Error(`Unknown account choice rule: ${JSON.stringify(rule)}`)
  }
}

/** The index, in soonest-reset order, of the account furthest below its target share of the spend. */
function pacedIndex(order: readonly { weight: number; free: number; hours: number; recent: number }[], spend: number): number {
  const pace = order.map(candidate => candidate.weight * candidate.free / candidate.hours)
  let left = spend
  const target = pace.map(value => {
    const taken = Math.min(left, value)
    left -= taken
    return taken
  })
  const paceSum = pace.reduce((sum, value) => sum + value, 0)
  if (left > 0 && paceSum > 0) pace.forEach((value, index) => { target[index] += left * value / paceSum })
  const targetSum = target.reduce((sum, value) => sum + value, 0)
  if (targetSum <= 0) return 0
  const actual = order.map(candidate => candidate.weight * candidate.recent)
  const actualSum = actual.reduce((sum, value) => sum + value, 0)
  let best = 0, bestGap = -Infinity
  target.forEach((value, index) => {
    const gap = value / targetSum - (actualSum > 0 ? actual[index] / actualSum : 0)
    if (gap > bestGap + 1e-9) {
      best = index
      bestGap = gap
    }
  })
  return best
}
