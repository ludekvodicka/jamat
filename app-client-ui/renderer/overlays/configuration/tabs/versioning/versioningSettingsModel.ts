import type { VersioningMode } from '../../../../../../lib-orchestrator/git/git.types'
import {
  VersioningSettings,
  type VersioningSettingsValue,
} from '../../../../../shared/versioningSettings'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
  type SettingsCardStep,
} from '../../settingsCard'

export type VersioningSettingsModelState = SettingsCardState<VersioningSettingsValue>

export type VersioningSettingsInput =
  | SettingsCardInput<VersioningSettingsValue>
  | { input: 'mode'; value: VersioningMode }

export type VersioningSettingsEffect = SettingsCardEffect<VersioningSettingsValue>

export type VersioningSettingsStep =
  SettingsCardStep<VersioningSettingsValue, VersioningSettingsEffect>

/**
 * The versioning tab as data: one choice, and the machine every settings card shares.
 *
 * What is this file's own is the one control and how two values compare. The load, the save, the
 * "a save in flight is not unsaved work" rule and the reset are `SettingsCard`'s.
 */
export class VersioningSettingsModel {
  static initial(): VersioningSettingsStep {
    return SettingsCard.initial()
  }

  static isModified(state: VersioningSettingsModelState): boolean {
    return SettingsCard.isModified(state, (loaded, buffer) => loaded.mode === buffer.mode)
  }

  static transition(
    state: VersioningSettingsModelState,
    input: VersioningSettingsInput,
  ): VersioningSettingsStep {
    const shared = SettingsCard.transition<VersioningSettingsValue, VersioningSettingsEffect>(
      state,
      input,
      (buffer) => ({ ...buffer, ...VersioningSettings.defaultValue() }),
    )
    if (shared !== null) return shared
    if (input.input === 'mode')
      return state.buffer === null
        ? SettingsCard.step(state)
        : SettingsCard.step({ ...state, buffer: { ...state.buffer, mode: input.value } })
    else
      throw new Error(`Unknown versioning settings input: ${JSON.stringify(input)}`)
  }
}
