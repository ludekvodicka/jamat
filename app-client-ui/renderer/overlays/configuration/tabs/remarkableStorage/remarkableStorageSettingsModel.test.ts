import { describe, expect, it } from 'vitest'

import type { RemarkableStorageSettingsValue } from '../../../../../shared/remarkableStorageSettings'
import {
  RemarkableStorageSettingsModel,
  type RemarkableStorageSettingsInput,
  type RemarkableStorageSettingsStep,
} from './remarkableStorageSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/remarkableStorage/remarkableStorageSettingsModel', () => {
  const storedConst: RemarkableStorageSettingsValue = {
    scope: 'global',
    projectDirectory: '.remarkable',
  }

  function loaded(value: RemarkableStorageSettingsValue = storedConst): RemarkableStorageSettingsStep {
    return RemarkableStorageSettingsModel.transition(
      RemarkableStorageSettingsModel.initial().state,
      { input: 'loaded', value },
    )
  }

  function then(
    step: RemarkableStorageSettingsStep,
    input: RemarkableStorageSettingsInput,
  ): RemarkableStorageSettingsStep {
    return RemarkableStorageSettingsModel.transition(step.state, input)
  }

  it('asks for the section and reports nothing modified until a control moves', () => {
    expect(RemarkableStorageSettingsModel.initial().effects).toEqual([{ effect: 'load' }])
    const start = loaded()
    expect(RemarkableStorageSettingsModel.isModified(start.state)).toBe(false)

    const moved = then(start, { input: 'scope', value: 'project' })
    expect(RemarkableStorageSettingsModel.isModified(moved.state)).toBe(true)
    expect(RemarkableStorageSettingsModel.canSave(moved.state)).toBe(true)
  })

  it('saves the scope and the folder together', () => {
    const typed = then(
      then(loaded(), { input: 'scope', value: 'project' }),
      { input: 'project-directory', value: '.aidocs/remarkable' },
    )

    expect(then(typed, { input: 'save' }).effects).toEqual([{
      effect: 'save',
      value: { scope: 'project', projectDirectory: '.aidocs/remarkable' },
    }])
  })

  /**
   * A half-typed path is what typing looks like, so it stays in the buffer; what it does is hold the
   * save, because a folder that could point outside the project must not reach config.json.
   */
  it('keeps an unusable folder visible and refuses to save it', () => {
    const typed = then(
      then(loaded(), { input: 'scope', value: 'project' }),
      { input: 'project-directory', value: '../outside' },
    )

    expect(typed.state.buffer?.projectDirectory).toBe('../outside')
    expect(RemarkableStorageSettingsModel.problemOf(typed.state)).not.toBeNull()
    expect(RemarkableStorageSettingsModel.canSave(typed.state)).toBe(false)
    expect(then(typed, { input: 'save' }).effects).toEqual([])
  })

  it('says nothing about the folder while storage is global', () => {
    const typed = then(loaded({ scope: 'global', projectDirectory: '../outside' }),
      { input: 'project-directory', value: '../still-outside' })

    expect(RemarkableStorageSettingsModel.problemOf(typed.state)).toBeNull()
    expect(RemarkableStorageSettingsModel.canSave(typed.state)).toBe(true)
  })

  it('resets both fields to the defaults without saving', () => {
    const moved = then(
      then(loaded(), { input: 'scope', value: 'project' }),
      { input: 'project-directory', value: 'docs/pages' },
    )

    const reset = then(moved, { input: 'reset' })

    expect(reset.state.buffer).toEqual({ scope: 'global', projectDirectory: '.remarkable' })
    expect(reset.effects).toEqual([])
  })
})
