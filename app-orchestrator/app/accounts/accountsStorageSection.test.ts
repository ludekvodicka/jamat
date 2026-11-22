import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountsStorageSection } from './accountsStorageSection'

describe('AccountsStorageSection', () => {
  const configDir = resolve('/profile')
  it('keeps profiles in the config directory when the section is absent', () => {
    const value = AccountsStorageSection.spec.coerce(undefined, () => {})
    expect(value).toEqual({ root: null })
    expect(AccountsStorageSection.spec.damaged?.(undefined)).toBe(false)
    expect(AccountsStorageSection.rootOf(value, configDir)).toBe(join(configDir, 'accounts'))
  })
  it('uses an absolute root verbatim', () => {
    const root = resolve('/Tooling.data/jamat/accounts')
    const value = AccountsStorageSection.spec.coerce({ root }, () => {})
    expect(AccountsStorageSection.rootOf(value, configDir)).toBe(root)
  })
  it('reports a damaged root, falls back to the config directory and refuses a save over it', () => {
    for (const raw of [{ root: 'relative/accounts' }, { root: '' }, { root: ' C:\\padded' }, { root: 3 },
      { root: null, extra: true }, [], 'C:\\accounts']) {
      const reports: string[] = []
      expect(AccountsStorageSection.spec.coerce(raw, message => reports.push(message))).toEqual({ root: null })
      expect(reports).toHaveLength(1)
      expect(AccountsStorageSection.spec.damaged?.(raw)).toBe(true)
    }
  })
})
