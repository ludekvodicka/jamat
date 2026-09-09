import { describe, expect, it } from 'vitest'

import type { ConfigurationTabId } from './configurationTab.types'
import {
  type ConfigurationInput,
  ConfigurationModel,
  type ConfigurationState,
} from './configurationModel'

describe('app-client-ui/renderer/overlays/configuration/configurationModel', () => {
  /**
   * A real second screen, because the model resolves a selection through the catalog: a group is
   * answered with its first screen, and an id nobody holds is a defect rather than an empty pane.
   */
  const otherConst: ConfigurationTabId = 'ui'

  function dirtyOn(tab: ConfigurationTabId): ConfigurationState {
    return ConfigurationModel.transition(
      ConfigurationModel.initial(),
      { input: 'dirty', tab, dirty: true },
    ).state
  }

  function run(
    state: ConfigurationState,
    ...inputs: readonly ConfigurationInput[]
  ): { state: ConfigurationState; effects: unknown[] } {
    let current = state
    const effects: unknown[] = []
    for (const input of inputs) {
      const step = ConfigurationModel.transition(current, input)
      current = step.state
      effects.push(...step.effects)
    }
    return { state: current, effects }
  }

  it('starts on the first tab of the catalog with nothing unsaved', () => {
    const state = ConfigurationModel.initial()

    expect(state.activeTab).toBe('projects')
    expect([...state.dirty]).toEqual([])
    expect(state.leaving).toBeNull()
  })

  it('starts on a requested catalog tab', () => {
    expect(ConfigurationModel.initial('window').activeTab).toBe('window')
  })

  it('refuses an initial tab absent from the catalog', () => {
    expect(() => ConfigurationModel.initial('missing' as ConfigurationTabId))
      .toThrow(/holds no tab/)
  })

  it('switches away from a clean tab without asking', () => {
    const { state, effects } = run(ConfigurationModel.initial(), { input: 'select', tab: otherConst })

    expect(state.activeTab).toBe(otherConst)
    expect(state.leaving).toBeNull()
    expect(effects).toEqual([])
  })

  it('does nothing when the tab already shown is selected again', () => {
    const { state } = run(dirtyOn('projects'), { input: 'select', tab: 'projects' })

    expect(state.activeTab).toBe('projects')
    expect(state.leaving).toBeNull()
  })

  it('asks before switching away from a tab holding unsaved work', () => {
    const { state, effects } = run(dirtyOn('projects'), { input: 'select', tab: otherConst })

    expect(state.leaving).toEqual({ from: 'projects', to: otherConst })
    expect(state.activeTab).toBe('projects')
    expect(effects).toEqual([])
  })

  it('switches and drops the unsaved work when the answer is to leave', () => {
    const { state, effects } = run(
      dirtyOn('projects'),
      { input: 'select', tab: otherConst },
      { input: 'leave-answered', leave: true },
    )

    expect(state.activeTab).toBe(otherConst)
    expect([...state.dirty]).toEqual([])
    expect(state.leaving).toBeNull()
    expect(effects).toEqual([])
  })

  it('keeps the tab and its unsaved work when the answer is to stay', () => {
    const { state, effects } = run(
      dirtyOn('projects'),
      { input: 'select', tab: otherConst },
      { input: 'leave-answered', leave: false },
    )

    expect(state.activeTab).toBe('projects')
    expect([...state.dirty]).toEqual(['projects'])
    expect(state.leaving).toBeNull()
    expect(effects).toEqual([])
  })

  it('closes on Escape over a clean tab', () => {
    const { state, effects } = run(ConfigurationModel.initial(), { input: 'escape' })

    expect(effects).toEqual([{ effect: 'close' }])
    expect(state.leaving).toBeNull()
  })

  it('asks on Escape over a tab holding unsaved work instead of closing', () => {
    const { state, effects } = run(dirtyOn('projects'), { input: 'escape' })

    expect(state.leaving).toEqual({ from: 'projects', to: 'close' })
    expect(effects).toEqual([])
  })

  it('closes and drops the unsaved work when the question about closing is answered', () => {
    const { state, effects } = run(
      dirtyOn('projects'),
      { input: 'escape' },
      { input: 'leave-answered', leave: true },
    )

    expect(effects).toEqual([{ effect: 'close' }])
    expect([...state.dirty]).toEqual([])
  })

  // One layer per press: the question is the innermost, so a card behind an open question stays.
  it('takes the question away on Escape before it takes the card', () => {
    const { state, effects } = run(dirtyOn('projects'), { input: 'escape' }, { input: 'escape' })

    expect(state.leaving).toBeNull()
    expect([...state.dirty]).toEqual(['projects'])
    expect(effects).toEqual([])
  })

  it('ignores a group chosen behind an open question', () => {
    const { state } = run(
      dirtyOn('projects'),
      { input: 'escape' },
      { input: 'select', tab: otherConst },
    )

    expect(state.activeTab).toBe('projects')
    expect(state.leaving).toEqual({ from: 'projects', to: 'close' })
  })

  it('forgets a tab that saved what it held', () => {
    const { state } = run(dirtyOn('projects'), { input: 'dirty', tab: 'projects', dirty: false })

    expect([...state.dirty]).toEqual([])
  })

  it('answers nothing when no question is open', () => {
    const { state, effects } = run(dirtyOn('projects'), { input: 'leave-answered', leave: true })

    expect([...state.dirty]).toEqual(['projects'])
    expect(effects).toEqual([])
  })

  it('refuses an input it does not know', () => {
    expect(() => ConfigurationModel.transition(
      ConfigurationModel.initial(),
      { input: 'teleport' } as unknown as ConfigurationInput,
    )).toThrow(/Unknown configuration input/)
  })
})
