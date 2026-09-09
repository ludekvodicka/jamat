import { describe, expect, it } from 'vitest'

import { VersioningSettingsModel } from './versioningSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/versioning/versioningSettingsModel', () => {
  it('loads, edits and writes the mode', () => {
    let step = VersioningSettingsModel.initial()
    expect(step.effects).toEqual([{ effect: 'load' }])
    step = VersioningSettingsModel.transition(step.state, {
      input: 'loaded',
      value: { mode: 'checkpoints' },
    })
    step = VersioningSettingsModel.transition(step.state, { input: 'mode', value: 'git' })
    expect(VersioningSettingsModel.isModified(step.state)).toBe(true)
    step = VersioningSettingsModel.transition(step.state, { input: 'save' })
    expect(step.effects).toEqual([{ effect: 'save', value: { mode: 'git' } }])
    expect(VersioningSettingsModel.isModified(step.state)).toBe(false)
    step = VersioningSettingsModel.transition(step.state, { input: 'saved', ok: true })
    expect(step.state.loaded).toEqual({ mode: 'git' })
  })

  it('keeps an edited buffer after a refused save', () => {
    let state = VersioningSettingsModel.transition(
      VersioningSettingsModel.initial().state,
      { input: 'loaded', value: { mode: 'checkpoints' } },
    ).state
    state = VersioningSettingsModel.transition(state, { input: 'mode', value: 'git' }).state
    state = VersioningSettingsModel.transition(state, { input: 'save' }).state
    state = VersioningSettingsModel.transition(state, {
      input: 'saved',
      ok: false,
      detail: 'latched',
    }).state
    expect(state.buffer).toEqual({ mode: 'git' })
    expect(state.problem).toBe('latched')
  })
})
