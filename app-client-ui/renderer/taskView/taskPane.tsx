import type { PanelSplitTaskItem } from '../widgets/tabs/panelSplit'
import { ShellOutputView } from './shellOutputView'
import { ScriptOutputView } from './scriptOutputView'
import { SubagentTranscriptView } from './subagentTranscriptView'
import { useTaskPane, type TaskPanePorts, type TaskPaneView } from './taskPaneStore'
import './taskView.css'

/**
 * One sub-agent, background shell or script run, mounted only while it is the active item of its
 * split. It follows the task while it runs and the tab is on screen; `TaskPaneStore` owns that cadence.
 */
export function TaskPane(props: {
  ref?: React.Ref<HTMLElement>
  item: PanelSplitTaskItem
  visible: boolean
  ports: TaskPanePorts
}): React.JSX.Element {
  const { sessionId, task } = props.item
  const view = useTaskPane({ sessionId, task }, props.ports, props.visible)

  return (
    <section className="task-pane" ref={props.ref} tabIndex={-1} aria-label={props.item.title}>
      {TaskPaneRead.bodyOf(view, props.item, props.ports)}
    </section>
  )
}

class TaskPaneRead {
  static bodyOf(view: TaskPaneView, item: PanelSplitTaskItem, ports: TaskPanePorts): React.JSX.Element {
    switch (view.kind) {
      case 'loading': return <p className="task-pane__note">{TaskPaneRead.loadingOf(item.task)}</p>
      case 'failed': return <p className="task-pane__note task-pane__note--failed">{view.reason}</p>
      case 'none': return <p className="task-pane__note">{view.reason}</p>
      case 'transcript': return <SubagentTranscriptView transcript={view} />
      case 'output': return <ShellOutputView output={view} />
      case 'script':
        if (item.task.kind !== 'script') throw new Error('Script output requires a script task')
        return <ScriptOutputView output={view.output} title={item.title} runId={item.task.runId} error={view.error} openTerminal={ports.openTerminal} />
      default: throw new Error(`Unknown task view: ${JSON.stringify(view satisfies never)}`)
    }
  }

  private static loadingOf(task: PanelSplitTaskItem['task']): string {
    switch (task.kind) {
      case 'subagent': return 'Reading the sub-agent…'
      case 'shell': return 'Reading the shell output…'
      case 'script': return 'Reading the script output…'
      default: throw new Error(`Unknown session task: ${JSON.stringify(task satisfies never)}`)
    }
  }
}
