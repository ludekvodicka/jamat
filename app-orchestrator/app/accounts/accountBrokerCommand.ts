import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountBrokerRequest } from '../../../lib-orchestrator/agentAccounts/accountBrokerApi.types'

/**
 * The broker commands of this instance (`docs/architecture/account-broker.md`). They run the wrapper
 * through the skill link, the one path that survives a new package, and name this instance
 * explicitly, so discovery picks it even when the link belongs to another installation.
 */
export class AccountBrokerCommand {
  /** The command a client configures; null when the wrapper is not on disk, because the skill link is missing. */
  static of(claudeSkillRoot: string, configIdentity: string, channel: string): string | null {
    const prefix = AccountBrokerCommand.prefix(claudeSkillRoot, configIdentity, channel)
    return prefix === null ? null : `${prefix} accounts pick --caller {caller} --purpose {purpose}`
  }

  /**
   * The `accounts report` line an answer carries. Caller and account id match the broker's id
   * pattern, so the line needs no quoting.
   */
  static report(claudeSkillRoot: string, configIdentity: string, channel: string, request: AccountBrokerRequest, accountId: string): string | null {
    const prefix = AccountBrokerCommand.prefix(claudeSkillRoot, configIdentity, channel)
    return prefix === null ? null
      : `${prefix} accounts report --caller ${request.caller} --purpose ${request.purpose} --account ${accountId}`
  }

  private static prefix(claudeSkillRoot: string, configIdentity: string, channel: string): string | null {
    const wrapper = join(claudeSkillRoot, 'appjamat-v3', 'scripts', 'jamat-v3.mjs')
    if (!existsSync(wrapper)) return null
    return `node "${wrapper.replaceAll('\\', '/')}" --config-identity ${configIdentity} --channel ${channel}`
  }
}
