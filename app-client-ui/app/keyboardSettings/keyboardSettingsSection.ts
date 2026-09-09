import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import { KeyboardSettings, type KeyboardSettingsValue } from '../../shared/keyboardSettings'

/**
 * The `keyboard` key of `config.json`, and nothing about the file it sits in.
 *
 * There is no rule here that the renderer does not also have: the two allowed values, the coercion
 * and the validation are all `KeyboardSettings`, so a value the tab could produce cannot be one this
 * refuses.
 */
export class KeyboardSettingsSection {
  static readonly spec: ConfigSectionSpec<KeyboardSettingsValue> = {
    key: 'keyboard',
    coerce: (value, report) => KeyboardSettings.coerce(value, report),
    validate: (value) => (KeyboardSettings.isValid(value)
      ? null
      : `keyboard.launcherKeys must be one of ${KeyboardSettings.preferencesConst.join(', ')}`),
  }
}
