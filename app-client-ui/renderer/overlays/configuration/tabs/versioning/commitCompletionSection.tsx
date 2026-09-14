import type { ConfigurationTabProps } from '../../configurationTab.types'
import { ConfigurationSection } from '../../configurationSection'
import { useVersioningSettings } from './useVersioningSettings'

export function CommitCompletionSection(props: ConfigurationTabProps): React.JSX.Element {
  const { state, dispatch, modified } = useVersioningSettings('closeCommitOnSuccess', props.onDirtyChange)
  const disabled = state.buffer === null || state.saving !== null
  return <ConfigurationSection title="Commit completion" className="jamat-configuration-versioning">
    {state.problem !== null && <p role="alert" className="jamat-configuration__problem">{state.problem}</p>}
    <label><input type="checkbox" checked={state.buffer?.closeCommitOnSuccess !== false} disabled={disabled}
      onChange={(event) => dispatch({ input: 'closeCommitOnSuccess', value: event.currentTarget.checked })} />
      Close commit dialog after a successful commit</label>
    <p className="jamat-configuration-versioning__note">Failed commits and SVN updates keep the dialog open for review.</p>
    <div className="jamat-configuration__actions">
      <button className="jamat-configuration__button" type="button" disabled={disabled}
        onClick={() => dispatch({ input: 'reset' })}>Reset to default</button>
      <button className="jamat-configuration__button jamat-configuration__button--primary" type="button" disabled={disabled || !modified}
        onClick={() => dispatch({ input: 'save' })}>{state.saving !== null ? 'Saving…' : 'Save'}</button>
    </div>
  </ConfigurationSection>
}
