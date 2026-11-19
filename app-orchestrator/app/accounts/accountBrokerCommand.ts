import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The broker command a client of this instance configures (`docs/architecture/account-broker.md`).
 * It runs the wrapper through the skill link, the one path that survives a new package, and names
 * this instance explicitly, so discovery picks it even when the link belongs to another installation.
 */
export class AccountBrokerCommand {
  /** Null when the wrapper is not on disk, because the skill link is missing. */
  static of(claudeSkillRoot: string, configIdentity: string, channel: string): string | null {
    const wrapper = join(claudeSkillRoot, 'appjamat-v3', 'scripts', 'jamat-v3.mjs')
    if (!existsSync(wrapper)) return null
    return `node "${wrapper.replaceAll('\\', '/')}" --config-identity ${configIdentity} --channel ${channel}`
      + ' accounts pick --caller {caller} --purpose {purpose}'
  }
}
