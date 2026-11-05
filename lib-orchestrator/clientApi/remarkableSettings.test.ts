import { describe, expect, it } from 'vitest'

import { RemarkableSettings } from './remarkableSettings'

describe('app-client-ui/shared/remarkableSettings', () => {
  it('reads a missing section as an incomplete setup with the CLI timeout default', () => {
    const reports: string[] = []
    expect(RemarkableSettings.coerce(undefined, (message) => reports.push(message)))
      .toEqual({ timeoutMilliseconds: 180_000 })
    expect(reports).toHaveLength(0)
  })

  it('preserves unknown keys and repairs only unusable fields', () => {
    const reports: string[] = []
    const value = RemarkableSettings.coerce({
      host: 'tablet local',
      fingerprint: `SHA256:${'A'.repeat(42)}=`,
      timeoutMilliseconds: 999,
      note: 'keep',
    }, (message) => reports.push(message))

    expect(value).toEqual({ timeoutMilliseconds: 180_000, note: 'keep' })
    expect(reports).toHaveLength(3)
    expect(reports.join('\n')).toContain('host')
    expect(reports.join('\n')).toContain('fingerprint')
    expect(reports.join('\n')).toContain('timeoutMilliseconds')
  })

  it('accepts incomplete setup but validates every value that is present', () => {
    const fingerprint = `SHA256:${'a'.repeat(43)}`
    expect(RemarkableSettings.isValid({ timeoutMilliseconds: 1_000 })).toBe(true)
    expect(RemarkableSettings.isValid({
      host: '10.11.99.1',
      fingerprint,
      timeoutMilliseconds: 600_000,
      note: 'keep',
    })).toBe(true)
    expect(RemarkableSettings.isValid({ timeoutMilliseconds: 999 })).toBe(false)
    expect(RemarkableSettings.isValid({ timeoutMilliseconds: 600_001 })).toBe(false)
    expect(RemarkableSettings.isValid({ timeoutMilliseconds: 1_000.5 })).toBe(false)
    expect(RemarkableSettings.isValid({ host: 'tablet local', timeoutMilliseconds: 180_000 }))
      .toBe(false)
    expect(RemarkableSettings.isValid({
      fingerprint: `SHA256:${'a'.repeat(42)}`,
      timeoutMilliseconds: 180_000,
    })).toBe(false)
  })

  it('accepts host names and addresses but rejects whitespace and control characters', () => {
    for (const host of ['remarkable.local', '10.11.99.1', 'fe80::1'])
      expect(RemarkableSettings.isValidHost(host)).toBe(true)
    for (const host of ['', 'remarkable local', 'remarkable\nlocal', 'remarkable\u0000local'])
      expect(RemarkableSettings.isValidHost(host)).toBe(false)
  })

  it('accepts only the exact pinned SHA256 fingerprint shape', () => {
    expect(RemarkableSettings.isValidFingerprint(`SHA256:${'A'.repeat(43)}`)).toBe(true)
    expect(RemarkableSettings.isValidFingerprint(`SHA256:${'A'.repeat(42)}`)).toBe(false)
    expect(RemarkableSettings.isValidFingerprint(`SHA256:${'A'.repeat(44)}`)).toBe(false)
    expect(RemarkableSettings.isValidFingerprint(`SHA256:${'A'.repeat(42)}=`)).toBe(false)
    expect(RemarkableSettings.isValidFingerprint(`sha256:${'A'.repeat(43)}`)).toBe(false)
  })

  it('latches only a present value that cannot be read', () => {
    expect(RemarkableSettings.isDamaged(undefined)).toBe(false)
    expect(RemarkableSettings.isDamaged({})).toBe(false)
    expect(RemarkableSettings.isDamaged({ host: 'remarkable.local' })).toBe(false)
    expect(RemarkableSettings.isDamaged({ host: 'remarkable local' })).toBe(true)
    expect(RemarkableSettings.isDamaged({ fingerprint: 'SHA256:wrong' })).toBe(true)
    expect(RemarkableSettings.isDamaged({ timeoutMilliseconds: '180000' })).toBe(true)
    expect(RemarkableSettings.isDamaged([])).toBe(true)
  })
})
