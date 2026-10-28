import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import type { StoredAccount } from '../../../lib-orchestrator/agentAccounts/agentAccounts'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

export class AccountsSection {
  static readonly spec: ConfigSectionSpec<readonly StoredAccount[]> = {
    key: 'accounts',
    coerce: (raw, report) => {
      if (raw === undefined) return []
      const problem = AccountsSection.validate(raw)
      if (problem) { report(problem); return [] }
      return structuredClone(raw as StoredAccount[])
    },
    damaged: raw => raw !== undefined && AccountsSection.validate(raw) !== null,
    validate: value => AccountsSection.validate(value),
  }

  static validate(raw: unknown): string | null {
    if (!Array.isArray(raw)) return 'accounts must be an array'
    const ids = new Set<string>()
    for (const [index, value] of raw.entries()) {
      const field = `accounts[${index}]`
      if (!JsonShape.isRecord(value)) return `${field} must be an object`
      if (value.agentId !== 'claude' && value.agentId !== 'codex') return `${field}.agentId must be claude or codex`
      if (typeof value.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id)
        || value.id === 'main' || ids.has(value.id)) return `${field}.id must be a unique added-account id`
      ids.add(value.id)
      if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 100) return `${field}.label must have 1 to 100 characters`
      if (typeof value.enabled !== 'boolean') return `${field}.enabled must be boolean`
      if (value.identity !== null && (!JsonShape.isRecord(value.identity)
        || typeof value.identity.key !== 'string' || !value.identity.key
        || typeof value.identity.label !== 'string' || !value.identity.label
        || Object.keys(value.identity).some(key => key !== 'key' && key !== 'label')))
        return `${field}.identity must be null or { key, label }`
      if (Object.keys(value).some(key => !['id', 'agentId', 'label', 'enabled', 'identity'].includes(key)))
        return `${field} has an unknown field`
    }
    return null
  }
}
