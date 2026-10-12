import type { UiSettingsValue } from '../../../../../shared/uiSettings'
import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type { UiSettingsEffect, UiSettingsInput } from './uiSettingsModel'
import { AppControl } from '../../../../ipc/appControl'

export type UiSettingsPorts = SettingsCardPorts<UiSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class UiSettingsEffects {
  static async run(effect: UiSettingsEffect, ports: UiSettingsPorts): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => AppControl.value('uiSettings.get', {}),
        ports,
        {
          loaded: (value: UiSettingsValue) => ({ input: 'loaded' as const, value }),
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value: UiSettingsValue) => AppControl.library('uiSettings.save', { value: value }),
        ports,
        {
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
          saved: (ok: boolean, detail?: string) => ({ input: 'saved' as const, ok, detail }),
        },
      )
    else
      throw new Error(`Unknown ui settings effect: ${JSON.stringify(effect)}`)
  }
}
