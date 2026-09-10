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
  | { input: 'diffTool'; value: VersioningSettingsValue['diffTool'] }

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

  static isModified(state: VersioningSettingsModelState, field: keyof VersioningSettingsValue = 'mode'): boolean {
    return SettingsCard.isModified(state, (loaded, buffer) => JSON.stringify(loaded[field]) === JSON.stringify(buffer[field]))
  }

  static transition(
    state: VersioningSettingsModelState,
    input: VersioningSettingsInput,
    field: keyof VersioningSettingsValue = 'mode',
  ): VersioningSettingsStep {
    const shared = SettingsCard.transition<VersioningSettingsValue, VersioningSettingsEffect>(
      state,
      input,
      (buffer) => ({ ...buffer, [field]: VersioningSettings.defaultValue()[field] }),
    )
    if (shared !== null) return shared
    if (input.input === 'mode' || input.input === 'diffTool')
      return state.buffer === null
        ? SettingsCard.step(state)
        : SettingsCard.step({ ...state, buffer: { ...state.buffer, [input.input]: input.value } })
    else
      throw new Error(`Unknown versioning settings input: ${JSON.stringify(input)}`)
  }
}
