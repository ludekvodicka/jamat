import type { AgentSettingsValue } from '../../../../../shared/agentSettings'
import {
  SettingsCardEffects,
  type SettingsCardPorts,
} from '../../settingsCard'
import type { AgentSettingsEffect, AgentSettingsInput } from './agentSettingsModel'
import { AppControl } from '../../../../ipc/appControl'

export type AgentSettingsPorts = SettingsCardPorts<AgentSettingsInput>

/** Which channels this card reads and writes; the two calls around them are `SettingsCardEffects`'. */
export class AgentSettingsEffects {
  static async run(effect: AgentSettingsEffect, ports: AgentSettingsPorts): Promise<void> {
    if (effect.effect === 'load')
      return SettingsCardEffects.load(
        () => AppControl.value('agentSettings.get', {}),
        ports,
        {
          loaded: (value: AgentSettingsValue) => ({ input: 'loaded' as const, value }),
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
        },
      )
    else if (effect.effect === 'save')
      return SettingsCardEffects.save(
        effect.value,
        (value: AgentSettingsValue) => AppControl.library('agentSettings.save', { value: value }),
        ports,
        {
          failed: (detail: string) => ({ input: 'failed' as const, detail }),
          saved: (ok: boolean, detail?: string) => ({ input: 'saved' as const, ok, detail }),
        },
      )
    else
      throw new Error(`Unknown agents settings effect: ${JSON.stringify(effect)}`)
  }
}
