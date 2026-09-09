import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type {
  RemarkableStorageSettingsEffect,
  RemarkableStorageSettingsInput,
} from './remarkableStorageSettingsModel'

export type RemarkableStorageSettingsPorts = SettingsCardPorts<RemarkableStorageSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class RemarkableStorageSettingsEffects {
  static async run(
    effect: RemarkableStorageSettingsEffect,
    ports: RemarkableStorageSettingsPorts,
  ): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => window.appClient.remarkable.getStorage(),
        ports,
        {
          loaded: (value) => ({ input: 'loaded' as const, value }),
          failed: (detail) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value) => window.appClient.remarkable.saveStorage(value),
        ports,
        {
          failed: (detail) => ({ input: 'failed' as const, detail }),
          saved: (ok, detail) => ({ input: 'saved' as const, ok, detail }),
        },
      )
    else
      throw new Error(`Unknown reMarkable storage settings effect: ${JSON.stringify(effect)}`)
  }
}
