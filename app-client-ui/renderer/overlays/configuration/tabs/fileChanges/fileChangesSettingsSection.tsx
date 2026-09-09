import { useEffect, useId, useRef, useState } from 'react'

import {
  FileChangesSettings,
  type FileChangesPrimaryVcs,
} from '../../../../../shared/fileChangesSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './fileChangesSettings.css'
import {
  FileChangesSettingsEffects,
  type FileChangesSettingsPorts,
} from './fileChangesSettingsEffects'
import {
  FileChangesSettingsModel,
  type FileChangesSettingsModelState,
} from './fileChangesSettingsModel'

/**
 * Which VCS wins when a directory has both. It is a SECTION of the Versioning tab rather than a tab
 * of its own: the two questions are one subject read together, and this is the one the file surfaces
 * ask rather than the one AI work is written through. It keeps its own Save because it writes its own
 * `fileChanges` section - one button reporting two writes would report one outcome for two.
 */
export function FileChangesSettingsSection(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => FileChangesSettingsModel.initial())
  const [state, setState] = useState<FileChangesSettingsModelState>(start.state)
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const selectId = useId()
  const [ports] = useState<FileChangesSettingsPorts>(() => {
    const self: FileChangesSettingsPorts = {
      dispatch: (input) => {
        const step = FileChangesSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        const modified = FileChangesSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void FileChangesSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void FileChangesSettingsEffects.run(effect, ports)
  }, [ports, start.effects])

  const saving = state.saving !== null
  return (
    <ConfigurationSection title="File changes" className="jamat-configuration-file-changes">
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}
      {state.buffer === null && (
        <p className="jamat-configuration-file-changes__note">Reading config.json…</p>
      )}
      <div className="jamat-configuration-file-changes__row">
        <div className="jamat-configuration-file-changes__heading">
          <label htmlFor={selectId}>Primary version control</label>
          <span>Used when both Git and SVN are available and the caller has no temporary choice.</span>
        </div>
        <select
          id={selectId}
          disabled={state.buffer === null || saving}
          value={state.buffer?.primaryVcs ?? FileChangesSettings.defaultPrimaryVcsConst}
          onChange={(event) => ports.dispatch({
            input: 'primary-vcs',
            value: event.currentTarget.value as FileChangesPrimaryVcs,
          })}
        >
          {FileChangesSettings.primaryVcsOptionsConst.map((value) => (
            <option key={value} value={value}>{value === 'git' ? 'Git' : 'SVN'}</option>
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
          disabled={!FileChangesSettingsModel.isModified(state) || saving}
          onClick={() => ports.dispatch({ input: 'save' })}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </ConfigurationSection>
  )
}
