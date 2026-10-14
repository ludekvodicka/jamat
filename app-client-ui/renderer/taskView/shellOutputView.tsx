import { useLayoutEffect, useRef } from 'react'

import type { SessionShellOutput } from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { DurationFormat } from '../../shared/durationFormat'
import { SessionTaskGlyphs } from '../views/sessionsTree/sessionTaskRows'
import { SubagentTranscriptText } from './subagentTranscriptView'
import './taskView.css'

/**
 * The end of one background shell's output. The text is the command's own, so it is drawn as plain
 * monospace text; the library already removed the terminal control sequences.
 */
export function ShellOutputView(props: { output: Extract<SessionShellOutput, { kind: 'output' }> }): React.JSX.Element {
  const { output } = props
  const body = useRef<HTMLDivElement | null>(null)
  // A shell's latest line is what matters, so the view opens at the bottom and stays there while the
  // person does.
  const stick = useRef(true)
  const now = Date.now()

  useLayoutEffect(() => {
    const element = body.current
    if (element !== null && stick.current) element.scrollTop = element.scrollHeight
  }, [output])

  return (
    <div className="task-view">
      <header className="task-view__header">
        <div className="task-view__title">$ {output.command}</div>
        <div className="task-view__facts" data-state={output.state}>{SessionTaskGlyphs.titleOf(output.state)}</div>
      </header>
      <div
        className="task-view__entries"
        ref={body}
        onScroll={(event) => {
          const element = event.currentTarget
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight
            <= SubagentTranscriptText.bottomSlackPixelsConst
        }}
      >
        <p className="task-view__note">Started {ShellOutputTime.clockOf(output.startedAt, now)}</p>
        {output.earlierOutputOmitted && <p className="task-view__note">Earlier output is not shown.</p>}
        {output.text === ''
          ? <p className="task-view__note">{output.state === 'running' ? 'No output yet.' : 'No output.'}</p>
          : <div className="task-view__text" data-testid="shell-output-text">{output.text}</div>}
        {output.endedAt !== null && <p className="task-view__note">
          Ended {ShellOutputTime.clockOf(output.endedAt, now)} · took {DurationFormat.of(output.endedAt - output.startedAt)}
        </p>}
      </div>
    </div>
  )
}

class ShellOutputTime {
  /** A shell of an older session started on another day, and a bare clock time would hide that. */
  static clockOf(at: number, now: number): string {
    const date = new Date(at)
    return date.toDateString() === new Date(now).toDateString() ? date.toLocaleTimeString() : date.toLocaleString()
  }
}
