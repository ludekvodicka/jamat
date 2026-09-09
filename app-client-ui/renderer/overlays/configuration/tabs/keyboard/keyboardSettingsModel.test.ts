import { describe, expect, it } from 'vitest'

import { KeyboardSettings } from '../../../../../shared/keyboardSettings'
import {
  type KeyboardSettingsInput,
  KeyboardSettingsModel,
  type KeyboardSettingsModelState,
  type KeyboardSettingsStep,
} from './keyboardSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/keyboard/keyboardSettingsModel', () => {
  class Run {
    private constructor(readonly step: KeyboardSettingsStep) {}

    static opened(): Run {
      return new Run(KeyboardSettingsModel.initial())
    }

    /** The ordinary starting point: the card is up and the stored value has arrived. */
    static loaded(launcherKeys: 'session-first' | 'tab-first' = 'session-first'): Run {
      return Run.opened().on({ input: 'loaded', value: { launcherKeys } })
    }

    on(...inputs: readonly KeyboardSettingsInput[]): Run {
      let step = this.step
      for (const input of inputs)
        step = KeyboardSettingsModel.transition(step.state, input)
      return new Run(step)
    }

    get state(): KeyboardSettingsModelState {
      return this.step.state
    }
  }

  it('reads the section as soon as it opens, with nothing to edit until it answers', () => {
    const run = Run.opened()
    expect(run.step.effects).toEqual([{ effect: 'load' }])
    expect(run.state.buffer).toBeNull()
    expect(KeyboardSettingsModel.isModified(run.state)).toBe(false)
  })

  /*
   * The guard the UI tab beside it carries for the same reason: a buffer conjured out of the default
   * would read as modified against a `loaded` that was never there, and the card would offer to save
   * a value it had not seen.
   */
  it('edits nothing before the read lands', () => {
    const run = Run.opened().on({ input: 'launcher-keys', preference: 'tab-first' })
    expect(run.state.buffer).toBeNull()
    expect(run.step.effects).toEqual([])
  })

  it('holds the chosen answer and reports itself modified until it is saved', () => {
    const chosen = Run.loaded().on({ input: 'launcher-keys', preference: 'tab-first' })
    expect(chosen.state.buffer).toEqual({ launcherKeys: 'tab-first' })
    expect(KeyboardSettingsModel.isModified(chosen.state)).toBe(true)

    const saved = chosen.on({ input: 'save' })
    expect(saved.step.effects).toEqual([{ effect: 'save', value: { launcherKeys: 'tab-first' } }])
    // A save in flight is not unsaved work: the value is already on its way into the file.
    expect(KeyboardSettingsModel.isModified(saved.state)).toBe(false)
  })

  it('reads as unmodified again once the choice is put back', () => {
    const returned = Run.loaded()
      .on({ input: 'launcher-keys', preference: 'tab-first' })
      .on({ input: 'launcher-keys', preference: 'session-first' })
    expect(KeyboardSettingsModel.isModified(returned.state)).toBe(false)
  })

  /* Over the buffer rather than in place of it: a note written beside the key by hand survives. */
  it('resets to the default without dropping what else the section held', () => {
    const run = Run.opened()
      .on({ input: 'loaded', value: { launcherKeys: 'tab-first', note: 'laptop' } as never })
      .on({ input: 'reset' })
    expect(run.state.buffer)
      .toEqual({ launcherKeys: KeyboardSettings.defaultConst.launcherKeys, note: 'laptop' })
  })

  it('keeps the buffer when a read or a save fails, and says what happened', () => {
    const run = Run.loaded()
      .on({ input: 'launcher-keys', preference: 'tab-first' }, { input: 'save' })
      .on({ input: 'failed', detail: 'config-latched' })
    expect(run.state.buffer).toEqual({ launcherKeys: 'tab-first' })
    expect(run.state.saving).toBeNull()
    expect(run.state.problem).toBe('config-latched')
  })

  it('throws on an input it does not know', () => {
    expect(() => KeyboardSettingsModel.transition(
      Run.loaded().state,
      { input: 'nope' } as unknown as KeyboardSettingsInput,
    )).toThrow(/Unknown keyboard settings input/)
  })
})
