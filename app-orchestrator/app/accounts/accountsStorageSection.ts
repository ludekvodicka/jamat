import { isAbsolute, join } from 'node:path'
import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

export interface AccountsStorageValue {
  /** Absolute directory holding `<agent>/<account>` profiles; null keeps them in `<configDir>/accounts`. */
  root: string | null
}

/**
 * Its own key rather than a field of `accounts`, which is the array of registered accounts that the
 * Accounts tab saves whole. Read once at start: profiles of running sessions live under the old root.
 */
export class AccountsStorageSection {
  static readonly rootLengthMaxConst = 260

  static readonly spec: ConfigSectionSpec<AccountsStorageValue> = {
    key: 'accountsStorage',
    coerce: (raw, report) => {
      if (raw === undefined) return { root: null }
      const problem = AccountsStorageSection.validate(raw)
      if (problem) { report(`${problem}; keeping account profiles in the config directory`); return { root: null } }
      return { root: (raw as AccountsStorageValue).root }
    },
    damaged: raw => raw !== undefined && AccountsStorageSection.validate(raw) !== null,
    validate: value => AccountsStorageSection.validate(value),
  }

  static validate(raw: unknown): string | null {
    if (!JsonShape.isRecord(raw)) return 'accountsStorage must be an object'
    if (Object.keys(raw).some(key => key !== 'root')) return 'accountsStorage has an unknown field'
    const root = raw.root
    if (root === null) return null
    if (typeof root !== 'string' || !root || root.length > AccountsStorageSection.rootLengthMaxConst
      || root !== root.trim() || !isAbsolute(root))
      return 'accountsStorage.root must be null or an absolute path'
    return null
  }

  static rootOf(value: AccountsStorageValue, configDir: string): string {
    return value.root ?? join(configDir, 'accounts')
  }
}
