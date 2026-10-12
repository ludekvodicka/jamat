import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type {
  VersioningSettingsEffect,
  VersioningSettingsInput,
} from './versioningSettingsModel'
import type { VersioningSettingsField } from '../../../../../shared/versioningSettings'
import { AppControl } from '../../../../ipc/appControl'

export type VersioningSettingsPorts = SettingsCardPorts<VersioningSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class VersioningSettingsEffects {
  static async run(
    effect: VersioningSettingsEffect,
    ports: VersioningSettingsPorts,
    field: VersioningSettingsField = 'mode',
  ): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => AppControl.value('versioningSettings.get', {}),
        ports,
        {
          loaded: (value) => ({ input: 'loaded' as const, value }),
          failed: (detail) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value) => AppControl.library('versioningSettings.save', { value, ...(field === undefined ? {} : { field }) }),
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
