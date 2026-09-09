import { useEffect, useId, useRef, useState } from 'react'

import {
  RemarkableStorageSettings,
  type RemarkableStorageScope,
} from '../../../../../shared/remarkableStorageSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './remarkableStorageSettings.css'
import {
  RemarkableStorageSettingsEffects,
  type RemarkableStorageSettingsPorts,
} from './remarkableStorageSettingsEffects'
import {
  RemarkableStorageSettingsModel,
  type RemarkableStorageSettingsModelState,
} from './remarkableStorageSettingsModel'

export function RemarkableStorageSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => RemarkableStorageSettingsModel.initial())
  const [state, setState] = useState<RemarkableStorageSettingsModelState>(start.state)
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  const mounted = useRef(true)
  dirtyChange.current = props.onDirtyChange
  const scopeName = useId()
  const directoryId = useId()
  const problemId = useId()
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [ports] = useState<RemarkableStorageSettingsPorts>(() => {
    const self: RemarkableStorageSettingsPorts = {
      dispatch: (input) => {
        if (!mounted.current) return
        const step = RemarkableStorageSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        const modified = RemarkableStorageSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void RemarkableStorageSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void RemarkableStorageSettingsEffects.run(effect, ports)
  }, [ports, start.effects])

  const saving = state.saving !== null
  const disabled = state.buffer === null || saving
  const scope = state.buffer?.scope ?? RemarkableStorageSettings.defaultScopeConst
  const problem = RemarkableStorageSettingsModel.problemOf(state)
  return (
    <div className="jamat-configuration-remarkable-storage">
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}
      {state.buffer === null && (
        <p className="jamat-configuration-remarkable-storage__note">Reading config.json…</p>
      )}
      <ConfigurationSection title="Location">
        <fieldset className="jamat-configuration-remarkable-storage__scope">
          <legend>Where imported pages are kept</legend>
          {RemarkableStorageScopeText.optionsConst.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={scopeName}
                value={option.value}
                disabled={disabled}
                checked={scope === option.value}
                onChange={() => ports.dispatch({ input: 'scope', value: option.value })}
              />
              <span className="jamat-configuration-remarkable-storage__label">{option.title}</span>
              <span className="jamat-configuration-remarkable-storage__hint">{option.hint}</span>
            </label>
          ))}
        </fieldset>
      </ConfigurationSection>
      <ConfigurationSection title="Project folder">
        <div className="jamat-configuration-remarkable-storage__row">
          <div className="jamat-configuration-remarkable-storage__heading">
            <label htmlFor={directoryId}>Folder inside the project</label>
            <span>Relative to the directory the terminal runs in. Created on the first import.</span>
          </div>
          <input
            id={directoryId}
            type="text"
            spellCheck={false}
            disabled={disabled || scope !== 'project'}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? undefined : problemId}
            value={state.buffer?.projectDirectory ?? ''}
            placeholder={RemarkableStorageSettings.defaultProjectDirectoryConst}
            onChange={(event) => ports.dispatch({
              input: 'project-directory',
              value: event.currentTarget.value,
            })}
          />
        </div>
        {problem !== null && (
          <p className="jamat-configuration-remarkable-storage__bad" id={problemId}>{problem}</p>
        )}
      </ConfigurationSection>
      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button"
          type="button"
          disabled={disabled}
          onClick={() => ports.dispatch({ input: 'reset' })}
        >Reset to default</button>
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          type="button"
          disabled={!RemarkableStorageSettingsModel.canSave(state)}
          onClick={() => ports.dispatch({ input: 'save' })}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

class RemarkableStorageScopeText {
  static readonly optionsConst: readonly {
    value: RemarkableStorageScope
    title: string
    hint: string
  }[] = [
    {
      value: 'global',
      title: 'On this machine',
      hint: 'One folder for every project, cleaned after 30 days. The terminal gets the full path.',
    },
    {
      value: 'project',
      title: 'In the project',
      hint: 'Beside the work it belongs to, kept until you delete it. The terminal gets a short path.',
    },
  ]
}
