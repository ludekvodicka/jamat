import type { LauncherKeyPreference } from '../../../../../shared/commands'
import {
  KeyboardSettings,
  type KeyboardSettingsValue,
} from '../../../../../shared/keyboardSettings'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
  type SettingsCardStep,
} from '../../settingsCard'

export type KeyboardSettingsModelState = SettingsCardState<KeyboardSettingsValue>

export type KeyboardSettingsInput =
  | SettingsCardInput<KeyboardSettingsValue>
  | { input: 'launcher-keys'; preference: LauncherKeyPreference }

export type KeyboardSettingsEffect = SettingsCardEffect<KeyboardSettingsValue>

export type KeyboardSettingsStep =
  SettingsCardStep<KeyboardSettingsValue, KeyboardSettingsEffect>

/**
 * The Keyboard tab as data: one choice being edited.
 *
 * There is no preview here, unlike the UI tab beside it. What this decides is built into the native
 * menu by the main process, so the only way to see it is to save it; a card that applied a key
 * before it was written would leave a menu disagreeing with the file it came from.
 *
 * The load, the save, the reset and the rule that a save in flight is not unsaved work are
 * `SettingsCard`'s.
 */
export class KeyboardSettingsModel {
  static initial(): KeyboardSettingsStep {
    return SettingsCard.initial()
  }

  static isModified(state: KeyboardSettingsModelState): boolean {
    return SettingsCard.isModified(state, (loaded, buffer) =>
      buffer.launcherKeys === loaded.launcherKeys)
  }

  static transition(
    state: KeyboardSettingsModelState,
    input: KeyboardSettingsInput,
  ): KeyboardSettingsStep {
    const shared = SettingsCard.transition<KeyboardSettingsValue, KeyboardSettingsEffect>(
      state,
      input,
      // Over the buffer rather than in place of it, for the reason the UI tab carries: whatever else
      // was written inside the `keyboard` key by hand is not what Reset is asking to be rid of.
      (buffer) => ({ ...buffer, ...KeyboardSettings.defaultConst }),
    )
    if (shared !== null) return shared
    if (input.input === 'launcher-keys') {
      const buffer = state.buffer
      // With nothing read yet there is nothing to edit: a buffer conjured out of the default would
      // read as modified against a `loaded` that was never there.
      if (buffer === null) return SettingsCard.step(state)
      return SettingsCard.step({
        ...state,
        buffer: { ...buffer, launcherKeys: input.preference },
      })
    }
    else
      throw new Error(`Unknown keyboard settings input: ${JSON.stringify(input)}`)
  }
}
