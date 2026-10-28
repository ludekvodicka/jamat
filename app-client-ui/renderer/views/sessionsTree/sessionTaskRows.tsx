import type {
  SessionShellState,
  SessionSubagentState,
} from '../../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { SignalGlyph } from '../../widgets/signalGlyph'
import type { SessionPaint } from './sessionNodeState'
import type { SessionTasksNode, TaskRowNode } from './sessionsTreeModel'

/** Retained sub-agents and shells, opening in the parent's split. */
export function SessionTaskRows(props: {
  tasks: SessionTasksNode
  onOpen(row: TaskRowNode, title: string): void
}): React.JSX.Element {
  const { tasks } = props
  return (
    <div className="jamat-sessions__tasks">
      {tasks.rows.map((row) => <TaskRow key={row.id} row={row} numberPrefix={tasks.numberPrefix} onOpen={props.onOpen} />)}
    </div>
  )
}

function TaskRow(props: { row: TaskRowNode; numberPrefix: string | null; onOpen(row: TaskRowNode, title: string): void }): React.JSX.Element {
  const { row } = props
  const open = (): void => props.onOpen(row, SessionTaskOpen.titleOf(row))
  return (
    <div
      className="jamat-sessions__task"
      data-task={row.id}
      data-depth={row.depth}
      data-state={row.state}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        open()
      }}
    >
      <TaskGlyph state={row.state} />
      {props.numberPrefix !== null && <span className="jamat-sessions__task-number">{props.numberPrefix}</span>}
      <TaskRowText row={row} />
    </div>
  )
}

function TaskRowText(props: { row: TaskRowNode }): React.JSX.Element {
  const { row } = props
  const task = row.task
  switch (task.kind) {
    case 'subagent':
      return (
        <>
          <span className="jamat-sessions__task-type">{row.label}</span>
          <span className="jamat-sessions__task-description" title={row.description}>{row.description}</span>
          {row.detail !== null && (
            <span className="jamat-sessions__task-step" title={row.detail}>{row.detail}</span>
          )}
        </>
      )
    case 'shell':
      return (
        <span className="jamat-sessions__task-description" title={row.description === '' ? row.label : row.description}>
          {row.label}
        </span>
      )
    default:
      throw new Error(`Unknown session task: ${JSON.stringify(task satisfies never)}`)
  }
}

function TaskGlyph(props: { state: TaskRowNode['state'] }): React.JSX.Element {
  const paint = SessionTaskGlyphs.paintOf(props.state)
  const title = SessionTaskGlyphs.titleOf(props.state)
  return (
    <span
      className={`jamat-sessions__glyph jamat-sessions__glyph--paint-${paint}`}
      data-paint={paint}
      title={title}
      aria-label={title}
    >
      <SignalGlyph glyph={SessionTaskGlyphs.characterOf(props.state)} />
    </span>
  )
}

class SessionTaskOpen {
  /** The operation refuses a longer title; a strip tab shows far less anyway. */
  private static readonly titleMaxConst = 200

  /** A sub-agent's `type: description`; a shell's `$ <command>`. */
  static titleOf(row: TaskRowNode): string {
    let title: string
    switch (row.task.kind) {
      case 'subagent':
        title = `${row.label}: ${row.description}`
        break
      case 'shell':
        title = row.label
        break
      default: throw new Error(`Unknown session task: ${JSON.stringify(row.task satisfies never)}`)
    }
    return title.length <= SessionTaskOpen.titleMaxConst ? title : `${title.slice(0, SessionTaskOpen.titleMaxConst - 1)}…`
  }

}

/** A sub-agent's or shell's state as one character and one paint, the shapes a script run's row uses. */
export class SessionTaskGlyphs {
  static characterOf(state: SessionSubagentState | SessionShellState): string {
    switch (state) {
      case 'running': return '●'
      case 'done': return '✓'
      case 'failed': return '×'
      case 'stopped':
      case 'killed': return '■'
      case 'unfinished': return '?'
      default: throw new Error(`Unknown task state: ${JSON.stringify(state satisfies never)}`)
    }
  }

  static paintOf(state: SessionSubagentState | SessionShellState): SessionPaint {
    switch (state) {
      case 'running': return 'accent'
      case 'done': return 'ok'
      case 'failed': return 'danger'
      case 'stopped':
      case 'killed':
      case 'unfinished': return 'muted'
      default: throw new Error(`Unknown task state: ${JSON.stringify(state satisfies never)}`)
    }
  }

  static titleOf(state: SessionSubagentState | SessionShellState): string {
    switch (state) {
      case 'running': return 'Running'
      case 'done': return 'Done'
      case 'failed': return 'Failed'
      case 'stopped': return 'Stopped'
      case 'killed': return 'Killed'
      case 'unfinished': return 'Did not finish'
      default: throw new Error(`Unknown task state: ${JSON.stringify(state satisfies never)}`)
    }
  }
}
