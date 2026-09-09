import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type {
  FileChangesSettingsEffect,
  FileChangesSettingsInput,
} from './fileChangesSettingsModel'

export type FileChangesSettingsPorts = SettingsCardPorts<FileChangesSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class FileChangesSettingsEffects {
  static async run(
    effect: FileChangesSettingsEffect,
    ports: FileChangesSettingsPorts,
  ): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => window.appClient.fileChanges.getSettings(),
        ports,
        {
          loaded: (value) => ({ input: 'loaded' as const, value }),
          failed: (detail) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value) => window.appClient.fileChanges.saveSettings(value),
        ports,
        {
          failed: (detail) => ({ input: 'failed' as const, detail }),
          saved: (ok, detail) => ({ input: 'saved' as const, ok, detail }),
        },
      )
    else
      throw new Error(`Unknown file changes settings effect: ${JSON.stringify(effect)}`)
  }
}
