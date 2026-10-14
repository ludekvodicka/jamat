import { describe, expect, it } from 'vitest'

import { ScriptDuration } from './scriptDuration'

describe('lib-orchestrator/sessionManager/scripts/scriptDuration', () => {
  it('reads seconds with one decimal, then minutes and seconds, then hours and minutes', () => {
    expect(ScriptDuration.text(23_600)).toBe('23.6 s')
    expect(ScriptDuration.text(0)).toBe('0.0 s')
    expect(ScriptDuration.text(72_000)).toBe('1 min 12 s')
    expect(ScriptDuration.text(3_780_000)).toBe('1 h 3 min')
  })

  it('rounds before choosing the unit, so no 60 is ever printed', () => {
    expect(ScriptDuration.text(59_960)).toBe('1 min 0 s')
    expect(ScriptDuration.text(3_599_600)).toBe('1 h 0 min')
  })

  it('reads a negative span as zero', () => {
    expect(ScriptDuration.text(-5)).toBe('0.0 s')
  })

  it('reads a ticking clock in whole seconds, cut and never rounded', () => {
    expect(ScriptDuration.elapsedText(0)).toBe('0 s')
    expect(ScriptDuration.elapsedText(59_999)).toBe('59 s')
    expect(ScriptDuration.elapsedText(72_000)).toBe('1 min 12 s')
    expect(ScriptDuration.elapsedText(3_780_000)).toBe('1 h 3 min')
    expect(ScriptDuration.elapsedText(-1_500)).toBe('0 s')
  })
})
