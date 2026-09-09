import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import {
  VersioningSettings,
  type VersioningSettingsValue,
} from '../../shared/versioningSettings'

export class VersioningSettingsSection {
  static readonly spec: ConfigSectionSpec<VersioningSettingsValue> = {
    key: 'versioning',
    coerce: (value, report) => VersioningSettings.coerce(value, report),
    validate: (value) => VersioningSettings.isValid(value)
      ? null
      : `versioning.mode must be one of ${VersioningSettings.modeOptionsConst.join(', ')}`,
  }
}
