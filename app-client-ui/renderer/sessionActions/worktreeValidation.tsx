import { useState, useSyncExternalStore } from 'react'
import type { SessionWorkflowInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../shared/errorText'
import type { WorkflowPorts, WorkflowPressAnswer } from '../workflow/workflowPane'

/**
 * The command typed per worktree. It lives outside the component because Recheck rebuilds the
 * review that mounts it, and the history and review panes each mount one for the same worktree.
 */
export class WorktreeValidationDrafts {
  private readonly commands: Map<string, string>
  private readonly subscribers: Set<() => void>

  constructor() {
    this.commands = new Map()
    this.subscribers = new Set()
  }

  subscribe(changed: () => void): () => void {
    this.subscribers.add(changed)
    return () => this.subscribers.delete(changed)
  }

  commandOf(cwd: string): string {
    return this.commands.get(cwd) ?? ''
  }

  set(cwd: string, command: string): void {
    this.commands.set(cwd, command)
    for (const changed of this.subscribers) changed()
  }
}

const drafts = new WorktreeValidationDrafts()

export function WorktreeValidation({ value, ports }: { value: NonNullable<SessionWorkflowInfo['validation']>; ports: WorkflowPorts }): React.JSX.Element {
  const command = useSyncExternalStore((changed) => drafts.subscribe(changed), () => drafts.commandOf(value.cwd))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)
  const [stopProblem, setStopProblem] = useState<string | null>(null)
  let checks: string
  switch (value.checks) {
    case 'pending': checks = 'Preparation or checks need to run again.'; break
    case 'passed': checks = 'Automated checks passed for this prepared state.'; break
    case 'none': checks = 'No automated checks are configured. Manual validation is required.'; break
    case 'overridden': checks = 'Failed checks were explicitly accepted.'; break
    default: throw new Error(`Unknown check state: ${value.checks satisfies never}`)
  }
  const runs = value.runs ?? []
  return <div className="worktree-validation" aria-label="Worktree validation">
    <p>{checks} Source edits require another preparation before publication.</p>
    <p>Worktree: <code>{value.cwd}</code></p>
    {value.environmentInputs && <p>Refresh dependencies for: {value.environmentInputs.join(', ')}. Confirm with “Environment is ready” when it matches them.</p>}
    {ports.requestRun && value.canRun ? <form onSubmit={(event) => {
      event.preventDefault()
      if (!command.trim() || busy) return
      setBusy(true)
      void ports.requestRun!(command, value.cwd).then((problem) => setResult(problem ?? 'Started.'))
        .catch((error: unknown) => setResult(String(error))).finally(() => setBusy(false))
    }}>
      <label>Application command <input aria-label="Application command" value={command} onChange={(event) => drafts.set(value.cwd, event.target.value)} placeholder="pnpm dev" disabled={busy} /></label>
      <button type="submit" className="workflow__action" disabled={busy || !command.trim()}>{busy ? 'Starting…' : 'Run in worktree'}</button>
    </form> : <p>{value.canRun ? 'Run the application from a terminal on the source computer.' : 'Reopen the session to start a managed validation run, or use a terminal in this worktree.'}</p>}
    {runs.length > 0 && <ul aria-label="Running in this worktree">{runs.map((run) => <li key={run.runId}>
      {run.title} is running{' '}
      <button type="button" className="workflow__action" aria-label={`Stop ${run.title}`} disabled={stopping !== null} onClick={() => {
        setStopping(run.runId)
        setStopProblem(null)
        void ports.press(run.stop, {}).then((answer) => setStopProblem(WorktreeValidationText.stopProblemOf(answer)))
          .catch((error: unknown) => setStopProblem(ErrorText.of(error))).finally(() => setStopping(null))
      }}>{stopping === run.runId ? 'Stopping…' : 'Stop'}</button>
    </li>)}</ul>}
    {stopProblem !== null && <p role="alert">{stopProblem}</p>}
    <p>After validation, publish the full verified change set. Cleanup stops this session’s managed runs; close other dev servers and terminals if files remain in use.</p>
    {result && <p role="status">{result}</p>}
  </div>
}

class WorktreeValidationText {
  static stopProblemOf(answer: WorkflowPressAnswer): string | null {
    switch (answer.kind) {
      case 'done': return null
      case 'refused': case 'working': return answer.sentence
      case 'agreement': return 'The run was not stopped: the press asked for a setup agreement.'
      default: throw new Error(`Unknown press answer: ${JSON.stringify(answer satisfies never)}`)
    }
  }
}
