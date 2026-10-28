import type { SessionWorkflowBody } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { WorkflowPorts } from '../workflow/workflowPane'
import type { TaskPanePorts } from '../taskView/taskPaneStore'
import { ScriptOutputView } from '../taskView/scriptOutputView'
import { useTaskPane } from '../taskView/taskPaneStore'
import { ConflictList, type ConflictListPorts } from '../workflow/conflictList'
import '../taskView/taskView.css'

export function StepBody(props: {
  body: SessionWorkflowBody
  sessionId: string
  title: string
  visible: boolean
  ports: Pick<WorkflowPorts, 'reviews' | 'tasks'>
  conflicts: ConflictListPorts
  onReview?(): void
  onClose?(): void
  busy?: boolean
}): React.JSX.Element | null {
  const body = props.body
  switch (body.kind) {
    case 'sessions': return <>
      <p>{body.liveUnknown === true ? 'The Host cannot be reached, so which sessions still run in the main copy is unknown. The update changes files under any that do.'
        : body.sessions.length === 0 ? 'No other live sessions work in the main copy.' : 'These sessions work in the main copy. The update changes files under them.'}</p>
      <ul aria-label="Live sessions in the main copy">{body.sessions.map((session) => <li key={session.sessionId}>{session.title || session.sessionId}</li>)}</ul>
    </>
    case 'commit': return props.ports.reviews === undefined ? <p role="status">Finish review is unavailable for this session workspace. Update the source client to approve it here.</p>
      : props.onReview === undefined ? null : <div className="workflow__step-actions">
      <button type="button" className="workflow__action workflow__action--primary" disabled={props.busy} onClick={props.onReview}>Review changes</button>
    </div>
    case 'commands': return <ul aria-label="Setup commands">{body.commands.map((command, index) => <li key={index}><code>{command}</code></li>)}</ul>
    case 'log': return props.ports.tasks === undefined ? <p role="status">Task output is unavailable for this session workspace.</p> : <StepLog ports={props.ports.tasks} key={body.runId} sessionId={props.sessionId} runId={body.runId} title={props.title} visible={props.visible} onClose={props.onClose} />
    case 'conflicts': return body.conflicts === undefined || body.summary === undefined ? null
      : body.readOnly === true ? <><p>{body.summary}</p><ul>{body.conflicts.entries.map((entry) =>
        <li key={`${entry.kind}:${entry.path}`}>{entry.path}: {entry.description}</li>)}</ul>
        {body.conflicts.more > 0 && <p>{body.conflicts.more} more conflicts</p>}</>
        : <ConflictList summary={body.summary} conflicts={body.conflicts} mergeBrief={body.mergeBrief ?? null} ports={props.conflicts} />
    default: throw new Error(`Unknown step body: ${JSON.stringify(body satisfies never)}`)
  }
}

function StepLog(props: { ports: TaskPanePorts; sessionId: string; runId: string; title: string; visible: boolean; onClose?(): void }): React.JSX.Element {
  const view = useTaskPane({ sessionId: props.sessionId, task: { kind: 'script', runId: props.runId } }, props.ports, props.visible)
  switch (view.kind) {
    case 'loading': return <p>Reading output…</p>
    case 'failed': case 'none': return <p role="status">{view.reason}</p>
    case 'script': return <ScriptOutputView output={view.output} title={props.title} runId={props.runId} error={view.error} openTerminal={props.ports.openTerminal} onClose={props.onClose} />
    case 'transcript': case 'output': throw new Error('A log body requires script output')
    default: throw new Error(`Unknown log view: ${JSON.stringify(view satisfies never)}`)
  }
}
