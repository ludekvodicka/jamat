import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import { UiSettings, type UiSettingsValue } from '../../shared/uiSettings'

/**
 * The `ui` key of `config.json`, and nothing about the file it sits in.
 *
 * There is no rule here that the renderer does not also have: the slider bounds, the coercion and
 * the validation are all `UiSettings`, so a value the tab could produce cannot be one this refuses.
 */
export class UiSettingsSection {
  static readonly spec: ConfigSectionSpec<UiSettingsValue> = {
    key: 'ui',
    coerce: (value, report) => UiSettings.coerce(value, report),
    validate: (value) => (UiSettings.isValid(value)
      ? null
      : `ui font scales must be multiples of ${UiSettings.stepPercentConst} between `
        + `${UiSettings.minPercentConst} and ${UiSettings.maxPercentConst}, and terminalTheme `
        + `one of ${UiSettings.terminalThemesConst.join(', ')}`),
  }
}
