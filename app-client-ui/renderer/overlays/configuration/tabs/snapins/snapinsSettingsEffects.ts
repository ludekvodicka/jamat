import type { SnapinsSettingsView } from '../../../../../../lib-orchestrator/snapins/snapinsApi.types'
import { AppControl } from '../../../../ipc/appControl'
import { ErrorText } from '../../../../../shared/errorText'
import { SettingsCardEffects, type SettingsCardEffect, type SettingsCardInput, type SettingsCardPorts } from '../../settingsCard'

export type SnapinsSettingsInput = SettingsCardInput<SnapinsSettingsView> | { input: 'edit'; value: SnapinsSettingsView }
export type SnapinsSettingsEffect = SettingsCardEffect<SnapinsSettingsView>

export class SnapinsSettingsEffects {
  static async run(effect: SnapinsSettingsEffect, ports: SettingsCardPorts<SnapinsSettingsInput>): Promise<void> {
    try {
      switch (effect.effect) {
        case 'load': return await SettingsCardEffects.load(() => AppControl.value('snapins.settings.get', {}), ports, {
          loaded: (value) => ({ input: 'loaded' as const, value }), failed: (detail) => ({ input: 'failed' as const, detail }),
        })
        case 'save': return await SettingsCardEffects.save(effect.value,
          (value) => AppControl.library('snapins.settings.save', { settings: value.settings }), ports, {
            saved: (ok, detail) => ({ input: 'saved' as const, ok, detail }), failed: (detail) => ({ input: 'failed' as const, detail }),
          })
        default: throw new Error(`Unknown snap-ins settings effect ${JSON.stringify(effect satisfies never)}`)
      }
    } catch (error) { ports.dispatch({ input: 'failed', detail: ErrorText.of(error) }) }
  }
}
