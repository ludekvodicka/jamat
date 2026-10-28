import type { AccountState } from '../agentAccounts/agentAccountsApi.types'
import type { RateAccountState, RatePool } from './rateMonitorApi.types'

export interface PoolSeries {
  recorded: readonly { at: number; remaining: number }[]
  projected: readonly { at: number; remaining: number }[]
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
}

export interface UsagePool extends RatePool { weeklyKnown: number; sessionKnown: number }

export interface UsageSnapshot {
  capturedAt: number
  accounts: readonly UsageAccount[]
  pools: readonly UsagePool[]
}
