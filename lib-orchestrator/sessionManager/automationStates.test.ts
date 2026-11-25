import { describe, expect, it } from 'vitest'
import { AutomationStates } from './automationStates'

describe('AutomationStates', () => {
  it('knows exactly the four states', () => {
    expect(AutomationStates.allConst).toEqual(['working', 'waiting', 'blocked', 'completed'])
    for (const state of AutomationStates.allConst) expect(AutomationStates.isState(state)).toBe(true)
    for (const value of ['paused', '', null, undefined, 3, 'Waiting'])
      expect(AutomationStates.isState(value)).toBe(false)
  })

  it('reads an unknown value as absent', () => {
    expect(AutomationStates.readOf('blocked')).toBe('blocked')
    expect(AutomationStates.readOf('paused')).toBeUndefined()
    expect(AutomationStates.readOf(undefined)).toBeUndefined()
  })

  it('knows the four former section ids and nothing else', () => {
    for (const id of ['automation', 'waiting', 'blocked', 'completed'])
      expect(AutomationStates.isFormerSectionId(id)).toBe(true)
    for (const id of ['priority', 'pinned', 'none', 'working', 'Waiting'])
      expect(AutomationStates.isFormerSectionId(id)).toBe(false)
  })
})
