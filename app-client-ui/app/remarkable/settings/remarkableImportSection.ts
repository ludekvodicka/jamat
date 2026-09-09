import type { ConfigSectionSpec } from '../../../../lib-orchestrator/configStore/configStore.types'
import {
  RemarkableImportSettings,
  type RemarkableImportSettingsValue,
} from '../../../shared/remarkableImportSettings'

export class RemarkableImportSection {
  static readonly spec: ConfigSectionSpec<RemarkableImportSettingsValue> = {
    key: 'remarkableImport',
    coerce: (value, report) => RemarkableImportSettings.coerce(value, report),
    damaged: (value) => RemarkableImportSettings.isDamaged(value),
    validate: (value) => RemarkableImportSettings.isValid(value)
      ? null
      : 'remarkableImport must hold a boolean autoPreviewOnOpen',
  }
}
