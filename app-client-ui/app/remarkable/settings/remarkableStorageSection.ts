import type { ConfigSectionSpec } from '../../../../lib-orchestrator/configStore/configStore.types'
import {
  RemarkableStorageSettings,
  type RemarkableStorageSettingsValue,
} from '../../../shared/remarkableStorageSettings'

/**
 * Its own key rather than a field of `remarkable`. Two settings cards over one section would each
 * load the whole value and save the whole value back, so saving the storage card would restore the
 * host the connection card had just changed.
 */
export class RemarkableStorageSection {
  static readonly spec: ConfigSectionSpec<RemarkableStorageSettingsValue> = {
    key: 'remarkableStorage',
    coerce: (value, report) => RemarkableStorageSettings.coerce(value, report),
    damaged: (value) => RemarkableStorageSettings.isDamaged(value),
    validate: (value) => RemarkableStorageSettings.isValid(value)
      ? null
      : 'remarkableStorage must hold a scope of global or project and a relative projectDirectory '
        + 'inside the project',
  }
}
