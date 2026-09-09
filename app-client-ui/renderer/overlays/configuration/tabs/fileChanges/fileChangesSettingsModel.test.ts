import { describe, expect, it } from 'vitest'

import { FileChangesSettingsModel } from './fileChangesSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/fileChanges/fileChangesSettingsModel', () => {
  it('loads, edits and writes the primary VCS', () => {
    let step = FileChangesSettingsModel.initial()
    expect(step.effects).toEqual([{ effect: 'load' }])
    step = FileChangesSettingsModel.transition(step.state, {
      input: 'loaded',
      value: { primaryVcs: 'git' },
    })
    step = FileChangesSettingsModel.transition(step.state, {
      input: 'primary-vcs',
      value: 'svn',
    })
    expect(FileChangesSettingsModel.isModified(step.state)).toBe(true)
    step = FileChangesSettingsModel.transition(step.state, { input: 'save' })
    expect(step.effects).toEqual([{ effect: 'save', value: { primaryVcs: 'svn' } }])
    expect(FileChangesSettingsModel.isModified(step.state)).toBe(false)
    step = FileChangesSettingsModel.transition(step.state, { input: 'saved', ok: true })
    expect(step.state.loaded).toEqual({ primaryVcs: 'svn' })
  })

  it('keeps an edited buffer after a refused save', () => {
    let state = FileChangesSettingsModel.transition(
      FileChangesSettingsModel.initial().state,
      { input: 'loaded', value: { primaryVcs: 'git' } },
    ).state
    state = FileChangesSettingsModel.transition(state, {
      input: 'primary-vcs',
      value: 'svn',
    }).state
    state = FileChangesSettingsModel.transition(state, { input: 'save' }).state
    state = FileChangesSettingsModel.transition(state, {
      input: 'saved',
      ok: false,
      detail: 'latched',
    }).state
    expect(state.buffer).toEqual({ primaryVcs: 'svn' })
    expect(state.problem).toBe('latched')
  })
})
