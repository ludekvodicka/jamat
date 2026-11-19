import { AccountProblem } from '../../../lib-orchestrator/agentAccounts/accountProblem'
import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { z } from 'zod'
import type { AgentAccounts } from '../../../lib-orchestrator/agentAccounts/agentAccounts'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { AppOperationMap } from '../../../lib-orchestrator/clientApi/appOperationMap'
import type { AccountBroker } from '../../../lib-orchestrator/agentAccounts/accountBroker'
import { AccountBrokerAnswers } from '../../../lib-orchestrator/agentAccounts/accountBrokerAnswer'

export class AccountsOperations {
  private readonly accounts: AgentAccounts
  private readonly broker: Pick<AccountBroker, 'pick' | 'callers'>
  private readonly brokerCommand: () => string | null

  constructor(accounts: AgentAccounts, broker: Pick<AccountBroker, 'pick' | 'callers'>, brokerCommand: () => string | null) {
    this.accounts = accounts
    this.broker = broker
    this.brokerCommand = brokerCommand
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('accounts.add', { kind: 'write', description: 'Create an added account profile, pending login.',
      input: z.strictObject({ agentId: z.enum(['claude', 'codex']), label: RemoteControlZod.text() }),
      run: body => this.perform(() => this.accounts.add(body.agentId, body.label)) })
    op('accounts.login', { kind: 'write', description: 'Open the account login terminal and register its completed identity.',
      input: z.strictObject({ accountId: RemoteControlZod.text() }),
      run: body => this.perform(() => this.accounts.login(body.accountId)) })
    op('accounts.rename', { kind: 'write', description: 'Rename an added account without changing its id.',
      input: z.strictObject({ accountId: RemoteControlZod.text(), label: RemoteControlZod.text() }),
      run: body => this.perform(async () => { await this.accounts.rename(body.accountId, body.label); return {} }) })
    op('accounts.setEnabled', { kind: 'write', description: 'Enable or disable an added account.',
      input: z.strictObject({ accountId: RemoteControlZod.text(), enabled: RemoteControlZod.boolean() }),
      run: body => this.perform(async () => { await this.accounts.setEnabled(body.accountId, body.enabled); return {} }) })
    op('accounts.remove', { kind: 'write', description: 'Remove an idle added profile without following its links.',
      input: z.strictObject({ accountId: RemoteControlZod.text() }),
      run: body => this.perform(async () => { await this.accounts.remove(body.accountId); return {} }) })
    op('accounts.pick', { kind: 'write', description: 'Choose the Claude account a local caller runs on; Main when the choice fails.',
      input: z.strictObject({ caller: z.string().regex(AccountBrokerAnswers.callerPatternConst, { error: 'must be 1 to 64 characters of A-Z a-z 0-9 . _ -' }),
        purpose: z.enum(AccountBrokerAnswers.purposesConst) }),
      run: async body => ({ ok: true, value: await this.broker.pick(body) }) })
    op('usage.callers', { kind: 'read', description: 'Callers of the Claude account broker in the last 30 days.', input: z.strictObject({}),
      run: async () => ({ ok: true, value: { ...await this.broker.callers(), command: this.brokerCommand() } }) })
  }

  private async perform<T>(action: () => Promise<T>): Promise<RemoteControlStepResult<T>> {
    try { return { ok: true, value: await action() } }
    catch (error) {
      if (error instanceof AccountProblem)
        return { ok: false, error: { code: 'operation-failed', detail: error.message, data: { sourceCode: 'account-refused' } } }
      throw error
    }
  }

}
