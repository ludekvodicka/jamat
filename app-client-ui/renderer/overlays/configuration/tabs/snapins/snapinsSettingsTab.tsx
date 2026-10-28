import { useEffect, useRef, useState } from 'react'
import type { SnapinField, SnapinKindValues, SnapinsSettings, SnapinsSettingsView } from '../../../../../../lib-orchestrator/snapins/snapinsApi.types'
import type { SessionAgentId } from '../../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { SettingsCard, type SettingsCardPorts } from '../../settingsCard'
import { SnapinsSettingsEffects, type SnapinsSettingsEffect, type SnapinsSettingsInput } from './snapinsSettingsEffects'
import './snapinsSettings.css'

export function SnapinsSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => SettingsCard.initial<SnapinsSettingsView, SnapinsSettingsEffect>())
  const [state, setState] = useState(start.state)
  const stateRef = useRef(state)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const reportedDirty = useRef(false)
  const live = useRef(false)
  const [ports] = useState<SettingsCardPorts<SnapinsSettingsInput>>(() => {
    const self: SettingsCardPorts<SnapinsSettingsInput> = { dispatch: (input) => {
      if (!live.current) return
      const shared = SettingsCard.transition<SnapinsSettingsView, SnapinsSettingsEffect>(stateRef.current, input, (value) => value)
      const step = shared ?? (input.input === 'edit'
        ? SettingsCard.step<SnapinsSettingsView, SnapinsSettingsEffect>({ ...stateRef.current, buffer: input.value }) : null)
      if (!step) throw new Error(`Unknown snap-ins settings input ${JSON.stringify(input)}`)
      stateRef.current = step.state
      setState(step.state)
      const dirty = SettingsCard.isModified(step.state, (a, b) => JSON.stringify(a.settings) === JSON.stringify(b.settings))
      if (dirty !== reportedDirty.current) { reportedDirty.current = dirty; dirtyChange.current(dirty) }
      for (const effect of step.effects) void SnapinsSettingsEffects.run(effect, self)
    } }
    return self
  })
  useEffect(() => {
    live.current = true
    for (const effect of start.effects) void SnapinsSettingsEffects.run(effect, ports)
    return () => { live.current = false }
  }, [ports, start.effects])
  function edit(settings: SnapinsSettings): void {
    if (state.buffer) ports.dispatch({ input: 'edit', value: { ...state.buffer, settings } })
  }
  const settings = state.buffer?.settings
  const dirty = SettingsCard.isModified(state, (a, b) => JSON.stringify(a.settings) === JSON.stringify(b.settings))
  const agents: { id: SessionAgentId; label: string }[] = [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }]
  return <div className="snapins-settings">
    {state.problem && <p role="alert" className="jamat-configuration__problem">{state.problem}</p>}
    {!settings && <p>Reading Snap-ins settings…</p>}
    {settings && <>
      <ConfigurationSection title="Workers">
        <label>Concurrent worker limit <input aria-label="Concurrent worker limit" type="number" min={1} max={32} value={settings.limit}
          onChange={(event) => edit({ ...settings, limit: Number(event.target.value) })} /></label>
        {agents.map((agent) => <div key={agent.id}>
          <label><input type="checkbox" checked={settings.agents.includes(agent.id)} onChange={(event) => edit({ ...settings,
            agents: event.target.checked ? [...settings.agents, agent.id] : settings.agents.filter((id) => id !== agent.id) })} />{agent.label}</label>
          <label>{agent.label} worker prompt <textarea aria-label={`${agent.label} worker prompt`} value={settings.workerPrompts[agent.id] ?? ''}
            onChange={(event) => edit({ ...settings, workerPrompts: { ...settings.workerPrompts, [agent.id]: event.target.value } })} /></label>
        </div>)}
        <p>Include {'{pass}'} for the worker brief directory. A blank prompt disables that worker.</p>
      </ConfigurationSection>
      {state.buffer!.kinds.map((kind) => <ConfigurationSection key={kind.kind} title={kind.title}>
        {kind.fields.map((field) => <KindField key={field.id} field={field} value={settings.kinds[kind.kind]?.[field.id]}
          onChange={(value) => edit({ ...settings, kinds: { ...settings.kinds, [kind.kind]: { ...settings.kinds[kind.kind], [field.id]: value } } })} />)}
      </ConfigurationSection>)}
    </>}
    <div className="jamat-configuration__actions"><button type="button" className="jamat-configuration__button jamat-configuration__button--primary"
      disabled={!dirty || state.saving !== null} onClick={() => ports.dispatch({ input: 'save' })}>{state.saving ? 'Saving…' : 'Save'}</button></div>
  </div>
}

function KindField({ field, value, onChange }: { field: SnapinField; value: SnapinKindValues[string] | undefined; onChange(value: SnapinKindValues[string]): void }): React.JSX.Element {
  switch (field.kind) {
    case 'number': return <label>{field.label}<input type="number" min={field.min} max={field.max} value={typeof value === 'number' ? value : field.value}
      onChange={(event) => onChange(Number(event.target.value))} /></label>
    case 'text': return <label>{field.label}<input value={typeof value === 'string' ? value : field.value} onChange={(event) => onChange(event.target.value)} /></label>
    case 'choicePerRow': return <fieldset><legend>{field.label}</legend>{field.rows.map((row) => <div key={row.key}><label>{row.label}
      <select value={typeof value === 'object' ? value[row.key] ?? row.value : row.value}
        onChange={(event) => onChange({ ...(typeof value === 'object' ? value : {}), [row.key]: event.target.value })}>
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label></div>)}</fieldset>
    default: throw new Error(`Unknown snap-in settings field ${JSON.stringify(field satisfies never)}`)
  }
}
