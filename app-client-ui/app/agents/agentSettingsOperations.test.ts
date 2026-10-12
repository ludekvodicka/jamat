import { beforeEach, describe, expect, it } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { AgentSettingsValue } from '../../shared/agentSettings'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { AgentSettingsOperations } from './agentSettingsOperations'

describe('app-client-ui/app/agents/agentSettingsOperations', () => {
  const storedConst: AgentSettingsValue = { claude: { yolo: true }, codex: { yolo: false } }
  let answer: ConfigOpResult
  let written: AgentSettingsValue[]
  let stored: AgentSettingsValue
  let changed: number
  let bench: RegistryBench

  beforeEach(() => {
    answer = { ok: true }
    written = []
    stored = storedConst
    changed = 0
    bench = new RegistryBench()
    new AgentSettingsOperations({
      readSection: () => stored,
      saveSection: (_spec: unknown, value: AgentSettingsValue) => {
        written.push(value)
        if (answer.ok) stored = value
        return answer
      },
    } as unknown as ConfigStore, () => { changed += 1 }).register(bench.registry)
  })

  it('reads and writes only its config section', async () => {
    expect(await bench.call('agentSettings.get')).toEqual({ ok: true, value: storedConst })
    const saving: AgentSettingsValue = { claude: { yolo: false }, codex: { yolo: true } }
    expect(await bench.call('agentSettings.save', { value: saving })).toEqual({ ok: true, value: {} })
    expect(written).toEqual([saving])
    expect(changed).toBe(1)
  })

  it('sets one provider auto-compact switch over the latest stored section', async () => {
    stored = {
      claude: { yolo: true, model: 'opus', autoCompactPercent: 90 },
      codex: { yolo: false, effort: 'max', autoCompactEnabled: true },
    }

    expect(await bench.call('agentSettings.setAutoCompact', { agentId: 'claude', enabled: true }))
      .toEqual({ ok: true, value: {} })
    expect(written).toEqual([{
      claude: {
        yolo: true,
        model: 'opus',
        autoCompactPercent: 90,
        autoCompactEnabled: true,
      },
      codex: { yolo: false, effort: 'max', autoCompactEnabled: true },
    }])
    expect(changed).toBe(1)
  })

  it('refuses an agent it does not know before the section is read', async () => {
    expect(await bench.call('agentSettings.setAutoCompact', { agentId: 'gemini', enabled: true }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(written).toEqual([])
  })

  it('returns each section refusal with its own code', async () => {
    for (const code of ['config-latched', 'section-damaged', 'invalid-section'] as const) {
      answer = { ok: false, code, detail: `because ${code}` }
      expect(await bench.call('agentSettings.save', { value: storedConst })).toEqual({
        ok: false,
        error: { code: 'operation-failed', detail: `because ${code}`, data: { sourceCode: code } },
      })
    }
    expect(changed).toBe(0)
  })
})
