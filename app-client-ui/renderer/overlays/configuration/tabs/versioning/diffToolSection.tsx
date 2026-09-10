import { useId } from 'react'
import { VersioningSettings, type VersioningDiffTool } from '../../../../../shared/versioningSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { useVersioningSettings } from './useVersioningSettings'

export function DiffToolSection(props: ConfigurationTabProps): React.JSX.Element {
  const { state, dispatch, modified } = useVersioningSettings('diffTool', props.onDirtyChange)
  const id = useId()
  const tool = state.buffer?.diffTool ?? VersioningSettings.defaultValue().diffTool
  const disabled = state.buffer === null || state.saving !== null
  const change = (value: VersioningDiffTool): void => dispatch({ input: 'diffTool', value })
  const valid = VersioningSettings.isDiffTool(tool)
  return <ConfigurationSection title="Commit diff viewer" className="jamat-configuration-versioning">
    {state.problem !== null && <p role="alert" className="jamat-configuration__problem">{state.problem}</p>}
    <div className="jamat-configuration-versioning__row">
      <label htmlFor={id}>Open a file from the commit dialog</label>
      <select id={id} value={tool.kind} disabled={disabled} onChange={(event) => {
        const kind = event.currentTarget.value
        if (kind === 'internal') change({ kind })
        else if (kind === 'external') change({ kind, command: '', argumentTemplate: '%base %mine' })
        else throw new Error(`Unknown diff viewer: ${kind}`)
      }}><option value="internal">Internal viewer</option><option value="external">External tool</option></select>
    </div>
    {tool.kind === 'external' && <>
      <label className="jamat-configuration-diff-field">Executable
        <input disabled={disabled} value={tool.command} onChange={(event) => change({ ...tool, command: event.currentTarget.value })} />
      </label>
      <label className="jamat-configuration-diff-field">Arguments
        <input disabled={disabled} value={tool.argumentTemplate} onChange={(event) => change({ ...tool, argumentTemplate: event.currentTarget.value })} />
      </label>
      <p className="jamat-configuration-versioning__note">Use %base and %mine for the files, %bname and %yname for their labels. Quote arguments containing spaces. Edits to the working file are saved in your project.</p>
      {!valid && <p role="alert" className="jamat-configuration__problem">Enter an executable and arguments containing %base and %mine with matching quotes.</p>}
    </>}
    <div className="jamat-configuration__actions">
      <button type="button" disabled={disabled} onClick={() => change(VersioningSettings.tortoiseMerge())}>TortoiseMerge preset</button>
      <button type="button" disabled={disabled} onClick={() => dispatch({ input: 'reset' })}>Reset to default</button>
      <button type="button" className="jamat-configuration__button jamat-configuration__button--primary"
        disabled={disabled || !modified || !valid} onClick={() => dispatch({ input: 'save' })}>{state.saving === null ? 'Save' : 'Saving…'}</button>
    </div>
  </ConfigurationSection>
}
