import {
  type TerminalThemeName,
  UiSettings,
  type UiSettingsValue,
} from '../../../../../shared/uiSettings'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
  type SettingsCardStep,
} from '../../settingsCard'

export type UiSettingsModelState = SettingsCardState<UiSettingsValue>

export type UiSettingsInput =
  | SettingsCardInput<UiSettingsValue>
  | { input: 'ui-scale'; percent: number }
  | { input: 'file-viewer-scale'; percent: number }
  | { input: 'terminal-scale'; percent: number }
  | { input: 'terminal-theme'; name: TerminalThemeName }
  | { input: 'scroll-speed'; percent: number }
  | { input: 'terminal-scroll-speed'; percent: number }

export type UiSettingsEffect = SettingsCardEffect<UiSettingsValue>

export type UiSettingsStep = SettingsCardStep<UiSettingsValue, UiSettingsEffect>

/**
 * The UI tab as data: five percentages and a palette name being edited.
 *
 * There is deliberately no `staleOnDisk` here, the flag the projects tab carries. That flag exists
 * because a catalog is work - roots named, ordered and grouped by hand - and a file that moved under
 * it holds someone else's version of that work. This section is six fields with no history: the
 * last write wins, which is what a font size means. Nothing is reconciled because nothing here can
 * be lost that is not on screen while it is being lost.
 *
 * `UiSettings.snap` is applied on the way IN rather than at the save, so the buffer only ever holds
 * a value the store would accept: what the readout shows, what the preview applies and what a save
 * would write are then one number instead of three.
 *
 * The load, the save, the reset and the rule that a save in flight is not unsaved work are
 * `SettingsCard`'s - three cards share them.
 */
export class UiSettingsModel {
  static initial(): UiSettingsStep {
    return SettingsCard.initial()
  }

  /**
   * Field by field rather than through `JSON.stringify`: comparing the text of two objects compares
   * key order too, which is the mistake `SidebarsState` carries the note about.
   */
  static isModified(state: UiSettingsModelState): boolean {
    return SettingsCard.isModified(state, (loaded, buffer) =>
      buffer.fontScalePercent === loaded.fontScalePercent
      && buffer.fileViewerFontScalePercent === loaded.fileViewerFontScalePercent
      && buffer.terminalFontScalePercent === loaded.terminalFontScalePercent
      && buffer.terminalTheme === loaded.terminalTheme
      && buffer.scrollSpeedPercent === loaded.scrollSpeedPercent
      && buffer.terminalScrollSpeedPercent === loaded.terminalScrollSpeedPercent)
  }

  static transition(state: UiSettingsModelState, input: UiSettingsInput): UiSettingsStep {
    const shared = SettingsCard.transition<UiSettingsValue, UiSettingsEffect>(
      state,
      input,
      // Over the buffer rather than in place of it: what the buffer also carries is whatever else
      // was written inside the `ui` key, and Reset asks for the six fields back, not for a
      // hand-written note beside them to be deleted by the save that follows.
      (buffer) => ({ ...buffer, ...UiSettings.defaultValue() }),
    )
    if (shared !== null) return shared
    if (input.input === 'ui-scale')
      return UiSettingsModel.edited(state, (buffer) => ({
        ...buffer,
        fontScalePercent: UiSettings.snap(input.percent, UiSettings.fontRangeConst),
      }))
    else if (input.input === 'file-viewer-scale')
      return UiSettingsModel.edited(state, (buffer) => ({
        ...buffer,
        fileViewerFontScalePercent: UiSettings.snap(input.percent, UiSettings.fontRangeConst),
      }))
    else if (input.input === 'terminal-scale')
      return UiSettingsModel.edited(state, (buffer) => ({
        ...buffer,
        terminalFontScalePercent: UiSettings.snap(input.percent, UiSettings.fontRangeConst),
      }))
    else if (input.input === 'terminal-theme')
      return UiSettingsModel.edited(state, (buffer) => ({
        ...buffer,
        terminalTheme: input.name,
      }))
    else if (input.input === 'scroll-speed')
      return UiSettingsModel.edited(state, (buffer) => ({
        ...buffer,
        scrollSpeedPercent: UiSettings.snap(input.percent, UiSettings.scrollRangeConst),
      }))
    else if (input.input === 'terminal-scroll-speed')
      return UiSettingsModel.edited(state, (buffer) => ({
        ...buffer,
        terminalScrollSpeedPercent: UiSettings.snap(input.percent, UiSettings.scrollRangeConst),
      }))
    else
      throw new Error(`Unknown ui settings input: ${JSON.stringify(input)}`)
  }

  /**
   * Every edit goes through here, and with nothing read yet there is nothing to edit: a buffer
   * conjured out of the defaults would read as modified against a `loaded` that was never there,
   * and the tab would offer to save a value it had not seen.
   */
  private static edited(
    state: UiSettingsModelState,
    change: (buffer: UiSettingsValue) => UiSettingsValue,
  ): UiSettingsStep {
    const buffer = state.buffer
    if (buffer === null)
      return SettingsCard.step(state)
    return SettingsCard.step({ ...state, buffer: change(buffer) })
  }
}
