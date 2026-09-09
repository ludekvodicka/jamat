import { describe, expect, it } from 'vitest'

import { AgentSettings, type AgentSettingsValue } from './agentSettings'

describe('app-client-ui/shared/agentSettings', () => {
  it('reads a missing or unusable section as both agents gated', () => {
    const messages: string[] = []
    const report = (message: string): number => messages.push(message)
    expect(AgentSettings.coerce(undefined, report)).toEqual(AgentSettings.defaultValue())
    expect(messages).toHaveLength(0)
    for (const value of [[], 'yes', null])
      expect(AgentSettings.coerce(value, report)).toEqual({
        claude: { yolo: false },
        codex: { yolo: false },
      })
    expect(messages).toHaveLength(3)
  })

  it('takes each agent on its own and keeps unknown hand-written keys', () => {
    const messages: string[] = []
    const report = (message: string): number => messages.push(message)
    expect(AgentSettings.coerce(
      { claude: { yolo: true }, codex: 'on please', note: 'keep' },
      report,
    )).toEqual({ claude: { yolo: true }, codex: { yolo: false }, note: 'keep' })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('codex')
    expect(AgentSettings.coerce({ claude: { yolo: true, note: 'keep' } }, report))
      .toEqual({ claude: { yolo: true, note: 'keep' }, codex: { yolo: false } })
  })

  it('validates strictly while tolerating extra keys', () => {
    expect(AgentSettings.isValid(AgentSettings.defaultValue())).toBe(true)
    expect(AgentSettings.isValid({ claude: { yolo: true }, codex: { yolo: false }, x: 1 })).toBe(true)
    expect(AgentSettings.isValid({ claude: { yolo: true } })).toBe(false)
    expect(AgentSettings.isValid({ claude: { yolo: 'true' }, codex: { yolo: false } })).toBe(false)
    expect(AgentSettings.isValid([])).toBe(false)
  })

  it('calls only a present, unusable entry damaged', () => {
    expect(AgentSettings.isDamaged(undefined)).toBe(false)
    expect(AgentSettings.isDamaged({})).toBe(false)
    expect(AgentSettings.isDamaged({ claude: { yolo: true } })).toBe(false)
    expect(AgentSettings.isDamaged(AgentSettings.defaultValue())).toBe(false)
    expect(AgentSettings.isDamaged({ claude: 'yes', codex: { yolo: false } })).toBe(true)
    expect(AgentSettings.isDamaged('agents')).toBe(true)
  })

  it('reads and writes one agent without touching the other', () => {
    const value = { claude: { yolo: true }, codex: { yolo: false } }
    expect(AgentSettings.yoloFor(value, 'claude')).toBe(true)
    expect(AgentSettings.yoloFor(value, 'codex')).toBe(false)
    expect(AgentSettings.withYolo(value, 'codex', true))
      .toEqual({ claude: { yolo: true }, codex: { yolo: true } })
    expect(value.codex.yolo).toBe(false)
    expect(() => AgentSettings.yoloFor(value, 'gemini' as never)).toThrow('Unknown agent')
    expect(() => AgentSettings.withYolo(value, 'gemini' as never, true)).toThrow('Unknown agent')
  })

  it('takes a model off any shape a catalog or an alias can produce', () => {
    const messages: string[] = []
    const report = (message: string): number => messages.push(message)
    for (const model of ['fable', 'opus', 'claude-fable-5', 'claude-fable-5[1m]', 'gpt-5.6-sol',
      'gpt-5.4-mini', 'o3', 'claude-opus-4-5-20251101']) {
      expect(AgentSettings.coerce({ claude: { yolo: false, model }, codex: { yolo: false } }, report))
        .toEqual({ claude: { yolo: false, model }, codex: { yolo: false } })
      expect(AgentSettings.isValid({ claude: { yolo: false, model }, codex: { yolo: false } }))
        .toBe(true)
    }
    expect(messages).toHaveLength(0)
  })

  // The whole point of the shape: a stored value must never be readable as a flag by the CLI it is
  // handed to, and must survive the win32 `cmd /d /q /c <agent> ...` wrap without cmd acting on it.
  it('refuses a model that could be read as a flag or acted on by cmd.exe', () => {
    const messages: string[] = []
    const report = (message: string): number => messages.push(message)
    for (const model of ['--dangerously-skip-permissions', '-m', 'gpt 5', '', 'a&b', 'a|b', 'a^b',
      'a>b', '.hidden', 'a"b', "a'b", 7, null, true, ['opus']]) {
      expect(AgentSettings.coerce(
        { claude: { yolo: true, model }, codex: { yolo: false } },
        report,
      )).toEqual({ claude: { yolo: true }, codex: { yolo: false } })
      expect(AgentSettings.isValid({ claude: { yolo: true, model }, codex: { yolo: false } }))
        .toBe(false)
    }
    expect(messages).toHaveLength(15)
    expect(messages[0]).toContain('claude')
    expect(messages[0]).toContain('model')
  })

  // One unusable field must cost only itself. Before this, a mistyped model would also have thrown
  // away a yolo switch its owner set on purpose, and nothing would have said so.
  it('keeps a usable field of an entry whose other field is unusable', () => {
    const messages: string[] = []
    const report = (message: string): number => messages.push(message)
    expect(AgentSettings.coerce(
      { claude: { yolo: true, model: 'not a model' }, codex: { yolo: 'yes', model: 'gpt-5.5' } },
      report,
    )).toEqual({ claude: { yolo: true }, codex: { yolo: false, model: 'gpt-5.5' } })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('claude')
    expect(messages[1]).toContain('codex')
  })

  it('leaves a model out entirely when the entry names none', () => {
    const messages: string[] = []
    const report = (message: string): number => messages.push(message)
    const coerced = AgentSettings.coerce({ claude: { yolo: true }, codex: { yolo: false } }, report)
    expect(coerced).toEqual({ claude: { yolo: true }, codex: { yolo: false } })
    expect('model' in coerced.claude).toBe(false)
    expect(messages).toHaveLength(0)
    expect(AgentSettings.defaultValue().claude.model).toBeUndefined()
  })

  it('calls a present model off the shape damaged, and an absent one not', () => {
    expect(AgentSettings.isDamaged({ claude: { yolo: true }, codex: { yolo: false } })).toBe(false)
    expect(AgentSettings.isDamaged({ claude: { yolo: true, model: 'opus' } })).toBe(false)
    expect(AgentSettings.isDamaged({ claude: { yolo: true, model: '-x' } })).toBe(true)
    expect(AgentSettings.isDamaged({ codex: { yolo: true, model: 7 } })).toBe(true)
  })

  it('reads and writes one agent model without touching the other', () => {
    const value = { claude: { yolo: true, model: 'fable' }, codex: { yolo: false } }
    expect(AgentSettings.modelFor(value, 'claude')).toBe('fable')
    expect(AgentSettings.modelFor(value, 'codex')).toBeUndefined()
    expect(AgentSettings.withModel(value, 'codex', 'gpt-5.6-sol'))
      .toEqual({ claude: { yolo: true, model: 'fable' }, codex: { yolo: false, model: 'gpt-5.6-sol' } })
    expect(value.codex).toEqual({ yolo: false })
    expect(() => AgentSettings.modelFor(value, 'gemini' as never)).toThrow('Unknown agent')
    expect(() => AgentSettings.withModel(value, 'gemini' as never, 'x')).toThrow('Unknown agent')
  })

  // config.json must hold the ABSENCE of an opinion, not a key whose value says there is none.
  it('takes an effort as a bare word, whatever level the CLIs learn next', () => {
    // No union: Codex already knows `ultra` and Claude does not, and an update on either side
    // must not need a code change here to be usable.
    const messages: string[] = []
    const report = (message: string): number => messages.push(message)
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'whateverIsNext']) {
      const value = AgentSettings.coerce(
        { claude: { yolo: false, effort }, codex: { yolo: false } },
        report,
      )
      expect(AgentSettings.effortFor(value, 'claude'), effort).toBe(effort)
    }
    expect(messages).toHaveLength(0)
  })

  it('refuses an effort that could be read as a flag or acted on by cmd.exe', () => {
    const messages: string[] = []
    const report = (message: string): number => messages.push(message)
    for (const effort of ['-x', '', ' high', 'hi gh', 'high&whoami', '1high', 7, null]) {
      const value = AgentSettings.coerce(
        { claude: { yolo: true, effort }, codex: { yolo: false } },
        report,
      )
      expect(AgentSettings.effortFor(value, 'claude'), JSON.stringify(effort)).toBeUndefined()
      // The switch beside it is the point of the per-field read: one unusable value costs
      // only itself.
      expect(value.claude.yolo, JSON.stringify(effort)).toBe(true)
    }
    expect(messages).toHaveLength(8)
    expect(messages[0]).toContain('effort')
  })

  it('holds the effort and the model apart, either standing without the other', () => {
    const base = AgentSettings.defaultValue()
    const effortOnly = AgentSettings.withEffort(base, 'claude', 'high')
    expect(effortOnly.claude).toEqual({ yolo: false, effort: 'high' })
    expect(AgentSettings.modelFor(effortOnly, 'claude')).toBeUndefined()

    const both = AgentSettings.withModel(effortOnly, 'claude', 'opus')
    expect(both.claude).toEqual({ yolo: false, effort: 'high', model: 'opus' })
    expect(AgentSettings.effortFor(both, 'codex')).toBeUndefined()

    const cleared = AgentSettings.withEffort(both, 'claude', undefined)
    expect('effort' in cleared.claude).toBe(false)
    expect(AgentSettings.modelFor(cleared, 'claude')).toBe('opus')
    expect(() => AgentSettings.withEffort(base, 'gemini' as 'claude', 'high'))
      .toThrow(/Unknown agent/)
    expect(() => AgentSettings.effortFor(base, 'gemini' as 'claude')).toThrow(/Unknown agent/)
  })

  it('calls a present effort off the shape damaged, and an absent one not', () => {
    expect(AgentSettings.isDamaged({ claude: { yolo: true }, codex: { yolo: false } })).toBe(false)
    expect(AgentSettings.isDamaged({
      claude: { yolo: true, effort: 'ultra' }, codex: { yolo: false },
    })).toBe(false)
    expect(AgentSettings.isDamaged({
      claude: { yolo: true, effort: '--effort' }, codex: { yolo: false },
    })).toBe(true)
  })

  it('resets the fields this app owns and keeps the keys it does not', () => {
    const value = AgentSettings.coerce(
      {
        claude: { yolo: true, model: 'opus', effort: 'high', note: 'for merge sessions' },
        codex: { yolo: true, model: 'gpt-5.6-sol', effort: 'ultra' },
        future: 'keep',
      },
      () => undefined,
    )
    expect(AgentSettings.resetAgents(value)).toEqual({
      claude: { yolo: false, note: 'for merge sessions' },
      codex: { yolo: false },
      future: 'keep',
    })
  })

  it('resets an entry that already holds the defaults to the same entry', () => {
    const value = AgentSettings.defaultValue()
    expect(AgentSettings.resetAgents(value)).toEqual(value)
    expect(AgentSettings.resetAgents(value)).not.toBe(value)
  })

  it('removes the key when a model is cleared, and leaves yolo standing', () => {
    const value = { claude: { yolo: true, model: 'fable' }, codex: { yolo: true, model: 'gpt-5.5' } }
    const cleared = AgentSettings.withModel(value, 'claude', undefined)
    expect(cleared.claude).toEqual({ yolo: true })
    expect('model' in cleared.claude).toBe(false)
    expect(JSON.stringify(cleared.claude)).toBe('{"yolo":true}')
    expect(cleared.codex).toEqual({ yolo: true, model: 'gpt-5.5' })
    expect(AgentSettings.withModel(cleared, 'claude', undefined).claude).toEqual({ yolo: true })
  })

  it('reads each provider own compaction defaults from an old config without writing keys', () => {
    const value = AgentSettings.coerce(
      { claude: { yolo: true }, codex: { yolo: false } },
      () => undefined,
    )

    expect(AgentSettings.contextCompactionFor(value, 'claude')).toEqual({
      panelPercent: 35,
      autoPercent: 40,
      enabled: false,
    })
    expect(AgentSettings.contextCompactionFor(value, 'codex')).toEqual({
      panelPercent: 60,
      autoPercent: 75,
      enabled: false,
    })
    expect(value.claude).toEqual({ yolo: true })
  })

  it('changes one provider context policy without touching its launch settings or the other agent', () => {
    const base = AgentSettings.withEffort(
      AgentSettings.withModel(AgentSettings.defaultValue(), 'claude', 'opus'),
      'claude',
      'high',
    )
    const panel = AgentSettings.withContextPanelPercent(base, 'claude', 70)
    const automatic = AgentSettings.withAutoCompactPercent(panel, 'claude', 90)
    const enabled = AgentSettings.withAutoCompactEnabled(automatic, 'claude', true)

    expect(AgentSettings.contextCompactionFor(enabled, 'claude')).toEqual({
      panelPercent: 70,
      autoPercent: 90,
      enabled: true,
    })
    expect(enabled.claude).toEqual({
      yolo: false,
      model: 'opus',
      effort: 'high',
      contextPanelPercent: 70,
      autoCompactPercent: 90,
      autoCompactEnabled: true,
    })
    expect(enabled.codex).toEqual({ yolo: false })
  })

  it('refuses invalid context percentages and a panel threshold above auto-compact', () => {
    const valid = { claude: { yolo: false }, codex: { yolo: false } }
    for (const percent of [0, 101, 75.5, NaN, '75']) {
      expect(AgentSettings.isValid({
        ...valid,
        claude: { yolo: false, contextPanelPercent: percent },
      })).toBe(false)
    }
    // A lone panel threshold is measured against THIS agent's own automatic default, so the same
    // 50 stands under Codex and falls under Claude.
    expect(AgentSettings.isValid({
      ...valid,
      claude: { yolo: false, contextPanelPercent: 50 },
    })).toBe(false)
    expect(AgentSettings.isValid({
      ...valid,
      codex: { yolo: false, contextPanelPercent: 50 },
    })).toBe(true)
    expect(AgentSettings.isValid({
      ...valid,
      claude: { yolo: false, contextPanelPercent: 90, autoCompactPercent: 80 },
    })).toBe(false)
    expect(AgentSettings.isValid({
      ...valid,
      claude: { yolo: false, contextPanelPercent: 80, autoCompactPercent: 80 },
    })).toBe(true)
  })

  it('repairs context policy field by field and resets every owned context key', () => {
    const messages: string[] = []
    const value = AgentSettings.coerce({
      claude: {
        yolo: true,
        contextPanelPercent: 30,
        autoCompactPercent: 'high',
        autoCompactEnabled: true,
        note: 'keep',
      },
      codex: {
        yolo: false,
        contextPanelPercent: 90,
        autoCompactPercent: 80,
        autoCompactEnabled: 'yes',
      },
    }, (message) => messages.push(message))

    expect(value.claude).toEqual({
      yolo: true,
      contextPanelPercent: 30,
      autoCompactEnabled: true,
    })
    expect(value.codex).toEqual({ yolo: false })
    expect(messages).toHaveLength(3)
    expect(AgentSettings.resetAgents({
      ...value,
      claude: { ...value.claude, note: 'keep' },
    } as unknown as AgentSettingsValue)).toEqual({
      claude: { yolo: false, note: 'keep' },
      codex: { yolo: false },
    })
  })
})
