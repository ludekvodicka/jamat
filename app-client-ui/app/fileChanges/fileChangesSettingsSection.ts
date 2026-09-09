import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import {
  FileChangesSettings,
  type FileChangesSettingsValue,
} from '../../shared/fileChangesSettings'

export class FileChangesSettingsSection {
  static readonly spec: ConfigSectionSpec<FileChangesSettingsValue> = {
    key: 'fileChanges',
    coerce: (value, report) => FileChangesSettings.coerce(value, report),
    validate: (value) => FileChangesSettings.isValid(value)
      ? null
      : `fileChanges.primaryVcs must be one of ${FileChangesSettings.primaryVcsOptionsConst.join(', ')}`,
  }
}
