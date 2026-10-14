import { useLayoutEffect, useRef, useState } from 'react'

import type { SessionScriptOutput, SessionScriptRunState } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../shared/errorText'
import { AppControl } from '../ipc/appControl'
import { SubagentTranscriptText } from './subagentTranscriptView'

export function ScriptOutputView(props: {
  output: SessionScriptOutput
  title: string
  runId: string
  error?: string
}): React.JSX.Element {
  const { output } = props
  const body = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const [openError, setOpenError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  useLayoutEffect(() => {
    const element = body.current
    if (element !== null && stick.current) element.scrollTop = element.scrollHeight
  }, [output])

  const openTerminal = async (): Promise<void> => {
    if (opening || output.terminal === null) return
    setOpening(true)
    setOpenError(null)
    try {
      const answer = await AppControl.call('tabs.open', { session: { kind: 'sessionId', sessionId: props.runId } })
      if (!answer.ok) setOpenError(answer.error)
      else if (!answer.value.ok) setOpenError(answer.value.error.detail)
    } catch (thrown) {
      setOpenError(ErrorText.of(thrown))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="task-view">
      <header className="task-view__header">
        <div className="task-view__title">{props.title}</div>
        <div className="task-view__facts" data-state={output.state}>
          {ScriptOutputText.stateOf(output.state)} · {ScriptOutputText.sourceOf(output.source)}
        </div>
        {output.terminal !== null && <button className="task-view__more" type="button" disabled={opening}
          onClick={() => { void openTerminal() }}>Open terminal</button>}
        {props.error !== undefined && <p className="task-view__note task-view__failed">{props.error}</p>}
        {openError !== null && <p className="task-view__note task-view__failed">{openError}</p>}
      </header>
      <div className="task-view__entries" ref={body} onScroll={(event) => {
        const element = event.currentTarget
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight
          <= SubagentTranscriptText.bottomSlackPixelsConst
      }}>
        {output.logReason !== undefined && <p className="task-view__note">{output.logReason}</p>}
        {output.lines.length === 0
          ? <p className="task-view__note">{output.state === 'running' ? 'No output yet.' : 'No output.'}</p>
          : <div className="task-view__text" data-testid="script-output-text">{output.lines.join('\n')}</div>}
      </div>
    </div>
  )
}

class ScriptOutputText {
  static stateOf(state: SessionScriptRunState): string {
    switch (state) {
      case 'running': return 'Running'
      case 'succeeded': return 'Succeeded'
      case 'failed': return 'Failed'
      case 'stopped': return 'Stopped'
      case 'lost': return 'Lost'
      default: throw new Error(`Unknown script state: ${JSON.stringify(state satisfies never)}`)
    }
  }

  static sourceOf(source: SessionScriptOutput['source']): string {
    switch (source) {
      case 'live': return 'Live output'
      case 'log': return 'Saved log'
      default: throw new Error(`Unknown script output source: ${JSON.stringify(source satisfies never)}`)
    }
  }
}
