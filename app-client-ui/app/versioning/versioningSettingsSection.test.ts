import { describe, expect, it } from 'vitest'

import { VersioningSettings } from '../../shared/versioningSettings'
import { VersioningSettingsSection } from './versioningSettingsSection'

describe('app-client-ui/app/versioning/versioningSettingsSection', () => {
  it('owns versioning and accepts exactly the shared model', () => {
    expect(VersioningSettingsSection.spec.key).toBe('versioning')
    expect(VersioningSettingsSection.spec.validate(VersioningSettings.defaultValue())).toBeNull()
    expect(VersioningSettingsSection.spec.validate({ mode: 'jj' as never, diffTool: { kind: 'internal' } })).toContain('mode')
  })

  it('reads a damaged section rather than refusing, so the app always has a mode', () => {
    const messages: string[] = []
    expect(VersioningSettingsSection.spec.coerce({ mode: 'jj' }, (m) => messages.push(m)))
      .toEqual({ mode: 'checkpoints', diffTool: { kind: 'internal' } })
    expect(messages).toHaveLength(1)
  })
})
