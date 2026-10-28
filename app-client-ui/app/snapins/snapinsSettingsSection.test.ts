import { describe, expect, it, vi } from 'vitest'
import { SnapinsSettingsSection } from './snapinsSettingsSection'

describe('SnapinsSettingsSection', () => {
  const spec = SnapinsSettingsSection.spec
  it('defaults absent state and preserves unknown kind maps', () => {
    expect(spec.coerce(undefined, vi.fn())).toEqual({ limit: 4, agents: ['claude'], workerPrompts: {}, kinds: {} })
    expect(spec.coerce({ kinds: { future: { choice: 'x' } } }, vi.fn()).kinds).toEqual({ future: { choice: 'x' } })
  })
  it('is total on malformed input', () => {
    for (const value of [null, 1, [], { agents: ['other'] }, { limit: 0 }])
      expect(() => spec.coerce(value, vi.fn())).not.toThrow()
  })
  it('validates limits, unique agents and nonblank prompts', () => {
    const defaults = spec.coerce(undefined, vi.fn())
    for (const limit of [0, 33]) expect(spec.validate({ ...defaults, limit })).not.toBeNull()
    expect(spec.validate({ ...defaults, agents: ['claude', 'claude'] })).not.toBeNull()
    expect(spec.validate({ ...defaults, workerPrompts: { claude: 'work' } })).toContain('claude')
    expect(spec.validate({ ...defaults, workerPrompts: { claude: ' ' } })).toBeNull()
    expect(spec.validate({ ...defaults, workerPrompts: { codex: 'work {pass}' } })).toBeNull()
  })

  it('reports and removes unusable hand-edited prompts and built-in maps, preserving unknown kinds', () => {
    const report = vi.fn()
    const settings = spec.coerce({ workerPrompts: { claude: 'work', codex: 'work {pass}' },
      kinds: { 'review-todos': { modes: { project: 'other' } }, future: { value: 'kept' } } }, report)
    expect(settings.workerPrompts).toEqual({ codex: 'work {pass}' })
    expect(settings.kinds).toEqual({ future: { value: 'kept' } })
    expect(report).toHaveBeenCalledTimes(2)
    expect(spec.validate(settings)).toBeNull()
  })
})
