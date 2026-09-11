import type { ConfigurationTabProps } from '../../configurationTab.types'
import { ConfigurationSection } from '../../configurationSection'
import { useVersioningSettings } from './useVersioningSettings'

export function CommitReviewSection(props: ConfigurationTabProps): React.JSX.Element {
  const { state, dispatch, modified } = useVersioningSettings('activateSessionOnCommit', props.onDirtyChange)
  const disabled = state.buffer === null || state.saving !== null
  return <ConfigurationSection title="Commit review" className="jamat-configuration-versioning">
    {state.problem !== null && <p role="alert" className="jamat-configuration__problem">{state.problem}</p>}
    <label><input type="checkbox" checked={state.buffer?.activateSessionOnCommit !== false} disabled={disabled}
      onChange={(event) => dispatch({ input: 'activateSessionOnCommit', value: event.currentTarget.checked })} />
      Activate session when an agent opens a commit dialog</label>
    <p className="jamat-configuration-versioning__note">When disabled, the dialog opens in the background and the session shows a red exclamation mark.</p>
    <div className="jamat-configuration__actions">
      <button className="jamat-configuration__button" type="button" disabled={disabled}
        onClick={() => dispatch({ input: 'reset' })}>Reset to default</button>
      <button className="jamat-configuration__button jamat-configuration__button--primary" type="button" disabled={disabled || !modified}
        onClick={() => dispatch({ input: 'save' })}>{state.saving !== null ? 'Saving…' : 'Save'}</button>
    </div>
  </ConfigurationSection>
}
