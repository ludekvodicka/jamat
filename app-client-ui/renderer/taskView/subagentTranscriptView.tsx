import { useLayoutEffect, useRef, useState } from 'react'

import type {
  SessionSubagentEntry,
  SessionSubagentHeader,
  SessionSubagentTranscript,
} from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { SessionTaskGlyphs } from '../views/sessionsTree/sessionTaskRows'
import './taskView.css'

/**
 * One sub-agent's transcript. Every text in it is the agent's or a tool's own, so it is drawn as
 * plain text, never as Markdown or HTML, with terminal control sequences removed.
 */
export function SubagentTranscriptView(props: {
  transcript: Extract<SessionSubagentTranscript, { kind: 'transcript' }>
}): React.JSX.Element {
  const { transcript } = props
  const entries = useRef<HTMLDivElement | null>(null)
  // Null until the first draw: a running agent opens at its latest step, a settled one at its prompt.
  const stick = useRef<boolean | null>(null)
  const running = transcript.header.state === 'running'

  useLayoutEffect(() => {
    const element = entries.current
    if (element === null) return
    if (stick.current === null) stick.current = running
    if (stick.current) element.scrollTop = element.scrollHeight
  }, [transcript, running])

  const prompt = transcript.entries.filter((entry) => entry.kind === 'prompt')
  const steps = transcript.entries.filter((entry) => entry.kind !== 'prompt')
  const step = running ? SubagentTranscriptText.stepOf(steps) : null
  return (
    <div className="task-view">
      <SubagentTranscriptHeader header={transcript.header} />
      <div
        className="task-view__entries"
        ref={entries}
        onScroll={(event) => {
          const element = event.currentTarget
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight
            <= SubagentTranscriptText.bottomSlackPixelsConst
        }}
      >
        {prompt.map((entry, index) => <SubagentTranscriptEntry key={`prompt-${index}`} entry={entry} />)}
        {transcript.earlierStepsOmitted && <p className="task-view__note">Earlier steps are not shown.</p>}
        {steps.map((entry, index) => <SubagentTranscriptEntry key={`step-${index}`} entry={entry} />)}
        {step !== null && <div className="task-view__step" data-testid="task-view-step">{step}</div>}
      </div>
    </div>
  )
}

function SubagentTranscriptHeader(props: { header: SessionSubagentHeader }): React.JSX.Element {
  const { header } = props
  const facts = [
    SessionTaskGlyphs.titleOf(header.state),
    header.model,
    header.contextTokens === null ? null : `${header.contextTokens.toLocaleString('en-US')} context tokens`,
  ].filter((fact): fact is string => fact !== null)
  return (
    <header className="task-view__header">
      <div className="task-view__title">
        {header.description === '' || header.description === header.agentType
          ? header.agentType
          : `${header.agentType}: ${header.description}`}
      </div>
      <div className="task-view__facts" data-state={header.state}>{facts.join(' · ')}</div>
    </header>
  )
}

