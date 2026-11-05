import { describe, expect, it } from 'vitest'
import { AccountsSection } from './accountsSection'

describe('AccountsSection', () => {
  const account = { id: 'work-1234', agentId: 'claude', label: 'Work', enabled: true, identity: null }
  it('reads an absent section as no added accounts', () => {
    expect(AccountsSection.spec.coerce(undefined, () => {})).toEqual([])
    expect(AccountsSection.spec.damaged?.(undefined)).toBe(false)
  })
  it('validates agent ids and preserves damaged configuration from overwrite', () => {
    const value = [{ ...account, agentId: 'unknown' }]
    expect(AccountsSection.validate(value)).toBe('accounts[0].agentId must be claude or codex')
    const reports: string[] = []
    expect(AccountsSection.spec.coerce(value, message => reports.push(message))).toEqual([])
    expect(reports).toHaveLength(1)
    expect(AccountsSection.spec.damaged?.(value)).toBe(true)
  })
  it('refuses main, duplicate or escaping ids and unknown credential fields', () => {
    for (const value of [[{ ...account, id: 'main' }], [{ ...account, id: '../escape' }], [account, account],
      [{ ...account, identity: { key: 'id', label: 'Email', token: 'fixture' } }]])
      expect(AccountsSection.validate(value)).not.toBeNull()
    expect(AccountsSection.validate([account])).toBeNull()
  })
})
