import { useEffect, useState, useSyncExternalStore } from 'react'

import { AppControl } from '../ipc/appControl'
import type { PanelSplitTaskItem } from '../widgets/tabs/panelSplit'
import { ShellOutputView } from './shellOutputView'
import { ScriptOutputView } from './scriptOutputView'
import { SubagentTranscriptView } from './subagentTranscriptView'
import { TaskPaneStore, type TaskPaneView } from './taskPaneStore'
import './taskView.css'

/**
 * One sub-agent, background shell or script run, mounted only while it is the active item of its
 * split. It follows the task while it runs and the tab is on screen; `TaskPaneStore` owns that cadence.
 */
export function TaskPane(props: {
  ref?: React.Ref<HTMLElement>
  item: PanelSplitTaskItem
  visible: boolean
}): React.JSX.Element {
  const { sessionId, task } = props.item
  const documentVisible = useDocumentVisible()
  const shown = props.visible && documentVisible
  const [store] = useState(() => new TaskPaneStore(
    { sessionId, task },
    {
      transcript: (request) => AppControl.call('sessionTasks.transcript', request),
      shellOutput: (request) => AppControl.call('sessionTasks.shellOutput', request),
      scriptOutput: (request) => AppControl.call('sessions.scriptOutput', request),
    },
    shown,
  ))
  const view = useSyncExternalStore(
    (onChanged) => store.subscribe(onChanged),
    () => store.current(),
  )

  useEffect(() => store.start(), [store])
  useEffect(() => store.setVisible(shown), [store, shown])

  return (
    <section className="task-pane" ref={props.ref} tabIndex={-1} aria-label={props.item.title}>
      {TaskPaneRead.bodyOf(view, props.item)}
    </section>
  )
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const report = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', report)
    return () => document.removeEventListener('visibilitychange', report)
  }, [])
  return visible
}

class TaskPaneRead {
  static bodyOf(view: TaskPaneView, item: PanelSplitTaskItem): React.JSX.Element {
    switch (view.kind) {
      case 'loading': return <p className="task-pane__note">{TaskPaneRead.loadingOf(item.task)}</p>
      case 'failed': return <p className="task-pane__note task-pane__note--failed">{view.reason}</p>
      case 'none': return <p className="task-pane__note">{view.reason}</p>
      case 'transcript': return <SubagentTranscriptView transcript={view} />
      case 'output': return <ShellOutputView output={view} />
      case 'script':
        if (item.task.kind !== 'script') throw new Error('Script output requires a script task')
        return <ScriptOutputView output={view.output} title={item.title} runId={item.task.runId} error={view.error} />
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
