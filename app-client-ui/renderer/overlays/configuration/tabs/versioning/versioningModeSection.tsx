import { useEffect, useId, useRef, useState } from 'react'

import type { VersioningMode } from '../../../../../../lib-orchestrator/git/git.types'
import { VersioningSettings } from '../../../../../shared/versioningSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './versioningSettings.css'
import {
  VersioningSettingsEffects,
  type VersioningSettingsPorts,
} from './versioningSettingsEffects'
import {
  VersioningSettingsModel,
  type VersioningSettingsModelState,
} from './versioningSettingsModel'

/** What each mode does, in the two sentences somebody choosing between them actually needs. */
const modeLabelsConst: Readonly<Record<VersioningMode, { title: string; detail: string }>> = {
  checkpoints: {
    title: 'Checkpoints',
    detail: 'AI checkpoints and worktrees go into .checkpoints/store.git inside the project. '
      + 'A repository of your own is never written to, and a project with no version control at '
      + 'all can still run isolated sessions.',
  },
  git: {
    title: 'Project Git',
    detail: 'Work goes straight into the project’s own .git, for anyone running AppJamatV3 '
      + 'without our shared instructions. A project without a .git refuses an isolated session.',
  },
}

/**
 * Where AI work is versioned. The first of the Versioning tab's two sections, and the one that owns
 * the `versioning` key; the VCS preference beside it writes its own.
 */
export function VersioningModeSection(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => VersioningSettingsModel.initial())
  const [state, setState] = useState<VersioningSettingsModelState>(start.state)
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  const mounted = useRef(true)
  dirtyChange.current = props.onDirtyChange
  const selectId = useId()
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [ports] = useState<VersioningSettingsPorts>(() => {
    const self: VersioningSettingsPorts = {
      dispatch: (input) => {
        if (!mounted.current) return
        const step = VersioningSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        const modified = VersioningSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void VersioningSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void VersioningSettingsEffects.run(effect, ports)
  }, [ports, start.effects])

  const saving = state.saving !== null
  const mode = state.buffer?.mode ?? VersioningSettings.defaultModeConst
  return (
    <ConfigurationSection title="AI versioning" className="jamat-configuration-versioning">
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}
      {state.buffer === null && (
        <p className="jamat-configuration-versioning__note">Reading config.json…</p>
      )}
      <div className="jamat-configuration-versioning__row">
        <div className="jamat-configuration-versioning__heading">
          <label htmlFor={selectId}>Where AI work is versioned</label>
          <span>{modeLabelsConst[mode].detail}</span>
        </div>
        <select
          id={selectId}
          disabled={state.buffer === null || saving}
          value={mode}
          onChange={(event) => ports.dispatch({
            input: 'mode',
            value: event.currentTarget.value as VersioningMode,
          })}
        >
          {VersioningSettings.modeOptionsConst.map((value) => (
            <option key={value} value={value}>{modeLabelsConst[value].title}</option>
          ))}
        </select>
      </div>
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
          disabled={!VersioningSettingsModel.isModified(state) || saving}
          onClick={() => ports.dispatch({ input: 'save' })}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </ConfigurationSection>
  )
}
