import type { AccountAgentId, AccountState } from '../../../../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import { AppControl } from '../../../../ipc/appControl'

export type AccountAction = { kind: 'add'; label: string; agentId: AccountAgentId } | { kind: 'login'; accountId: string }
  | { kind: 'rename'; accountId: string; label: string } | { kind: 'enable'; accountId: string; enabled: boolean }
  | { kind: 'remove'; accountId: string }

export class AccountsTabModel {
  static canLogin(state: AccountState): boolean {
    switch (state) {
      case 'active':
      case 'pending-login':
      case 'needs-login': return true
      case 'disabled': return false
      default: throw new Error(`Unknown account state: ${state}`)
    }
  }

  static stateLabel(state: AccountState): string {
    switch (state) {
      case 'active': return 'Active'
      case 'pending-login': return 'Pending login'
      case 'needs-login': return 'Needs login'
      case 'disabled': return 'Disabled'
      default: throw new Error(`Unknown account state: ${state}`)
    }
  }

  static async run(action: AccountAction): Promise<string | null> {
    switch (action.kind) {
      case 'add': {
        const added = await AppControl.value('accounts.add', { agentId: action.agentId, label: action.label.trim() })
        if (!added.ok) return added.error
        const login = await AppControl.value('accounts.login', { accountId: added.value.accountId })
        return login.ok ? null : login.error
      }
      case 'login': {
        const result = await AppControl.value('accounts.login', { accountId: action.accountId })
        return result.ok ? null : result.error
      }
      case 'rename': {
        const result = await AppControl.value('accounts.rename', { accountId: action.accountId, label: action.label.trim() })
        return result.ok ? null : result.error
      }
      case 'enable': {
        const result = await AppControl.value('accounts.setEnabled', { accountId: action.accountId, enabled: action.enabled })
        return result.ok ? null : result.error
      }
      case 'remove': {
        const result = await AppControl.value('accounts.remove', { accountId: action.accountId })
        return result.ok ? null : result.error
      }
      default: throw new Error(`Unknown account action: ${JSON.stringify(action)}`)
    }
  }
}
