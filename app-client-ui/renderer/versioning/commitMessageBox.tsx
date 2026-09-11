import { VersioningCommitLimits } from '../../shared/versioningCommit'

export function CommitMessageBox(props: {
  value: string; disabled: boolean; proposed: boolean; onChange(message: string): void
}): React.JSX.Element {
  return <label className="commit-message">
    <span>Commit message{props.proposed ? ' (proposed by agent)' : ''}</span>
    <textarea aria-label="Commit message" value={props.value} disabled={props.disabled}
      title="Enter commits; Shift+Enter inserts a new line; Escape cancels"
      maxLength={VersioningCommitLimits.messageMaxCharactersConst} onChange={(event) => props.onChange(event.target.value)} />
  </label>
}