export function SubagentTranscriptEntry(props: { entry: SessionSubagentEntry }): React.JSX.Element {
  const { entry } = props
  switch (entry.kind) {
    case 'prompt':
      return (
        <div className="task-view__entry task-view__entry--prompt">
          <div className="task-view__label">Prompt</div>
          <div className="task-view__text">{SubagentTranscriptText.plainOf(entry.text)}</div>
          {entry.truncated && <div className="task-view__cut">The rest of this text is cut.</div>}
        </div>
      )
    case 'message':
      return (
        <div className="task-view__entry task-view__entry--message" data-role={entry.role}>
          <div className="task-view__label">{SubagentTranscriptText.roleOf(entry.role)}</div>
          <div className="task-view__text">{SubagentTranscriptText.plainOf(entry.text)}</div>
          {entry.truncated && <div className="task-view__cut">The rest of this text is cut.</div>}
        </div>
      )
    case 'tool':
      return (
        <div className="task-view__entry task-view__entry--tool" data-failed={entry.failed || undefined}>
          <div className="task-view__line">
            <span className="task-view__tool">{entry.tool}</span>
            <span className="task-view__summary">{SubagentTranscriptText.plainOf(entry.summary)}</span>
            {entry.failed && <span className="task-view__failed">failed</span>}
          </div>
          {entry.output !== null && <SubagentOutputPreview text={SubagentTranscriptText.plainOf(entry.output)} />}
          {entry.outputTruncated && <div className="task-view__cut">The rest of this output is cut.</div>}
        </div>
      )
    case 'edit':
      return (
        <div className="task-view__entry task-view__entry--edit">
          <div className="task-view__line">
            <span className="task-view__tool">Edit</span>
            <span className="task-view__summary">{entry.path}</span>
            <span className="task-view__added">+{entry.added}</span>
            <span className="task-view__removed">-{entry.removed}</span>
          </div>
          {entry.preview !== '' && <SubagentEditPreview preview={SubagentTranscriptText.plainOf(entry.preview)} />}
        </div>
      )
    case 'thinking':
      return <div className="task-view__marker">Thinking</div>
    case 'compact':
      return <div className="task-view__divider" role="separator">Context compacted</div>
    case 'interrupted':
      return <div className="task-view__marker task-view__marker--stop">Interrupted by the user</div>
    case 'encrypted':
      return <div className="task-view__marker">encrypted message</div>
    case 'error':
      return (
        <div className="task-view__entry task-view__entry--error">
          <div className="task-view__label">Error</div>
          <div className="task-view__text">{SubagentTranscriptText.plainOf(entry.text)}</div>
        </div>
      )
    default: throw new Error(`Unknown sub-agent entry: ${JSON.stringify(entry satisfies never)}`)
  }
}

function SubagentOutputPreview(props: { text: string }): React.JSX.Element {
  const [all, setAll] = useState(false)
  const lines = props.text.split('\n')
  const long = lines.length > SubagentTranscriptText.outputLinesConst
  const shown = long && !all ? lines.slice(0, SubagentTranscriptText.outputLinesConst).join('\n') : props.text
  return (
    <>
      <pre className="task-view__output">{shown}</pre>
      {long && (
        <button type="button" className="task-view__more" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </>
  )
}

function SubagentEditPreview(props: { preview: string }): React.JSX.Element {
  return (
    <pre className="task-view__output task-view__output--diff">
      {props.preview.split('\n').map((line, index) => (
        <span key={index} className="task-view__diff-line" data-sign={SubagentTranscriptText.signOf(line)}>{line}{'\n'}</span>
      ))}
    </pre>
  )
}

export class SubagentTranscriptText {
  static readonly outputLinesConst = 20
  /** How near the bottom still counts as at the bottom: a fractional scroll position never reaches 0. */
  static readonly bottomSlackPixelsConst = 24
  // CSI, OSC and the two-character escapes: what a tool's coloured output leaves in its text.
  private static readonly controlPatternConst = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g

  static plainOf(text: string): string {
    return text.replace(SubagentTranscriptText.controlPatternConst, '')
  }

  static roleOf(role: Extract<SessionSubagentEntry, { kind: 'message' }>['role']): string {
    if (role === 'assistant') return 'Agent'
    else if (role === 'user') return 'User'
    else throw new Error(`Unknown message role: ${JSON.stringify(role satisfies never)}`)
  }

  static signOf(line: string): 'added' | 'removed' | 'context' {
    if (line.startsWith('+')) return 'added'
    else if (line.startsWith('-')) return 'removed'
    else return 'context'
  }

  /** What a running agent does now: the call still waiting for its result, else that it works. */
  static stepOf(steps: readonly SessionSubagentEntry[]): string {
    const last = steps.at(-1)
    if (last?.kind === 'tool' && last.output === null) return `Now: ${last.tool} ${SubagentTranscriptText.plainOf(last.summary)}`
    return 'Working…'
  }
}
