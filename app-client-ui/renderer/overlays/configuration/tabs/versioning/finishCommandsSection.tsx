import { VersioningSettings, type VersioningFinishCommands } from '../../../../../shared/versioningSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { useVersioningSettings } from './useVersioningSettings'

/** What Finish of a main-copy session types into the session when the person chooses a commit. */
export function FinishCommandsSection(props: ConfigurationTabProps): React.JSX.Element {
  const { state, dispatch, modified } = useVersioningSettings('finishCommitCommands', props.onDirtyChange)
  const commands = state.buffer?.finishCommitCommands ?? VersioningSettings.defaultFinishCommitCommandsConst
  const disabled = state.buffer === null || state.saving !== null
  const change = (vcs: keyof VersioningFinishCommands, value: string): void =>
    dispatch({ input: 'finishCommitCommands', value: { ...commands, [vcs]: value } })
  const valid = VersioningSettings.isFinishCommands(commands)
  return <ConfigurationSection title="Finish commit commands" className="jamat-configuration-versioning">
    {state.problem !== null && <p role="alert" className="jamat-configuration__problem">{state.problem}</p>}
    <label className="jamat-configuration-diff-field">SVN
      <input disabled={disabled} value={commands.svn} onChange={(event) => change('svn', event.currentTarget.value)} />
    </label>
    <label className="jamat-configuration-diff-field">Git
      <input disabled={disabled} value={commands.git} onChange={(event) => change('git', event.currentTarget.value)} />
    </label>
    <p className="jamat-configuration-versioning__note">Finish of a session that works in a main copy asks about the files the session changed.
      Commit &amp; close and Commit &amp; continue type this line into the session, and its agent makes the commit. A slash command such as /commit-svn works too.</p>
    {!valid && <p role="alert" className="jamat-configuration__problem">Enter one line for each, at most {VersioningSettings.maxFinishCommandLengthConst} characters.</p>}
    <div className="jamat-configuration__actions">
      <button type="button" disabled={disabled} onClick={() => dispatch({ input: 'reset' })}>Reset to default</button>
      <button type="button" className="jamat-configuration__button jamat-configuration__button--primary"
        disabled={disabled || !modified || !valid} onClick={() => dispatch({ input: 'save' })}>{state.saving === null ? 'Save' : 'Saving…'}</button>
    </div>
  </ConfigurationSection>
}
