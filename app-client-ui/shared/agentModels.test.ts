import { describe, expect, it } from 'vitest'

import { AgentModels, type AgentModelOption } from './agentModels'
import { AgentSettings } from './agentSettings'

describe('app-client-ui/shared/agentModels', () => {
  const agentsConst = ['claude', 'codex'] as const

  function storable(model: string): boolean {
    return AgentSettings.isValid({ claude: { yolo: false, model }, codex: { yolo: false } })
  }

  it('offers both agents something and refuses an agent it does not know', () => {
    for (const agentId of agentsConst)
      expect(AgentModels.optionsFor(agentId).length).toBeGreaterThan(0)
    expect(() => AgentModels.optionsFor('gemini' as 'claude')).toThrow(/Unknown agent/)
  })

  it('offers only ids the settings value would accept', () => {
    // The picker and the validator are two rules over one string, so a list holding a value that
    // `AgentSettings` refuses would offer a choice whose save is then rejected.
    for (const agentId of agentsConst)
      for (const option of AgentModels.optionsFor(agentId))
        expect(storable(option.id), option.id).toBe(true)
  })

  it('names every id once per agent and gives every entry a label', () => {
    for (const agentId of agentsConst) {
      const options = AgentModels.optionsFor(agentId)
      expect(new Set(options.map((option) => option.id)).size).toBe(options.length)
      for (const option of options)
        expect(option.label.length, option.id).toBeGreaterThan(0)
    }
  })

  it('keeps Codex to exact slugs and out of the models nobody chooses', () => {
    // `-m gpt-5.6` answers 400 and the run never starts, so a family name in this list would be a
    // trap rather than a shortcut. `codex-auto-review` answers `visibility: hide`.
    const codex = AgentModels.optionsFor('codex')
    expect(codex.every((option) => option.kind === 'version')).toBe(true)
    expect(codex.some((option) => option.id === 'codex-auto-review')).toBe(false)
    expect(codex.every((option) => option.context > 0)).toBe(true)
  })

  it('carries an alias for every Claude family the picker offers a version of', () => {
    const claude = AgentModels.optionsFor('claude')
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable'])
      expect(claude.find((option) => option.id === alias)?.kind, alias).toBe('alias')
  })

  it('opens the million only on the suffix, and only where the suffix works', () => {
    // The suffix is what a session gets rather than what the model could take, which is the rule
    // `ClaudeContextWindows` reads a transcript by. `haiku[1m]` is measured to answer 400.
    const claude = AgentModels.optionsFor('claude')
    const million = claude.filter((option) => option.id.endsWith('[1m]'))
    expect(million.length).toBeGreaterThan(0)
    for (const option of million) {
      expect(option.context, option.id).toBe(1_000_000)
      const bare = claude.find((other) => other.id === option.id.slice(0, -'[1m]'.length))
      expect(bare?.context, option.id).toBe(200_000)
    }
    for (const option of claude.filter((entry) => !entry.id.endsWith('[1m]')))
      expect(option.context, option.id).toBe(200_000)
    expect(AgentModels.optionOf('claude', 'haiku[1m]')).toBeUndefined()
  })

  it('finds an id exactly or not at all', () => {
    const first = AgentModels.optionsFor('codex')[0] as AgentModelOption
    expect(AgentModels.optionOf('codex', first.id)).toEqual(first)
    expect(AgentModels.optionOf('codex', first.id.toUpperCase())).toBeUndefined()
    expect(AgentModels.optionOf('codex', '')).toBeUndefined()
    expect(AgentModels.optionOf('claude', 'claude-opus-9')).toBeUndefined()
  })

  it('gathers an agent\'s effort levels once each, in the order its models name them', () => {
    expect(AgentModels.effortsFor('claude')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // Only the 5.6 models take `ultra`, and it comes after the levels every model shares.
    expect(AgentModels.effortsFor('codex')).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])
    for (const agentId of agentsConst)
      for (const option of AgentModels.optionsFor(agentId))
        for (const effort of option.efforts)
          expect(AgentModels.effortsFor(agentId), `${option.id} ${effort}`).toContain(effort)
  })

  it('leaves a model that takes no effort with an empty list rather than a guess', () => {
    expect(AgentModels.optionOf('claude', 'haiku')?.efforts).toEqual([])
    expect(AgentModels.optionOf('claude', 'claude-haiku-4-5-20251001')?.efforts).toEqual([])
  })
})
