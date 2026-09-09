import {
  AgentSettings,
  type AgentSettingsAgentId,
  type AgentSettingsValue,
} from '../../../../../shared/agentSettings'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
  type SettingsCardStep,
} from '../../settingsCard'

export type AgentSettingsModelState = SettingsCardState<AgentSettingsValue>

export type AgentSettingsInput =
  | SettingsCardInput<AgentSettingsValue>
  | { input: 'yolo'; agentId: AgentSettingsAgentId; value: boolean }
  | { input: 'model'; agentId: AgentSettingsAgentId; value: string }
  | { input: 'effort'; agentId: AgentSettingsAgentId; value: string }
  | { input: 'contextPanelPercent'; agentId: AgentSettingsAgentId; value: number }
  | { input: 'autoCompactPercent'; agentId: AgentSettingsAgentId; value: number }
  | { input: 'autoCompactEnabled'; agentId: AgentSettingsAgentId; value: boolean }

export type AgentSettingsEffect = SettingsCardEffect<AgentSettingsValue>

export type AgentSettingsStep = SettingsCardStep<AgentSettingsValue, AgentSettingsEffect>

/**
 * The agents tab as data: provider controls and the machine every settings card shares.
 *
 * Reset is `AgentSettings.resetAgents` rather than a spread, and that is load-bearing: spreading the
 * defaults at the TOP level left foreign keys beside `claude` and `codex` standing while anything
 * written INSIDE one of them went with the next save. The shape's owner knows its own fields.
 */
export class AgentSettingsModel {
  static initial(): AgentSettingsStep {
    return SettingsCard.initial()
  }

  static isModified(state: AgentSettingsModelState): boolean {
    return SettingsCard.isModified(state, (loaded, buffer) =>
      loaded.claude.yolo === buffer.claude.yolo
      && loaded.codex.yolo === buffer.codex.yolo
      && loaded.claude.model === buffer.claude.model
      && loaded.codex.model === buffer.codex.model
      && loaded.claude.effort === buffer.claude.effort
      && loaded.codex.effort === buffer.codex.effort
      && loaded.claude.contextPanelPercent === buffer.claude.contextPanelPercent
      && loaded.codex.contextPanelPercent === buffer.codex.contextPanelPercent
      && loaded.claude.autoCompactPercent === buffer.claude.autoCompactPercent
      && loaded.codex.autoCompactPercent === buffer.codex.autoCompactPercent
      && loaded.claude.autoCompactEnabled === buffer.claude.autoCompactEnabled
      && loaded.codex.autoCompactEnabled === buffer.codex.autoCompactEnabled)
  }

  static transition(
    state: AgentSettingsModelState,
    input: AgentSettingsInput,
  ): AgentSettingsStep {
    const shared = SettingsCard.transition<AgentSettingsValue, AgentSettingsEffect>(
      state,
      input,
      (buffer) => AgentSettings.resetAgents(buffer),
    )
    if (shared !== null) return shared
    if (input.input === 'yolo')
      return AgentSettingsModel.edited(state, (buffer) =>
        AgentSettings.withYolo(buffer, input.agentId, input.value))
    else if (input.input === 'model')
      // An empty field is the ABSENCE of an opinion rather than an empty model, so the key goes out
      // of config.json entirely. What is typed is otherwise kept exactly as typed: a value off the
      // shape is refused by the section with its own message at save, which says more than a field
      // that silently eats keystrokes.
      return AgentSettingsModel.edited(state, (buffer) => AgentSettings.withModel(
        buffer,
        input.agentId,
        input.value.trim() === '' ? undefined : input.value,
      ))
    else if (input.input === 'effort')
      // The empty option of the select is the ABSENCE of an opinion, exactly as an empty model
      // field is, so it takes the key out of config.json rather than storing a blank.
      return AgentSettingsModel.edited(state, (buffer) => AgentSettings.withEffort(
        buffer,
        input.agentId,
        input.value === '' ? undefined : input.value,
      ))
    else if (input.input === 'contextPanelPercent')
      return AgentSettingsModel.edited(state, (buffer) =>
        AgentSettings.withContextPanelPercent(buffer, input.agentId, input.value))
    else if (input.input === 'autoCompactPercent')
      return AgentSettingsModel.edited(state, (buffer) =>
        AgentSettings.withAutoCompactPercent(buffer, input.agentId, input.value))
    else if (input.input === 'autoCompactEnabled')
      return AgentSettingsModel.edited(state, (buffer) =>
        AgentSettings.withAutoCompactEnabled(buffer, input.agentId, input.value))
    else
      throw new Error(`Unknown agent settings input: ${JSON.stringify(input)}`)
  }

  private static edited(
    state: AgentSettingsModelState,
    change: (buffer: AgentSettingsValue) => AgentSettingsValue,
  ): AgentSettingsStep {
    const buffer = state.buffer
    if (buffer === null) return SettingsCard.step(state)
    return SettingsCard.step({ ...state, buffer: change(buffer) })
  }
}
