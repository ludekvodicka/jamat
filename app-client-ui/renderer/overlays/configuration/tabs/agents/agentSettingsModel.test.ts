import { describe, expect, it } from 'vitest'

import type { AgentSettingsValue } from '../../../../../shared/agentSettings'
import { AgentSettingsModel, type AgentSettingsModelState } from './agentSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/agents/agentSettingsModel', () => {
  const storedConst = { claude: { yolo: false }, codex: { yolo: true } }

  function loaded(): AgentSettingsModelState {
    return AgentSettingsModel.transition(AgentSettingsModel.initial().state, {
      input: 'loaded',
      value: storedConst,
    }).state
  }

  it('asks for the stored value before it can show anything', () => {
    const start = AgentSettingsModel.initial()

    expect(start.state).toEqual({ loaded: null, buffer: null, saving: null, problem: null })
    expect(start.effects).toEqual([{ effect: 'load' }])
    expect(AgentSettingsModel.isModified(start.state)).toBe(false)
  })

  it('moves one agent at a time and leaves the other where it was', () => {
    const flipped = AgentSettingsModel.transition(loaded(), {
      input: 'yolo',
      agentId: 'claude',
      value: true,
    }).state

    expect(flipped.buffer).toEqual({ claude: { yolo: true }, codex: { yolo: true } })
    expect(flipped.loaded).toEqual(storedConst)
    expect(AgentSettingsModel.isModified(flipped)).toBe(true)
  })

  it('reads a flip back to the stored value as unmodified', () => {
    const there = AgentSettingsModel.transition(loaded(), {
      input: 'yolo',
      agentId: 'codex',
      value: false,
    }).state
    const back = AgentSettingsModel.transition(there, {
      input: 'yolo',
      agentId: 'codex',
      value: true,
    }).state

    expect(AgentSettingsModel.isModified(back)).toBe(false)
  })

  it('resets both agents without writing anything', () => {
    const reset = AgentSettingsModel.transition(loaded(), { input: 'reset' })

    expect(reset.state.buffer).toEqual({ claude: { yolo: false }, codex: { yolo: false } })
    expect(reset.effects).toEqual([])
  })

  it('keeps a key written inside an agent while resetting the fields it owns', () => {
    // The read path returns a usable entry as it found it, so a hand-written key reaches the
    // buffer. Reset used to replace the whole entry, and the next save took the key with it.
    const stored = {
      claude: { yolo: true, model: 'opus', note: 'for merge sessions' },
      codex: { yolo: true },
    } as unknown as AgentSettingsValue
    const start = AgentSettingsModel.transition(AgentSettingsModel.initial().state, {
      input: 'loaded',
      value: stored,
    }).state

    const reset = AgentSettingsModel.transition(start, { input: 'reset' }).state

    expect(reset.buffer).toEqual({
      claude: { yolo: false, note: 'for merge sessions' },
      codex: { yolo: false },
    })
  })

  it('saves the buffer once and holds the second ask off until it answers', () => {
    const dirty = AgentSettingsModel.transition(loaded(), {
      input: 'yolo',
      agentId: 'claude',
      value: true,
    }).state
    const saving = AgentSettingsModel.transition(dirty, { input: 'save' })

    expect(saving.effects).toEqual([{ effect: 'save', value: dirty.buffer }])
    expect(AgentSettingsModel.isModified(saving.state)).toBe(false)
    expect(AgentSettingsModel.transition(saving.state, { input: 'save' }).effects).toEqual([])

    const done = AgentSettingsModel.transition(saving.state, { input: 'saved', ok: true }).state
    expect(done.loaded).toEqual(dirty.buffer)
    expect(done.problem).toBeNull()
  })

  it('keeps the buffer and shows why when the save is refused', () => {
    const saving = AgentSettingsModel.transition(
      AgentSettingsModel.transition(loaded(), { input: 'yolo', agentId: 'claude', value: true })
        .state,
      { input: 'save' },
    ).state
    const refused = AgentSettingsModel.transition(saving, {
      input: 'saved',
      ok: false,
      detail: 'section-damaged: repair it by hand',
    }).state

    expect(refused.problem).toBe('section-damaged: repair it by hand')
    expect(refused.buffer).toEqual({ claude: { yolo: true }, codex: { yolo: true } })
    expect(refused.loaded).toEqual(storedConst)
    expect(AgentSettingsModel.isModified(refused)).toBe(true)
  })

  it('refuses an input it does not know', () => {
    expect(() => AgentSettingsModel.transition(loaded(), { input: 'nope' } as never))
      .toThrow('Unknown agent settings input')
  })

  it('edits the context policy of one provider and makes every field part of dirty state', () => {
    const panel = AgentSettingsModel.transition(loaded(), {
      input: 'contextPanelPercent',
      agentId: 'claude',
      value: 70,
    }).state
    const automatic = AgentSettingsModel.transition(panel, {
      input: 'autoCompactPercent',
      agentId: 'claude',
      value: 90,
    }).state
    const enabled = AgentSettingsModel.transition(automatic, {
      input: 'autoCompactEnabled',
      agentId: 'claude',
      value: true,
    }).state

    expect(enabled.buffer).toEqual({
      claude: {
        yolo: false,
        contextPanelPercent: 70,
        autoCompactPercent: 90,
        autoCompactEnabled: true,
      },
      codex: { yolo: true },
    })
    expect(AgentSettingsModel.isModified(enabled)).toBe(true)
    expect(AgentSettingsModel.isModified({ ...enabled, loaded: enabled.buffer })).toBe(false)
  })

  describe('default model', () => {
    const withModelConst = {
      claude: { yolo: false, model: 'opus' },
      codex: { yolo: true, model: 'gpt-5.5' },
    }

    function loadedWith(value: typeof withModelConst): AgentSettingsModelState {
      return AgentSettingsModel.transition(AgentSettingsModel.initial().state, {
        input: 'loaded',
        value,
      }).state
    }

    it('types a model into one agent and leaves the other where it was', () => {
      const typed = AgentSettingsModel.transition(loaded(), {
        input: 'model',
        agentId: 'claude',
        value: 'claude-fable-5',
      }).state

      expect(typed.buffer).toEqual({
        claude: { yolo: false, model: 'claude-fable-5' },
        codex: { yolo: true },
      })
      expect(typed.loaded).toEqual(storedConst)
      expect(AgentSettingsModel.isModified(typed)).toBe(true)
    })

    // Save would have stayed grey without the model in the comparison, which is the whole point.
    it('reports itself modified by a model and unmodified again on the way back', () => {
      const typed = AgentSettingsModel.transition(loadedWith(withModelConst), {
        input: 'model',
        agentId: 'codex',
        value: 'gpt-5.6-sol',
      }).state
      expect(AgentSettingsModel.isModified(typed)).toBe(true)

      const back = AgentSettingsModel.transition(typed, {
        input: 'model',
        agentId: 'codex',
        value: 'gpt-5.5',
      }).state
      expect(AgentSettingsModel.isModified(back)).toBe(false)
    })

    // An empty field is the absence of an opinion, and config.json must hold no key for it at all.
    it('clears a stored model to an absence rather than to an empty string', () => {
      const cleared = AgentSettingsModel.transition(loadedWith(withModelConst), {
        input: 'model',
        agentId: 'claude',
        value: '   ',
      }).state

      expect(cleared.buffer?.claude).toEqual({ yolo: false })
      expect('model' in (cleared.buffer?.claude ?? {})).toBe(false)
      expect(AgentSettingsModel.isModified(cleared)).toBe(true)

      const saved = AgentSettingsModel.transition(cleared, { input: 'save' })
      expect(saved.effects).toEqual([{ effect: 'save', value: cleared.buffer }])
    })

    // Typing is never fought: a value off the shape reaches the section, which refuses it by name.
    it('keeps an unusable value exactly as typed and offers it to the save', () => {
      const typed = AgentSettingsModel.transition(loaded(), {
        input: 'model',
        agentId: 'claude',
        value: 'gpt 5',
      }).state
      expect(typed.buffer?.claude.model).toBe('gpt 5')

      const refused = AgentSettingsModel.transition(
        AgentSettingsModel.transition(typed, { input: 'save' }).state,
        { input: 'saved', ok: false, detail: 'agents must hold ...' },
      ).state
      expect(refused.problem).toBe('agents must hold ...')
      expect(refused.buffer?.claude.model).toBe('gpt 5')
    })

    it('drops the model along with the switch when reset says default', () => {
      const reset = AgentSettingsModel.transition(loadedWith(withModelConst), { input: 'reset' })
        .state

      expect(reset.buffer).toEqual({ claude: { yolo: false }, codex: { yolo: false } })
      expect(AgentSettingsModel.isModified(reset)).toBe(true)
    })

    it('ignores a model typed before the stored value has arrived', () => {
      const early = AgentSettingsModel.transition(AgentSettingsModel.initial().state, {
        input: 'model',
        agentId: 'claude',
        value: 'opus',
      })

      expect(early.state.buffer).toBeNull()
      expect(early.effects).toEqual([])
    })
  })
})
