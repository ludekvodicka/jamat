import { ErrorText } from '../shared/errorText'
import { AccountProblem } from './accountProblem'
import { AccountBrokerAnswers, type AccountBrokerMain } from './accountBrokerAnswer'
import type { AccountBrokerAnswer, AccountBrokerPurpose, AccountBrokerRequest, AccountCallersView, AccountUsageReport } from './accountBrokerApi.types'
import type { AgentAccounts } from './agentAccounts'
import type { AccountCallerLog } from './broker/accountCallerLog'
import type { AccountUsageLog } from './broker/accountUsageLog'
import type { AccountView } from './agentAccountsApi.types'
import type { AccountChoiceRule } from './defaultAccount'

export interface AccountBrokerDeps {
  accounts: Pick<AgentAccounts, 'list' | 'defaultAccount' | 'launchEnv'>
  /** The orchestrator's own `CLAUDE_CONFIG_DIR`, which then is its Main home; null for `~/.claude`. */
  mainConfigDir: string | null
  /** Every pick is logged after it is answered; a failed append is reported and never fails the pick. */
  log: Pick<AccountCallerLog, 'append' | 'view'>
  /** The reported token usage of the callers' runs. */
  usage: Pick<AccountUsageLog, 'append'>
  /** The `accounts report` command line for a run made with an answer; null when it cannot be built. */
  reportCommand(request: AccountBrokerRequest, accountId: string): string | null
  now(): number
  onLogged(): void
  onReported(): void
  onError(message: string): void
}

/**
 * Tells a local caller which Claude account to run on (`docs/architecture/account-broker.md`). Every
 * failure answers Main, so a caller never stops because of the broker.
 */
export class AccountBroker {
  private readonly deps: AccountBrokerDeps

  constructor(deps: AccountBrokerDeps) {
    this.deps = deps
  }

  async pick(request: AccountBrokerRequest): Promise<AccountBrokerAnswer> {
    const started = this.deps.now()
    const chosen = await this.choose(request)
    const reportCommand = this.deps.reportCommand(request, chosen.account.id)
    const answer = reportCommand === null ? chosen : { ...chosen, reportCommand }
    void this.deps.log.append({ at: started, caller: request.caller, purpose: request.purpose, accountId: answer.account.id,
      accountLabel: answer.account.label, fallback: answer.fallback, reason: answer.reason, durationMs: this.deps.now() - started })
      .then(() => this.deps.onLogged(), error => this.deps.onError(`Caller log: ${ErrorText.of(error)}`))
    return answer
  }

  /** Records the token usage of one finished run; a failed append fails the report, never a pick. */
  async report(report: AccountUsageReport): Promise<void> {
    await this.deps.usage.append({ at: this.deps.now(), ...report })
    this.deps.onReported()
  }

  /** The callers of the last 30 days; the composition adds the command. */
  callers(): Promise<Omit<AccountCallersView, 'command'>> {
    return this.deps.log.view(this.deps.now())
  }

  private async choose(request: AccountBrokerRequest): Promise<AccountBrokerAnswer> {
    try {
      const views = await this.deps.accounts.list()
      const main = this.mainOf(views)
      const choice = await this.deps.accounts.defaultAccount('claude', AccountBroker.ruleOf(request.purpose))
      if (choice.accountId === 'main') return AccountBrokerAnswers.main(choice.noFreeAccount ? 'no-eligible-account' : 'chosen', main)
      const view = views.find(account => account.agentId === 'claude' && account.accountId === choice.accountId)
      if (!view) return AccountBrokerAnswers.main('error', main)
      return AccountBrokerAnswers.account(view, await this.deps.accounts.launchEnv('claude', choice.accountId))
    } catch (error) {
      return AccountBrokerAnswers.main(error instanceof AccountProblem ? 'account-unusable' : 'error', this.mainOf([]))
    }
  }

  static ruleOf(purpose: AccountBrokerPurpose): AccountChoiceRule {
    switch (purpose) {
      case 'interactive': return 'paced'
      case 'background': return 'soonest-reset'
      default: throw new Error(`Unknown broker purpose: ${JSON.stringify(purpose)}`)
    }
  }

  private mainOf(views: readonly AccountView[]): AccountBrokerMain {
    const main = views.find(account => account.agentId === 'claude' && account.accountId === 'main')
    return { configDir: this.deps.mainConfigDir, identityKey: main?.identity?.key ?? null, tier: main?.capacity?.tier ?? null }
  }
}
