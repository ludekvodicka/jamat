import { z } from 'zod'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import {
  AgentSettings,
  type AgentSettingsAgentId,
  type AgentSettingsSaveResult,
  type AgentSettingsValue,
} from '../../shared/agentSettings'
import type { AppOperationMap } from '../../shared/appOperationMap'
import { AgentSettingsSection } from './agentSettingsSection'

/** How each agent is started: its model, its effort, whether it runs unasked, and the auto-compact. */
export class AgentSettingsOperations {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly onChanged: () => void,
  ) {}

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('agentSettings.get', {
      kind: 'read',
      description: 'The agents section: model, effort, yolo and auto-compact per agent.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.configStore.readSection(AgentSettingsSection.spec) }),
    })
    op('agentSettings.save', {
      kind: 'write',
      description: 'Replace the agents section; the section refuses a value it cannot store, naming the field.',
      input: z.strictObject({ value: RemoteControlZod.ownedObject<AgentSettingsValue>() }),
      run: async (body) => RemoteControlOutcome.of(this.save(body.value)),
    })
    op('agentSettings.setAutoCompact', {
      kind: 'write',
      description: "Turn one agent's automatic compaction on or off, leaving every other setting as it is.",
      input: z.strictObject({
        agentId: z.enum(['claude', 'codex'], { error: 'agentId must be claude or codex' }),
        enabled: RemoteControlZod.boolean(),
      }),
      run: async (body) => RemoteControlOutcome.of(this.setAutoCompact(body.agentId, body.enabled)),
    })
  }

  private setAutoCompact(agentId: AgentSettingsAgentId, enabled: boolean): AgentSettingsSaveResult {
    const current = this.configStore.readSection(AgentSettingsSection.spec)
    return this.save(AgentSettings.withAutoCompactEnabled(current, agentId, enabled))
  }

  private save(value: AgentSettingsValue): AgentSettingsSaveResult {
    const saved = this.configStore.saveSection(AgentSettingsSection.spec, value)
    if (saved.ok) {
      this.onChanged()
      return saved
    }
    else if (saved.code === 'config-latched' || saved.code === 'section-damaged'
      || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected agents section save result: ${JSON.stringify(saved)}`)
  }
}
