import { describe, expect, it } from 'vitest'

import { VersioningSettings } from './versioningSettings'

describe('app-client-ui/shared/versioningSettings', () => {
  it('defaults a missing or unusable section to checkpoints and reports only real damage', () => {
    const messages: string[] = []
    expect(VersioningSettings.coerce(undefined, (message) => messages.push(message)))
      .toEqual({ mode: 'checkpoints' })
    expect(VersioningSettings.coerce({ mode: 'jj' }, (message) => messages.push(message)))
      .toEqual({ mode: 'checkpoints' })
    expect(VersioningSettings.coerce('not an object', (message) => messages.push(message)))
      .toEqual({ mode: 'checkpoints' })
    // An absent section is not damage: it is a config nobody has written this key into yet.
    expect(messages).toHaveLength(2)
  })

  it('accepts only checkpoints or git while preserving unknown hand-written fields on read', () => {
    expect(VersioningSettings.isValid({ mode: 'checkpoints' })).toBe(true)
    expect(VersioningSettings.isValid({ mode: 'git' })).toBe(true)
    expect(VersioningSettings.isValid({ mode: 'jj' })).toBe(false)
    expect(VersioningSettings.isValid(undefined)).toBe(false)
    expect(VersioningSettings.coerce({ mode: 'git', note: 'keep' }, () => undefined))
      .toEqual({ mode: 'git', note: 'keep' })
  })
})
