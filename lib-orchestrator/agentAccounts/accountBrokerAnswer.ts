import type { AccountView } from './agentAccountsApi.types'
import type { AccountBrokerAnswer, AccountBrokerReason } from './accountBrokerApi.types'

/** Main's own login facts as the orchestrator knows them; the CLI side has none. */
export interface AccountBrokerMain { configDir: string | null; identityKey: string | null; tier: string | null }

/**
 * Builds and checks broker answers. Type imports only: the CLI links this file for its fallback
 * answers and the shape check, and nothing behind it.
 */
export class AccountBrokerAnswers {
  static readonly callerPatternConst = /^[A-Za-z0-9._-]{1,64}$/
  static readonly purposesConst = ['interactive', 'background'] as const
  static readonly reuseSecondsConst = 300
  static readonly fallbackReuseSecondsConst = 60
  /** A set credential variable overrides any profile, so every answer removes both. */
  private static readonly credentialVariablesConst = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
  private static readonly homeVariableConst = 'CLAUDE_CONFIG_DIR'

  /**
   * Main: the home variable removed, because a caller started from a Jamat session inherits that
   * session's profile; set to the orchestrator's own home when it has one, which then is its Main.
   */
  static mainEnv(mainConfigDir: string | null): AccountBrokerAnswer['env'] {
    return mainConfigDir === null
      ? { set: {}, unset: [AccountBrokerAnswers.homeVariableConst, ...AccountBrokerAnswers.credentialVariablesConst] }
      : { set: { [AccountBrokerAnswers.homeVariableConst]: mainConfigDir }, unset: [...AccountBrokerAnswers.credentialVariablesConst] }
  }

  static main(reason: AccountBrokerReason, main: AccountBrokerMain = { configDir: null, identityKey: null, tier: null }): AccountBrokerAnswer {
    const fallback = reason !== 'chosen'
    return { brokerVersion: 1, provider: 'claude', account: { id: 'main', label: 'Main', identityKey: main.identityKey, tier: main.tier },
      env: AccountBrokerAnswers.mainEnv(main.configDir), fallback, reason,
      reuseSeconds: fallback ? AccountBrokerAnswers.fallbackReuseSecondsConst : AccountBrokerAnswers.reuseSecondsConst }
  }

  static account(view: Pick<AccountView, 'accountId' | 'label' | 'identity' | 'capacity'>, set: Record<string, string>): AccountBrokerAnswer {
    return { brokerVersion: 1, provider: 'claude',
      account: { id: view.accountId, label: view.label, identityKey: view.identity?.key ?? null, tier: view.capacity?.tier ?? null },
      env: { set: { ...set }, unset: [...AccountBrokerAnswers.credentialVariablesConst] },
      fallback: false, reason: 'chosen', reuseSeconds: AccountBrokerAnswers.reuseSecondsConst }
  }

  /** A version 1 answer; members it does not know are allowed, any other version is no answer. */
  static is(value: unknown): value is AccountBrokerAnswer {
    if (!AccountBrokerAnswers.record(value) || value.brokerVersion !== 1 || value.provider !== 'claude') return false
    const { account, env } = value
    if (!AccountBrokerAnswers.record(account) || typeof account.id !== 'string' || typeof account.label !== 'string'
      || !AccountBrokerAnswers.nullableString(account.identityKey) || !AccountBrokerAnswers.nullableString(account.tier)) return false
    if (!AccountBrokerAnswers.record(env) || !AccountBrokerAnswers.record(env.set)
      || !Object.values(env.set).every(item => typeof item === 'string')
      || !Array.isArray(env.unset) || !env.unset.every(item => typeof item === 'string')) return false
    return typeof value.fallback === 'boolean' && typeof value.reason === 'string'
      && typeof value.reuseSeconds === 'number' && Number.isFinite(value.reuseSeconds) && value.reuseSeconds >= 0
  }

  private static record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private static nullableString(value: unknown): boolean {
    return value === null || typeof value === 'string'
  }
}
