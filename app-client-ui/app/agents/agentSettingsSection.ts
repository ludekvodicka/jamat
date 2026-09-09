import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import { AgentSettings, type AgentSettingsValue } from '../../shared/agentSettings'

export class AgentSettingsSection {
  static readonly spec: ConfigSectionSpec<AgentSettingsValue> = {
    key: 'agents',
    coerce: (value, report) => AgentSettings.coerce(value, report),
    // `fileChanges` leaves this out because its fallback IS the right reading of whatever it finds.
    // Here it is not: a hand edit that names an agent and gets its shape wrong would be replaced by
    // the coerced `yolo: false`, and nobody could tell afterwards that it had been written at all.
    damaged: (value) => AgentSettings.isDamaged(value),
    validate: (value) => AgentSettings.isValid(value)
      ? null
      : 'agents must hold { claude: { yolo: boolean, model?: string, effort?: string }, '
        + 'codex: the same }',
  }
}
