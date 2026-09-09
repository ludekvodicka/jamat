import {
  FileChangesSettings,
  type FileChangesPrimaryVcs,
  type FileChangesSettingsValue,
} from '../../../../../shared/fileChangesSettings'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
  type SettingsCardStep,
} from '../../settingsCard'

export type FileChangesSettingsModelState = SettingsCardState<FileChangesSettingsValue>

export type FileChangesSettingsInput =
  | SettingsCardInput<FileChangesSettingsValue>
  | { input: 'primary-vcs'; value: FileChangesPrimaryVcs }

export type FileChangesSettingsEffect = SettingsCardEffect<FileChangesSettingsValue>

export type FileChangesSettingsStep =
  SettingsCardStep<FileChangesSettingsValue, FileChangesSettingsEffect>

/**
 * The file changes tab as data: one choice, and the machine every settings card shares.
 *
 * What is this file's own is the one control and how two values compare. The load, the save, the
 * "a save in flight is not unsaved work" rule and the reset are `SettingsCard`'s.
 */
export class FileChangesSettingsModel {
  static initial(): FileChangesSettingsStep {
    return SettingsCard.initial()
  }

  static isModified(state: FileChangesSettingsModelState): boolean {
    return SettingsCard.isModified(state, (loaded, buffer) =>
      loaded.primaryVcs === buffer.primaryVcs)
  }

  static transition(
    state: FileChangesSettingsModelState,
    input: FileChangesSettingsInput,
  ): FileChangesSettingsStep {
    const shared = SettingsCard.transition<FileChangesSettingsValue, FileChangesSettingsEffect>(
      state,
      input,
      (buffer) => ({ ...buffer, ...FileChangesSettings.defaultValue() }),
    )
    if (shared !== null) return shared
    if (input.input === 'primary-vcs')
      return state.buffer === null
        ? SettingsCard.step(state)
        : SettingsCard.step({ ...state, buffer: { ...state.buffer, primaryVcs: input.value } })
    else
      throw new Error(`Unknown file changes settings input: ${JSON.stringify(input)}`)
  }
}
