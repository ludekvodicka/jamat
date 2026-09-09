import type { KeyboardSettingsValue } from '../../../../../shared/keyboardSettings'
import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type { KeyboardSettingsEffect, KeyboardSettingsInput } from './keyboardSettingsModel'

export type KeyboardSettingsPorts = SettingsCardPorts<KeyboardSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class KeyboardSettingsEffects {
  static async run(
    effect: KeyboardSettingsEffect,
    ports: KeyboardSettingsPorts,
  ): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => window.appClient.keyboard.getSettings(),
        ports,
        {
          loaded: (value: KeyboardSettingsValue) => ({ input: 'loaded' as const, value }),
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value: KeyboardSettingsValue) => window.appClient.keyboard.saveSettings(value),
        ports,
        {
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
          saved: (ok: boolean, detail?: string) => ({ input: 'saved' as const, ok, detail }),
        },
      )
    else
      throw new Error(`Unknown keyboard settings effect: ${JSON.stringify(effect)}`)
  }
}
