import type { CommitMessageFindingInfo, CommitMessageSource } from '../../../lib-orchestrator/svn/svnCommitMessageCheck'
import { VersioningCommitLimits } from '../../shared/versioningCommit'

export function CommitMessageBox(props: {
  source?: CommitMessageSource; findings?: CommitMessageFindingInfo[]
  value: string; disabled: boolean; proposed: boolean; reviewOnly?: boolean; onChange(message: string): void
}): React.JSX.Element {
  return <label className="commit-message">
    <span>Commit message{props.proposed ? ' (proposed by agent)' : ''}</span>
    {props.source !== undefined && <span>Source: {props.source}</span>}
    {props.findings !== undefined && <ul>{props.findings.map((finding) => <li key={finding.id}>{finding.text}</li>)}</ul>}
    <textarea aria-label="Commit message" value={props.value} disabled={props.disabled}
      title={props.reviewOnly ? 'Commit message' : 'Enter commits; Shift+Enter inserts a new line; Escape closes this view'}
      maxLength={VersioningCommitLimits.messageMaxCharactersConst} onChange={(event) => props.onChange(event.target.value)} />
  </label>
}
