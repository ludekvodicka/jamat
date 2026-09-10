import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type {
  VersioningSettingsEffect,
  VersioningSettingsInput,
} from './versioningSettingsModel'
import type { VersioningSettingsValue } from '../../../../../shared/versioningSettings'

export type VersioningSettingsPorts = SettingsCardPorts<VersioningSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class VersioningSettingsEffects {
  static async run(
    effect: VersioningSettingsEffect,
    ports: VersioningSettingsPorts,
    field: keyof VersioningSettingsValue = 'mode',
  ): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => window.appClient.versioning.getSettings(),
        ports,
        {
          loaded: (value) => ({ input: 'loaded' as const, value }),
          failed: (detail) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value) => window.appClient.versioning.saveSettings(value, field),
        ports,
        {
          failed: (detail) => ({ input: 'failed' as const, detail }),
          saved: (ok, detail) => ({ input: 'saved' as const, ok, detail }),
        },
      )
    else
      throw new Error(`Unknown versioning settings effect: ${JSON.stringify(effect)}`)
  }
}
