import { describe, expect, it } from 'vitest'

import { FileChangesSettings } from '../../shared/fileChangesSettings'
import { FileChangesSettingsSection } from './fileChangesSettingsSection'

describe('app-client-ui/app/fileChanges/fileChangesSettingsSection', () => {
  it('owns fileChanges and accepts exactly the shared model', () => {
    expect(FileChangesSettingsSection.spec.key).toBe('fileChanges')
    expect(FileChangesSettingsSection.spec.validate(FileChangesSettings.defaultValue())).toBeNull()
    expect(FileChangesSettingsSection.spec.validate({ primaryVcs: 'hg' as never }))
      .toContain('primaryVcs')
  })
})
