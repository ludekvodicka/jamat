import type { AccountCapacity, AccountState } from '../agentAccounts/agentAccountsApi.types'
import type { RateAccountState, RatePool } from './rateMonitorApi.types'

export interface PoolPoint { at: number; remaining: number }

/** One account's own share of the pool, read and projected the same way as the pool. */
export interface PoolAccountSeries { accountId: string; recorded: readonly PoolPoint[]; projected: readonly PoolPoint[] }

/**
 * The weekly pool in percent of the weighted capacity of the accounts it knows; account lines are in
 * their own percent. `burnPerHour` and `nextReset.gain` are pool percent as well.
 */
export interface PoolSeries {
  recorded: readonly PoolPoint[]
  projected: readonly PoolPoint[]
  accounts: readonly PoolAccountSeries[]
  burnPerHour: number
  poolEmptyAt: number | null
  firstEmpty: { accountId: string; at: number } | null
  nextReset: { accountId: string; at: number; gain: number } | null
  now: number
  until: number
  knownAccounts: number
  totalAccounts: number
  displayRange?: { from: number; to: number }
}

export interface UsageAccount extends RateAccountState {
  enabled: boolean
  accountState: AccountState
  capacity: AccountCapacity
}

/**
 * The `RatePool` sums stay unweighted percent. `weeklyLeftPercent` is the weekly quota left in percent
 * of the weighted capacity of the enabled accounts that have a reading, null without one.
 */
export interface UsagePool extends RatePool { weeklyKnown: number; sessionKnown: number; accountCount: number; weeklyLeftPercent: number | null }

export interface UsageSnapshot {
  capturedAt: number
  accounts: readonly UsageAccount[]
  pools: readonly UsagePool[]
}
