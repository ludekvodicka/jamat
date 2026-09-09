import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import {
  AgentSettings,
  type AgentSettingsAgentId,
  type AgentSettingsSaveResult,
  type AgentSettingsValue,
} from '../../shared/agentSettings'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { AgentSettingsSection } from './agentSettingsSection'

export class ServiceAgentSettingsIpc extends ServiceIpcBase<
  typeof ServiceAgentSettingsIpc.channelsConst
> {
  static readonly channelsConst = {
    'agents:settings-get': true,
    'agents:settings-save': true,
    'agents:auto-compact-set': true,
  } as const

  constructor(
    private readonly configStore: ConfigStore,
    private readonly onChanged: () => void,
  ) {
    super()
  }

  initialize(): void {
    this.register(
      'agents:settings-get',
      () => this.configStore.readSection(AgentSettingsSection.spec),
    )
    this.register('agents:settings-save', (_event, value) => this.save(value))
    this.register('agents:auto-compact-set', (_event, agentId, enabled) =>
      this.setAutoCompact(agentId, enabled))
    this.assertComplete(ServiceAgentSettingsIpc.channelsConst)
  }

  private setAutoCompact(
    agentId: AgentSettingsAgentId,
    enabled: boolean,
  ): AgentSettingsSaveResult {
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
