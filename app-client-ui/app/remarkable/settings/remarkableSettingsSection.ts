import type { ConfigSectionSpec } from '../../../../lib-orchestrator/configStore/configStore.types'
import {
  RemarkableSettings,
  type RemarkableSettingsValue,
} from '../../../shared/remarkableSettings'

export class RemarkableSettingsSection {
  static readonly spec: ConfigSectionSpec<RemarkableSettingsValue> = {
    key: 'remarkable',
    coerce: (value, report) => RemarkableSettings.coerce(value, report),
    damaged: (value) => RemarkableSettings.isDamaged(value),
    validate: (value) => RemarkableSettings.isValid(value)
      ? null
      : 'remarkable must hold an optional whitespace-free host, an optional SHA256 fingerprint '
        + `and an integer timeoutMilliseconds between `
        + `${RemarkableSettings.timeoutMillisecondsMinConst} and `
        + `${RemarkableSettings.timeoutMillisecondsMaxConst}`,
  }
}
