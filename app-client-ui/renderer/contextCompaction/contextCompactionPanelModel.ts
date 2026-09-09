import type {
  SessionAgentId,
  SessionInfo,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AgentSettings, type AgentSettingsValue } from '../../shared/agentSettings'
import { SessionContextUsage } from '../sessionModel/sessionContextUsage'
import type { SessionModelHeld } from '../sessionModel/sessionModelStore'

export interface ContextCompactionPanelValue {
  agentId: SessionAgentId
  agentLabel: string
  percent: number
  contextTokens: number
  contextWindow: number
  autoCompactPercent: number
  autoCompactEnabled: boolean
  message: string
}

export class ContextCompactionPanelModel {
  static of(
    session: SessionInfo | null,
    reading: SessionModelHeld | null,
    settings: AgentSettingsValue | null,
    now = Date.now(),
  ): ContextCompactionPanelValue | null {
    if (session === null || session.kind !== 'agent' || session.life !== 'live') return null
    if (session.agent === undefined || reading === null || settings === null) return null
    if (SessionContextUsage.isStale(now - reading.readAt)) return null
    const percent = SessionContextUsage.percentOf(reading.info)
    if (percent === null || reading.info.contextWindow === null) return null
    const configured = AgentSettings.contextCompactionFor(settings, session.agent.agentId)
    if (percent < configured.panelPercent) return null
    const contextTokens = reading.info.contextTokens
    const contextWindow = reading.info.contextWindow
    return {
      agentId: session.agent.agentId,
      agentLabel: ContextCompactionPanelModel.agentLabel(session.agent.agentId),
      percent,
      contextTokens,
      contextWindow,
      autoCompactPercent: configured.autoPercent,
      autoCompactEnabled: configured.enabled,
      message: `Context is at ${percent}%: ${SessionContextUsage.exactTokens(contextTokens)} of `
        + `${SessionContextUsage.exactTokens(contextWindow)} tokens. Compact is recommended.`,
    }
  }

  private static agentLabel(agentId: SessionAgentId): string {
    if (agentId === 'claude') return 'Claude'
    else if (agentId === 'codex') return 'Codex'
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }
}
