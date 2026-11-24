import type { CommitMessageFindingInfo, CommitMessageSource } from '../../../lib-orchestrator/svn/svnCommitMessageCheck'
import { VersioningCommitLimits } from '../../shared/versioningCommit'

const firstLineOf = (value: string): string => value.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? ''

export function CommitMessageBox(props: {
  source?: CommitMessageSource; findings?: CommitMessageFindingInfo[]
  value: string; disabled: boolean; proposed: boolean; reviewOnly?: boolean
  expanded?: boolean; onExpandedChange?(open: boolean): void
  onChange(message: string): void
}): React.JSX.Element {
  const expanded = props.expanded ?? true
  const preview = firstLineOf(props.value)
  return <div className={`commit-message${expanded ? '' : ' commit-message--collapsed'}`}>
    <details className="commit-message-details" open={expanded} onToggle={(event) => {
      const next = event.currentTarget.open
      props.onExpandedChange?.(next)
    }}>
      <summary className="commit-message-summary">
        <span className="commit-message-label">Commit message{props.proposed ? ' (proposed by agent)' : ''}</span>
        {!expanded && preview !== '' && <span className="commit-message-preview" title={props.value}>{preview}</span>}
        {props.source !== undefined && <span className="commit-message-source">Source: {props.source}</span>}
        <span className="commit-message-action">{expanded ? 'Hide' : 'Edit'}</span>
      </summary>
      <textarea aria-label="Commit message" value={props.value} disabled={props.disabled}
        title={props.reviewOnly ? 'Commit message' : 'Enter commits; Shift+Enter inserts a new line; Escape closes this view'}
        maxLength={VersioningCommitLimits.messageMaxCharactersConst} onChange={(event) => props.onChange(event.target.value)} />
    </details>
    {props.findings !== undefined && props.findings.length > 0 && <ul className="commit-message-findings">
      {props.findings.map((finding) => <li key={finding.id}>{finding.text}</li>)}
    </ul>}
  </div>
}
