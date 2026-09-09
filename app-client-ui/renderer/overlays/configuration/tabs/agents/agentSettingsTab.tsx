import { useEffect, useId, useRef, useState } from 'react'

import { AgentModels } from '../../../../../shared/agentModels'
import {
  AgentSettings,
  type AgentContextCompactionSettings,
  type AgentSettingsAgentId,
} from '../../../../../shared/agentSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './agentSettings.css'
import { AgentSettingsEffects, type AgentSettingsPorts } from './agentSettingsEffects'
import { AgentSettingsModel, type AgentSettingsModelState } from './agentSettingsModel'

export function AgentSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => AgentSettingsModel.initial())
  const [state, setState] = useState<AgentSettingsModelState>(start.state)
  const [activeAgentId, setActiveAgentId] = useState<AgentSettingsAgentId>('claude')
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const claudeId = useId()
  const codexId = useId()
  const claudeModelId = useId()
  const codexModelId = useId()
  // One list per agent: the two offer different models, and a shared id would give Codex
  // Claude's suggestions.
  const claudeModelListId = useId()
  const codexModelListId = useId()
  const claudeEffortId = useId()
  const codexEffortId = useId()
  const claudeContextPanelId = useId()
  const codexContextPanelId = useId()
  const claudeAutoCompactId = useId()
  const codexAutoCompactId = useId()
  const claudeAutoCompactEnabledId = useId()
  const codexAutoCompactEnabledId = useId()
  const claudeTabId = useId()
  const codexTabId = useId()
  const claudePanelId = useId()
  const codexPanelId = useId()
  const [ports] = useState<AgentSettingsPorts>(() => {
    const self: AgentSettingsPorts = {
      dispatch: (input) => {
        const step = AgentSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        const modified = AgentSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void AgentSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void AgentSettingsEffects.run(effect, ports)
  }, [ports, start.effects])

  const saving = state.saving !== null
  const row = (
    controlId: string,
    agentId: AgentSettingsAgentId,
    label: string,
    checked: boolean,
  ): React.JSX.Element => (
    <div className="jamat-configuration-agents__row">
      <div className="jamat-configuration-agents__heading">
        <label htmlFor={controlId}>{label} - run in yolo mode</label>
        <span>Started from Jamat, {label} asks for nothing and may do anything you may.</span>
      </div>
      <input
        id={controlId}
        type="checkbox"
        disabled={state.buffer === null || saving}
        checked={checked}
        onChange={(event) => ports.dispatch({
          input: 'yolo',
          agentId,
          value: event.currentTarget.checked,
        })}
      />
    </div>
  )

  // `200k` and `1M` rather than a localised group separator: the same number has to read the
  // same on every machine, and this line is a label rather than a measurement.
  const contextLabel = (tokens: number): string =>
    tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1_000}k`

  const effortRow = (
    controlId: string,
    agentId: AgentSettingsAgentId,
    label: string,
    model: string,
    effort: string,
  ): React.JSX.Element => {
    // The levels of the model that was chosen, or the agent's own set when none was. Codex ends
    // the run with a 400 on a level its model does not take, so this is not decoration.
    const selected = AgentModels.optionOf(agentId, model)
    const levels = selected === undefined ? AgentModels.effortsFor(agentId) : selected.efforts
    return (
      <div className="jamat-configuration-agents__row">
        <div className="jamat-configuration-agents__heading">
          <label htmlFor={controlId}>{label} - default effort</label>
          <span>{levels.length === 0
            ? `${selected?.label ?? label} takes no effort level.`
            : 'How hard the agent thinks before it answers.'}</span>
        </div>
        <select
          id={controlId}
          className="jamat-configuration-agents__effort"
          disabled={state.buffer === null || saving || levels.length === 0}
          value={effort}
          onChange={(event) => ports.dispatch({
            input: 'effort',
            agentId,
            value: event.currentTarget.value,
          })}
        >
          <option value="">agent&apos;s own default</option>
          {levels.map((level) => <option key={level} value={level}>{level}</option>)}
          {/*
            * A stored level the chosen model does not offer stays visible, or the select would
            * silently read as the agent's default while config.json still held the value.
            */}
          {effort !== '' && !levels.includes(effort) && (
            <option value={effort}>{effort} (not offered by this model)</option>
          )}
        </select>
      </div>
    )
  }

  const modelRow = (
    controlId: string,
    listId: string,
    agentId: AgentSettingsAgentId,
    label: string,
    model: string,
  ): React.JSX.Element => {
    // Data, not state: the list is a constant in this package, so there is nothing to load,
    // nothing to fail and nothing the dirty protocol has to know about.
    const selected = AgentModels.optionOf(agentId, model)
    return (
      <>
        <div className="jamat-configuration-agents__row">
          <div className="jamat-configuration-agents__heading">
            <label htmlFor={controlId}>{label} - default model</label>
            <span>Left empty, {label} starts on its own default.</span>
          </div>
          <input
            id={controlId}
            className="jamat-configuration-agents__model"
            type="text"
            list={listId}
            spellCheck={false}
            autoComplete="off"
            placeholder="agent's own default"
            disabled={state.buffer === null || saving}
            value={model}
            onChange={(event) => ports.dispatch({
              input: 'model',
              agentId,
              value: event.currentTarget.value,
            })}
          />
          <datalist id={listId}>
            {AgentModels.optionsFor(agentId).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </datalist>
        </div>
        {selected !== undefined && (
          <p className="jamat-configuration-agents__model-detail">
            {contextLabel(selected.context)} context
            {selected.efforts.length > 0 && ` · effort: ${selected.efforts.join(', ')}`}
            {selected.note !== undefined && ` · ${selected.note}`}
          </p>
        )}
      </>
    )
  }

  const contextCompactionRows = (
    panelControlId: string,
    autoControlId: string,
    enabledControlId: string,
    agentId: AgentSettingsAgentId,
    label: string,
    settings: AgentContextCompactionSettings,
  ): React.JSX.Element => (
    <>
      <div className="jamat-configuration-agents__row">
        <div className="jamat-configuration-agents__heading">
          <label htmlFor={panelControlId}>{label} - show context panel at</label>
          <span>The warning covers the top of every local {label} terminal at this usage.</span>
        </div>
        <span className="jamat-configuration-agents__percent">
          <input
            id={panelControlId}
            type="number"
            min={1}
            max={100}
            step={1}
            disabled={state.buffer === null || saving}
            value={settings.panelPercent}
            onChange={(event) => ports.dispatch({
              input: 'contextPanelPercent',
              agentId,
              value: Number(event.currentTarget.value),
            })}
          />
          <span>%</span>
        </span>
      </div>
      <div className="jamat-configuration-agents__row">
        <div className="jamat-configuration-agents__heading">
          <label htmlFor={autoControlId}>{label} - auto-compact at</label>
          <span>Must be at or above the context panel threshold.</span>
        </div>
        <span className="jamat-configuration-agents__percent">
          <input
            id={autoControlId}
            type="number"
            min={1}
            max={100}
            step={1}
            disabled={state.buffer === null || saving}
            value={settings.autoPercent}
            onChange={(event) => ports.dispatch({
              input: 'autoCompactPercent',
              agentId,
              value: Number(event.currentTarget.value),
            })}
          />
          <span>%</span>
        </span>
      </div>
      <div className="jamat-configuration-agents__row">
        <div className="jamat-configuration-agents__heading">
          <label htmlFor={enabledControlId}>{label} - enable auto-compact</label>
          <span>After a working turn becomes idle, Jamat checks fresh context and runs /compact.</span>
        </div>
        <input
          id={enabledControlId}
          type="checkbox"
          disabled={state.buffer === null || saving}
          checked={settings.enabled}
          onChange={(event) => ports.dispatch({
            input: 'autoCompactEnabled',
            agentId,
            value: event.currentTarget.checked,
          })}
        />
      </div>
    </>
  )

  const values = state.buffer ?? AgentSettings.defaultValue()
  const providers = {
    claude: {
      agentId: 'claude' as const,
      label: 'Claude',
      tabId: claudeTabId,
      panelId: claudePanelId,
      yoloId: claudeId,
      modelId: claudeModelId,
      modelListId: claudeModelListId,
      effortId: claudeEffortId,
      contextPanelId: claudeContextPanelId,
      autoCompactId: claudeAutoCompactId,
      autoCompactEnabledId: claudeAutoCompactEnabledId,
      value: values.claude,
      contextCompaction: AgentSettings.contextCompactionFor(values, 'claude'),
      modelSyntax: (
        <>Claude also accepts aliases, so <code>opus</code> always means the newest Opus.</>
      ),
      effortRule: 'The effort follows the model and reaches the same new sessions.',
      specialNote: (
        <>
          Claude also shows a Bypass Permissions warning on every launch. To skip it, set
          {' '}<code>&quot;skipDangerousModePermissionPrompt&quot;: true</code> in your own
          {' '}<code>~/.claude/settings.json</code>. Jamat does not write to that file.
        </>
      ),
    },
    codex: {
      agentId: 'codex' as const,
      label: 'Codex',
      tabId: codexTabId,
      panelId: codexPanelId,
      yoloId: codexId,
      modelId: codexModelId,
      modelListId: codexModelListId,
      effortId: codexEffortId,
      contextPanelId: codexContextPanelId,
      autoCompactId: codexAutoCompactId,
      autoCompactEnabledId: codexAutoCompactEnabledId,
      value: values.codex,
      contextCompaction: AgentSettings.contextCompactionFor(values, 'codex'),
      modelSyntax: <>Codex takes exact model ids.</>,
      effortRule: 'Codex refuses an effort level its model does not support.',
      specialNote: null,
    },
  }
  const providerTabs = [providers.claude, providers.codex]

  return (
    <div className="jamat-configuration-agents">
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}
      {state.buffer === null && (
        <p className="jamat-configuration-agents__note">Reading config.json…</p>
      )}
      <div className="jamat-configuration-agents__tabs" role="tablist" aria-label="AI agent providers">
        {providerTabs.map((provider) => (
          <button
            key={provider.agentId}
            id={provider.tabId}
            className="jamat-configuration-agents__tab"
            type="button"
            role="tab"
            aria-selected={provider.agentId === activeAgentId}
            aria-controls={provider.panelId}
            onClick={() => setActiveAgentId(provider.agentId)}
          >{provider.label}</button>
        ))}
      </div>
      {providerTabs.map((activeProvider) => (
        <section
          key={activeProvider.agentId}
          id={activeProvider.panelId}
          className="jamat-configuration-agents__panel"
          role="tabpanel"
          aria-labelledby={activeProvider.tabId}
          hidden={activeProvider.agentId !== activeAgentId}
        >
          {activeProvider.agentId === activeAgentId && (
            <>
              <ConfigurationSection title="Permissions">
                {row(
                  activeProvider.yoloId,
                  activeProvider.agentId,
                  activeProvider.label,
                  activeProvider.value.yolo,
                )}
                <p className="jamat-configuration-agents__note">
                  Yolo skips every permission prompt and pre-approves the session directory, so
                  {' '}{activeProvider.label} can read, write and run whatever it decides to. It
                  applies to the next launch of every {activeProvider.label} session, including the
                  ones already on the tree.
                </p>
                {activeProvider.specialNote !== null && (
                  <p className="jamat-configuration-agents__note">{activeProvider.specialNote}</p>
                )}
              </ConfigurationSection>
              <ConfigurationSection title="Model">
                {modelRow(
                  activeProvider.modelId,
                  activeProvider.modelListId,
                  activeProvider.agentId,
                  activeProvider.label,
                  activeProvider.value.model ?? '',
                )}
                {effortRow(
                  activeProvider.effortId,
                  activeProvider.agentId,
                  activeProvider.label,
                  activeProvider.value.model ?? '',
                  activeProvider.value.effort ?? '',
                )}
                <p className="jamat-configuration-agents__note">
                  A default model is applied to the next NEW {activeProvider.label} session Jamat
                  starts. Reopening an existing conversation never changes what it runs on, so a
                  model chosen inside a session with <code>/model</code> survives. The suggestions
                  are a list Jamat was given, not a rule: any id can be typed, including one
                  released after this build. {activeProvider.modelSyntax} Whether a model exists is
                  the agent&apos;s own answer, and it will say so in its terminal.
                  {' '}{activeProvider.effortRule}
                </p>
              </ConfigurationSection>
              <ConfigurationSection title="Context">
                {contextCompactionRows(
                  activeProvider.contextPanelId,
                  activeProvider.autoCompactId,
                  activeProvider.autoCompactEnabledId,
                  activeProvider.agentId,
                  activeProvider.label,
                  activeProvider.contextCompaction,
                )}
              </ConfigurationSection>
            </>
          )}
        </section>
      ))}
      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button"
          type="button"
          disabled={state.buffer === null || saving}
          onClick={() => ports.dispatch({ input: 'reset' })}
        >Reset to default</button>
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          type="button"
          disabled={!AgentSettingsModel.isModified(state) || saving}
          onClick={() => ports.dispatch({ input: 'save' })}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}
