import { describe, expect, it } from 'vitest'
import { SessionsFilterState } from './sessionsFilterState'

describe('app-client-ui/shared/sessionsFilterState', () => {
  const saved = { id: 'one', name: 'Work', filterText: '', filters: SessionsFilterState.allConst }

  it('defaults to unfinished sessions and replaces that broad choice when selecting a specific state', () => {
    expect(SessionsFilterState.defaultConst).toEqual({ colors: [], agents: [], states: ['active'] })
    expect(SessionsFilterState.toggleState(['active'], 'question')).toEqual(['question'])
    expect(SessionsFilterState.toggleState(['question'], 'running')).toEqual(['question', 'running'])
    expect(SessionsFilterState.toggleState(['question', 'running'], 'active')).toEqual(['active'])
    expect(SessionsFilterState.toggleState(['active'], 'active')).toEqual([])
  })

  it('accepts an empty selection as All and rejects unknown colors, states, agents and duplicate entries', () => {
    expect(SessionsFilterState.isAll(SessionsFilterState.allConst, '')).toBe(true)
    expect(SessionsFilterState.isAll(SessionsFilterState.allConst, 'work')).toBe(false)
    for (const filters of [
      { colors: ['red', null], states: ['running', 'question'], agents: ['claude', null] },
      SessionsFilterState.allConst,
    ]) expect(SessionsFilterState.isValid(filters)).toBe(true)
    for (const filters of [null, {},
      { ...saved.filters, colors: ['purple'] },
      { ...saved.filters, states: ['working'] },
      { ...saved.filters, agents: ['other'] },
      { ...saved.filters, colors: ['red', 'red'] },
    ]) expect(SessionsFilterState.isValid(filters)).toBe(false)
  })

  it('reads a preset without the bot state dimension as one with none selected', () => {
    const older = { colors: ['red'], states: ['active'], agents: [] } as const
    expect(SessionsFilterState.isValid(older)).toBe(true)
    expect(SessionsFilterState.equal(older, { ...older, automation: [] })).toBe(true)
    expect(SessionsFilterState.isAll({ ...SessionsFilterState.allConst }, '')).toBe(true)
    expect(SessionsFilterState.isAll({ ...SessionsFilterState.allConst, automation: ['waiting'] }, '')).toBe(false)
    expect(SessionsFilterState.isValid({ ...older, automation: ['waiting', 'none'] })).toBe(true)
    expect(SessionsFilterState.isValid({ ...older, automation: ['paused'] })).toBe(false)
    expect(SessionsFilterState.isValid({ ...older, automation: ['waiting', 'waiting'] })).toBe(false)
    expect(SessionsFilterState.isSavedList([{ ...saved, filters: { ...older, automation: ['paused'] } }])).toBe(false)
  })

  it('hides done by narrowing only the bot state, also over the Active filter', () => {
    expect(SessionsFilterState.hideDone(SessionsFilterState.defaultConst))
      .toEqual({ colors: [], agents: [], states: ['active'], automation: ['working', 'waiting', 'blocked', 'none'] })
    const narrowed = { colors: ['red' as const], states: ['question' as const], agents: ['codex' as const] }
    expect(SessionsFilterState.hideDone(narrowed)).toMatchObject(narrowed)
  })

  it('round-trips a preset with the bot state through the saved list', () => {
    const value = [{ ...saved, filters: { ...SessionsFilterState.allConst, automation: ['blocked', 'none'] as const } }]
    const restored = SessionsFilterState.coerceSaved(JSON.parse(JSON.stringify(value)), () => { throw new Error('refused') })
    expect(restored).toEqual(value)
  })

  it('refuses empty, reserved or duplicate names and duplicate ids without changing stored values', () => {
    expect(SessionsFilterState.isSavedList([saved])).toBe(true)
    for (const values of [null, [saved, saved], [{ ...saved, name: '' }], [{ ...saved, name: 'All' }],
      [saved, { ...saved, id: 'two', name: 'WORK' }], [{ ...saved, filterText: 42 }],
    ]) expect(SessionsFilterState.isSavedList(values)).toBe(false)
    const reports: string[] = []
    expect(SessionsFilterState.coerceSaved(undefined, (message) => reports.push(message))).toEqual([])
    expect(reports).toEqual([])
    expect(SessionsFilterState.coerceSaved([null], (message) => reports.push(message))).toEqual([])
    expect(reports).toHaveLength(1)
  })
})
