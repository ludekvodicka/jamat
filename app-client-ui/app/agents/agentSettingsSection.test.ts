import { describe, expect, it } from 'vitest'

import { AgentSettings } from '../../shared/agentSettings'
import { AgentSettingsSection } from './agentSettingsSection'

describe('app-client-ui/app/agents/agentSettingsSection', () => {
  it('owns agents and accepts exactly the shared model', () => {
    expect(AgentSettingsSection.spec.key).toBe('agents')
    expect(AgentSettingsSection.spec.validate(AgentSettings.defaultValue())).toBeNull()
    expect(AgentSettingsSection.spec.validate({ claude: { yolo: true } } as never))
      .toContain('codex')
  })

  it('latches its own save over a present hand edit it cannot read, and over nothing else', () => {
    expect(AgentSettingsSection.spec.damaged?.(undefined)).toBe(false)
    expect(AgentSettingsSection.spec.damaged?.({ claude: { yolo: true } })).toBe(false)
    expect(AgentSettingsSection.spec.damaged?.({ claude: 7 })).toBe(true)
  })

  it('names the model in the refusal a caller gets for an offered value it cannot store', () => {
    const refusal = AgentSettingsSection.spec.validate(
      { claude: { yolo: true, model: '--model' }, codex: { yolo: false } } as never,
    )
    expect(refusal).toContain('model')
    expect(AgentSettingsSection.spec.validate(
      { claude: { yolo: true, model: 'claude-fable-5[1m]' }, codex: { yolo: false, model: 'o3' } },
    )).toBeNull()
  })

  it('names the effort in the refusal and latches a hand-written one it cannot read', () => {
    const refusal = AgentSettingsSection.spec.validate?.(
      { claude: { yolo: true, effort: '--effort' }, codex: { yolo: false } } as never,
    )
    expect(refusal).toContain('effort')
    expect(AgentSettingsSection.spec.validate?.(
      { claude: { yolo: true, effort: 'ultra' }, codex: { yolo: false, effort: 'max' } },
    )).toBeNull()
    expect(AgentSettingsSection.spec.damaged?.(
      { claude: { yolo: true, effort: 'hi gh' } },
    )).toBe(true)
  })

  it('latches its own save over a hand-written model it cannot read', () => {
    expect(AgentSettingsSection.spec.damaged?.({ claude: { yolo: true, model: 'opus' } })).toBe(false)
    expect(AgentSettingsSection.spec.damaged?.({ claude: { yolo: true, model: 'rm -rf' } })).toBe(true)
  })
})
