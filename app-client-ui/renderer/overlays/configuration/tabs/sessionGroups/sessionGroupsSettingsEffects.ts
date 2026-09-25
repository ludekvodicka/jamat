import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type {
  SessionGroupsList,
  SessionGroupsSettingsEffect,
  SessionGroupsSettingsInput,
} from './sessionGroupsSettingsModel'

export type SessionGroupsSettingsPorts = SettingsCardPorts<SessionGroupsSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class SessionGroupsSettingsEffects {
  static async run(
    effect: SessionGroupsSettingsEffect,
    ports: SessionGroupsSettingsPorts,
  ): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => window.appClient.sessionGroups.getGroups(),
        ports,
        {
          loaded: (value: SessionGroupsList) => ({ input: 'loaded' as const, value }),
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value: SessionGroupsList) => window.appClient.sessionGroups.saveGroups(value),
        ports,
        {
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
          saved: (ok: boolean, detail?: string) => ({ input: 'saved' as const, ok, detail }),
        },
      )
    else
      throw new Error(`Unknown session groups settings effect: ${JSON.stringify(effect)}`)
  }
}
