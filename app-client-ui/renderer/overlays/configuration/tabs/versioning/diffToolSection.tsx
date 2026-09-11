import { VersioningSettings, type VersioningDiffTool } from '../../../../../shared/versioningSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { useVersioningSettings } from './useVersioningSettings'

export function DiffToolSection(props: ConfigurationTabProps): React.JSX.Element {
  const { state, dispatch, modified } = useVersioningSettings('diffTool', props.onDirtyChange)
  const tool = state.buffer?.diffTool ?? VersioningSettings.defaultValue().diffTool
  const external = tool.kind === 'external' ? tool : { kind: 'external' as const, command: '', argumentTemplate: '"$1" "$2"' }
  const disabled = state.buffer === null || state.saving !== null
  const change = (value: VersioningDiffTool): void => dispatch({ input: 'diffTool', value })
  const valid = VersioningSettings.isDiffTool(tool)
  return <ConfigurationSection title="External diff viewer" className="jamat-configuration-versioning">
    {state.problem !== null && <p role="alert" className="jamat-configuration__problem">{state.problem}</p>}
    <label className="jamat-configuration-diff-field">Executable
      <input disabled={disabled} value={external.command} onChange={(event) => change(event.currentTarget.value.trim()
        ? { ...external, command: event.currentTarget.value } : { kind: 'internal' })} />
    </label>
    <label className="jamat-configuration-diff-field">Arguments
      <input disabled={disabled || tool.kind === 'internal'} value={external.argumentTemplate} onChange={(event) => change({ ...external, argumentTemplate: event.currentTarget.value })} />
    </label>
    <p className="jamat-configuration-versioning__note">Use $1 for the original file and $2 for the working file. Quote arguments containing spaces. Edits to the working file are saved in your project.</p>
    <p className="jamat-configuration-versioning__note">Show external diff appears in the commit file menu when configured. Clear the executable to hide it. Show diff and double-click always use the internal viewer.</p>
    {!valid && <p role="alert" className="jamat-configuration__problem">Enter arguments containing $1 and $2 with matching quotes.</p>}
    <div className="jamat-configuration__actions">
      <button type="button" disabled={disabled} onClick={() => change(VersioningSettings.tortoiseMerge())}>TortoiseMerge preset</button>
      <button type="button" disabled={disabled} onClick={() => dispatch({ input: 'reset' })}>Reset to default</button>
      <button type="button" className="jamat-configuration__button jamat-configuration__button--primary"
        disabled={disabled || !modified || !valid} onClick={() => dispatch({ input: 'save' })}>{state.saving === null ? 'Save' : 'Saving…'}</button>
    </div>
  </ConfigurationSection>
}
