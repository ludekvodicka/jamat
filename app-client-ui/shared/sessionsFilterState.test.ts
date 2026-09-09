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
