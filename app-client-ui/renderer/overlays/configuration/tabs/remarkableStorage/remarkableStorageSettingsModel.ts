import {
  RemarkableStorageSettings,
  type RemarkableStorageScope,
  type RemarkableStorageSettingsValue,
} from '../../../../../shared/remarkableStorageSettings'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
  type SettingsCardStep,
} from '../../settingsCard'

export type RemarkableStorageSettingsModelState = SettingsCardState<RemarkableStorageSettingsValue>

export type RemarkableStorageSettingsInput =
  | SettingsCardInput<RemarkableStorageSettingsValue>
  | { input: 'scope'; value: RemarkableStorageScope }
  | { input: 'project-directory'; value: string }

export type RemarkableStorageSettingsEffect = SettingsCardEffect<RemarkableStorageSettingsValue>

export type RemarkableStorageSettingsStep =
  SettingsCardStep<RemarkableStorageSettingsValue, RemarkableStorageSettingsEffect>

/**
 * The storage tab as data: two controls, over the machine every settings card shares.
 *
 * The folder is held in the buffer even while it is unusable, because a half-typed path is what
 * typing looks like; what an unusable one does is refuse the SAVE, so nothing that could point
 * outside a project ever reaches config.json.
 */
export class RemarkableStorageSettingsModel {
  static initial(): RemarkableStorageSettingsStep {
    return SettingsCard.initial()
  }

  static isModified(state: RemarkableStorageSettingsModelState): boolean {
    return SettingsCard.isModified(state, (loaded, buffer) =>
      loaded.scope === buffer.scope && loaded.projectDirectory === buffer.projectDirectory)
  }

  /** The sentence under the folder field, or null while there is nothing to say. */
  static problemOf(state: RemarkableStorageSettingsModelState): string | null {
    if (state.buffer === null || state.buffer.scope !== 'project') return null
    return RemarkableStorageSettings.projectDirectoryProblem(state.buffer.projectDirectory)
  }

  static canSave(state: RemarkableStorageSettingsModelState): boolean {
    return RemarkableStorageSettingsModel.isModified(state)
      && state.saving === null
      && RemarkableStorageSettingsModel.problemOf(state) === null
  }

  static transition(
    state: RemarkableStorageSettingsModelState,
    input: RemarkableStorageSettingsInput,
  ): RemarkableStorageSettingsStep {
    if (input.input === 'save' && RemarkableStorageSettingsModel.problemOf(state) !== null)
      return SettingsCard.step(state)
    const shared = SettingsCard.transition<
      RemarkableStorageSettingsValue,
      RemarkableStorageSettingsEffect
    >(state, input, () => RemarkableStorageSettings.defaultValue())
    if (shared !== null) return shared
    if (input.input === 'scope')
      return state.buffer === null
        ? SettingsCard.step(state)
        : SettingsCard.step({ ...state, buffer: { ...state.buffer, scope: input.value } })
    else if (input.input === 'project-directory')
      return state.buffer === null
        ? SettingsCard.step(state)
        : SettingsCard.step({
          ...state,
          buffer: { ...state.buffer, projectDirectory: input.value },
        })
    else
      throw new Error(`Unknown reMarkable storage settings input: ${JSON.stringify(input)}`)
  }
}
