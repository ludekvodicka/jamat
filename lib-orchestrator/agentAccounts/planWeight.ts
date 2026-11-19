import type { AccountCapacity } from './agentAccountsApi.types'

/**
 * The weekly capacity weight of a plan, relative to the other accounts of one agent. Max 20x has four
 * times the 5-hour window of Max 5x but only about twice its weekly quota, and the pool and the
 * account choice are weekly, so Max 20x weighs 10 and Max 5x 5. Any other or unknown plan weighs 1.
 */
export class PlanWeight {
  private static readonly tiersConst: readonly { pattern: RegExp; weight: number }[] = [
    { pattern: /max_20x$/, weight: 10 },
    { pattern: /max_5x$/, weight: 5 },
  ]

  static capacity(tier: string | null): AccountCapacity {
    return { weight: PlanWeight.tiersConst.find(entry => tier !== null && entry.pattern.test(tier))?.weight ?? 1, tier }
  }

  static of(account: { capacity?: AccountCapacity }): number {
    return account.capacity?.weight ?? 1
  }
}
