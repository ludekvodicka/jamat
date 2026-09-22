import { useId } from 'react'

import { VersioningSettings } from '../../../../../shared/versioningSettings'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { ConfigurationSection } from '../../configurationSection'
import { useVersioningSettings } from './useVersioningSettings'

export function CommitReviewSection(props: ConfigurationTabProps): React.JSX.Element {
  const { state, dispatch, modified } = useVersioningSettings('commitReview', props.onDirtyChange)
  const withinId = useId()
  const disabled = state.buffer === null || state.saving !== null
  return <ConfigurationSection title="Commit review" className="jamat-configuration-versioning">
    {state.problem !== null && <p role="alert" className="jamat-configuration__problem">{state.problem}</p>}
    <label><input type="checkbox" checked={state.buffer?.activateSessionOnCommit !== false} disabled={disabled}
      onChange={(event) => dispatch({ input: 'activateSessionOnCommit', value: event.currentTarget.checked })} />
      Activate session when an agent opens a commit dialog</label>
    <p className="jamat-configuration-versioning__note">When disabled, the dialog opens in the background and the session shows a red exclamation mark.</p>
    <label><input type="checkbox" checked={state.buffer?.returnToPreviousSessionAfterCommit !== false}
      disabled={disabled || state.buffer?.activateSessionOnCommit === false}
      onChange={(event) => dispatch({ input: 'returnToPreviousSessionAfterCommit', value: event.currentTarget.checked })} />
      Return to the previous session after the commit</label>
    <p className="jamat-configuration-versioning__note">After an automatic switch, return when the commit succeeds or the dialog closes, if you are still in the commit session. When disabled, stay in the commit session.</p>
    <label className="jamat-configuration-versioning__minutes" htmlFor={withinId}>Only within
      <input id={withinId} type="number" min={0} max={VersioningSettings.maxReturnWithinMinutesConst} step={1}
        disabled={disabled || state.buffer?.returnToPreviousSessionAfterCommit === false
          || state.buffer?.activateSessionOnCommit === false}
        value={state.buffer?.returnToPreviousSessionWithinMinutes ?? VersioningSettings.defaultReturnWithinMinutesConst}
        onChange={(event) => dispatch({ input: 'returnToPreviousSessionWithinMinutes', value: Number(event.currentTarget.value) })} />
      minutes of opening the dialog</label>
    <p className="jamat-configuration-versioning__note">A review you sat in for longer is where you are working now, so it stays in front. 0 turns the limit off and returns however long the review took.</p>
    <div className="jamat-configuration__actions">
      <button className="jamat-configuration__button" type="button" disabled={disabled}
        onClick={() => dispatch({ input: 'reset' })}>Reset to default</button>
      <button className="jamat-configuration__button jamat-configuration__button--primary" type="button" disabled={disabled || !modified}
        onClick={() => dispatch({ input: 'save' })}>{state.saving !== null ? 'Saving…' : 'Save'}</button>
    </div>
  </ConfigurationSection>
}
