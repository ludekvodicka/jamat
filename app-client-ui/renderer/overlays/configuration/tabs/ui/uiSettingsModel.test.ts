import { describe, expect, it } from 'vitest'

import { UiSettings, type UiSettingsValue } from '../../../../../shared/uiSettings'
import {
  type UiSettingsEffect,
  type UiSettingsInput,
  UiSettingsModel,
  type UiSettingsModelState,
} from './uiSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/ui/uiSettingsModel', () => {
  // A theme that is NOT the default, so reset has something to put back and every value carried
  // through this file proves the third field rides along with the two numbers.
  const storedConst: UiSettingsValue = {
    fontScalePercent: 110,
    fileViewerFontScalePercent: 125,
    terminalFontScalePercent: 120,
    terminalTheme: 'soft',
  }

  /** What the section holds after the one edit every save test below makes. */
  const editedConst: UiSettingsValue = { ...storedConst, fontScalePercent: 130 }

  function loaded(): UiSettingsModelState {
    return UiSettingsModel.transition(
      UiSettingsModel.initial().state,
      { input: 'loaded', value: storedConst },
    ).state
  }

  function run(
    state: UiSettingsModelState,
    ...inputs: readonly UiSettingsInput[]
  ): { state: UiSettingsModelState; effects: UiSettingsEffect[] } {
    let carried = state
    const effects: UiSettingsEffect[] = []
    for (const input of inputs) {
      const step = UiSettingsModel.transition(carried, input)
      carried = step.state
      effects.push(...step.effects)
    }
    return { state: carried, effects }
  }

  it('asks for the value before it can draw a slider', () => {
    const start = UiSettingsModel.initial()

    expect(start.state.buffer).toBeNull()
    expect(start.effects).toEqual([{ effect: 'load' }])
    expect(UiSettingsModel.isModified(start.state)).toBe(false)
  })

  it('refuses an input it does not know', () => {
    expect(() => UiSettingsModel.transition(
      loaded(),
      { input: 'nonsense' } as unknown as UiSettingsInput,
    )).toThrow(/Unknown ui settings input/)
  })

  it('fills the buffer from what was read, with nothing modified yet', () => {
    const state = loaded()

    expect(state.buffer).toEqual(storedConst)
    expect(state.loaded).toEqual(storedConst)
    expect(UiSettingsModel.isModified(state)).toBe(false)
  })

  // The file is edited by hand, so a percentage off the grid can reach the slider; what the buffer
  // holds is what a save would write, and the store refuses anything but a multiple of the step.
  // 112 lands back on the 110 that was read, and a tab that then offered to save would be offering
  // to write the value it already has.
  it('snaps a percentage onto the step before it enters the buffer', () => {
    const { state } = run(loaded(), { input: 'ui-scale', percent: 112 })

    expect(state.buffer?.fontScalePercent).toBe(110)
    expect(state.buffer?.terminalFontScalePercent).toBe(120)
    expect(UiSettingsModel.isModified(state)).toBe(false)
  })

  it('marks the tab modified once a scale actually moves', () => {
    const { state } = run(loaded(), { input: 'ui-scale', percent: 115 })

    expect(state.buffer?.fontScalePercent).toBe(115)
    expect(UiSettingsModel.isModified(state)).toBe(true)
  })

  it('moves the three scales independently', () => {
    const { state } = run(loaded(), { input: 'terminal-scale', percent: 200 })

    expect(state.buffer).toEqual({
      fontScalePercent: 110,
      fileViewerFontScalePercent: 125,
      terminalFontScalePercent: UiSettings.maxPercentConst,
      terminalTheme: 'soft',
    })
  })

  // The scale this section gained last, and the one whose whole point is that it moves on its own:
  // a file is read at one size while the tree and the tabs around it stay where they were.
  it('moves the file viewer scale without touching the interface it sits in', () => {
    const { state } = run(loaded(), { input: 'file-viewer-scale', percent: 140 })

    expect(state.buffer).toEqual({
      fontScalePercent: 110,
      fileViewerFontScalePercent: 140,
      terminalFontScalePercent: 120,
      terminalTheme: 'soft',
    })
    expect(UiSettingsModel.isModified(state)).toBe(true)
  })

  it('snaps the file viewer scale onto the step like the two beside it', () => {
    const { state } = run(loaded(), { input: 'file-viewer-scale', percent: 200 })

    expect(state.buffer?.fileViewerFontScalePercent).toBe(UiSettings.maxPercentConst)
  })

  it('chooses a palette without touching either scale', () => {
    const { state } = run(loaded(), { input: 'terminal-theme', name: 'vscodeDark' })

    expect(state.buffer).toEqual({
      fontScalePercent: 110,
      fileViewerFontScalePercent: 125,
      terminalFontScalePercent: 120,
      terminalTheme: 'vscodeDark',
    })
    expect(UiSettingsModel.isModified(state)).toBe(true)
  })

  // The palette is as much of the section as the two numbers: chosen back to what was read, there
  // is nothing left to save, and a tab offering to would be offering to write what it already has.
  it('reads the palette back as unmodified when it is chosen back', () => {
    const { state } = run(
      loaded(),
      { input: 'terminal-theme', name: 'vscodeDark' },
      { input: 'terminal-theme', name: 'soft' },
    )

    expect(UiSettingsModel.isModified(state)).toBe(false)
  })

  it('puts every scale and the palette back to what the shell shipped with', () => {
    const { state } = run(loaded(), { input: 'reset' })

    expect(state.buffer).toEqual({
      fontScalePercent: 100,
      fileViewerFontScalePercent: 100,
      terminalFontScalePercent: 100,
      terminalTheme: 'original',
    })
    expect(UiSettingsModel.isModified(state)).toBe(true)
  })

  // What a read carried in is what a save carries back out, and `config.json` promises that of a
  // key no build knows. Reset asks for the two sizes back, not for the note beside them to go.
  it('keeps a key it does not know when every scale goes back to the default', () => {
    const noted = { ...storedConst, _note: 'hand written' } as UiSettingsValue
    const read = UiSettingsModel.transition(
      UiSettingsModel.initial().state,
      { input: 'loaded', value: noted },
    ).state

    const { state } = run(read, { input: 'reset' })

    expect(state.buffer).toEqual({
      fontScalePercent: 100,
      fileViewerFontScalePercent: 100,
      terminalFontScalePercent: 100,
      terminalTheme: 'original',
      _note: 'hand written',
    })
  })

  it('changes nothing before the value has been read', () => {
    const { state, effects } = run(
      UiSettingsModel.initial().state,
      { input: 'ui-scale', percent: 130 },
      { input: 'reset' },
      { input: 'save' },
    )

    expect(state.buffer).toBeNull()
    expect(effects).toEqual([])
  })

  it('writes what the sliders hold and refuses a second save over the first', () => {
    const { state, effects } = run(
      loaded(),
      { input: 'ui-scale', percent: 130 },
      { input: 'save' },
      { input: 'save' },
    )

    expect(effects).toEqual([{ effect: 'save', value: editedConst }])
    expect(state.saving).toEqual(editedConst)
  })

  // The window asks before leaving with unsaved work, and a write already on its way is not that:
  // leaving would offer to DISCARD a value that is being put in the file, which it cannot do.
  it('holds nothing unsaved while its own write is in flight', () => {
    const { state } = run(
      loaded(),
      { input: 'ui-scale', percent: 130 },
      { input: 'save' },
    )

    expect(state.saving).not.toBeNull()
    expect(UiSettingsModel.isModified(state)).toBe(false)
  })

  /*
   * The half the test below cannot see, because there the buffer and the write are the same value.
   * The tab disables its controls while a write is out, so this cannot be reached by clicking today
   * - and the model must not depend on that: taking the buffer as the new yardstick would mark a
   * value as saved that the store never saw, and the dirty mark would go out over unsaved work.
   */
  it('takes what the write carried, not what the sliders moved to while it was out', () => {
    const { state } = run(
      loaded(),
      { input: 'ui-scale', percent: 130 },
      { input: 'save' },
      { input: 'ui-scale', percent: 150 },
      { input: 'saved', ok: true },
    )

    expect(state.loaded).toEqual(editedConst)
    expect(state.buffer).toEqual({ ...editedConst, fontScalePercent: 150 })
    expect(UiSettingsModel.isModified(state)).toBe(true)
  })

  /** What was WRITTEN becomes the yardstick, not what the sliders hold when the answer arrives. */
  it('takes the written value as the new yardstick once the save lands', () => {
    const { state } = run(
      loaded(),
      { input: 'ui-scale', percent: 130 },
      { input: 'save' },
      { input: 'saved', ok: true },
    )

    expect(state.loaded).toEqual(editedConst)
    expect(state.saving).toBeNull()
    expect(state.problem).toBeNull()
    expect(UiSettingsModel.isModified(state)).toBe(false)
  })

  it('keeps the sliders and says why when the store refuses the write', () => {
    const { state } = run(
      loaded(),
      { input: 'ui-scale', percent: 130 },
      { input: 'save' },
      { input: 'saved', ok: false, detail: 'config-latched: config.json is unreadable' },
    )

    expect(state.buffer).toEqual(editedConst)
    expect(state.saving).toBeNull()
    expect(state.problem).toBe('config-latched: config.json is unreadable')
    expect(UiSettingsModel.isModified(state)).toBe(true)
  })

  it('reports a channel that did not answer without losing the sliders', () => {
    const { state } = run(
      loaded(),
      { input: 'ui-scale', percent: 130 },
      { input: 'save' },
      { input: 'failed', detail: 'The main process did not answer: gone' },
    )

    expect(state.buffer).toEqual(editedConst)
    expect(state.saving).toBeNull()
    expect(state.problem).toBe('The main process did not answer: gone')
  })
})
