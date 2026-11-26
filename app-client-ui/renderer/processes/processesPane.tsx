import { useCallback, useState } from 'react'

import type { SessionScriptRunInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ScriptDuration } from '../../../lib-orchestrator/sessionManager/scripts/scriptDuration'
import { SessionProcesses, type SessionProcess } from '../../../lib-orchestrator/sessionTasks/sessionProcesses'
import type {
  SessionShellRow,
  SessionShellState,
  SessionSubagentRow,
  SessionSubagentState,
} from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { ErrorText } from '../../shared/errorText'
import type { TabControlTaskRef } from '../../shared/tabControl'
import { AppControl } from '../ipc/appControl'
import { IpcFailure } from '../ipc/ipcFailure'
import { ElapsedText } from '../views/sessionsTree/elapsedText'
import { SessionNodeState, type SessionPaint } from '../views/sessionsTree/sessionNodeState'
import { SessionTaskGlyphs } from '../views/sessionsTree/sessionTaskRows'
import { SignalGlyph } from '../widgets/signalGlyph'
import { type ProcessesPaneTaskPorts, useProcessesPaneTasks } from './processesPaneStore'
import './processesPane.css'

export interface ProcessesPanePorts extends ProcessesPaneTaskPorts {
  stopRun(runId: string): Promise<string | null>
  removeRun(runId: string): Promise<string | null>
}

export class ProcessesPorts {
  /** Brings a local session's tab forward with Processes active; a failure is only reported. */
  static open(sessionId: string): void {
    void AppControl.call('sessionTasks.openProcesses', { sessionId })
      .then((answer) => {
        if (!answer.ok) AppClientUiReport.error(`Processes could not be opened: ${answer.error}`)
        else if (!answer.value.ok) AppClientUiReport.error(`Processes could not be opened: ${answer.value.error.detail}`)
      })
      .catch((error: unknown) => AppClientUiReport.error(`Processes could not be opened: ${ErrorText.of(error)}`))
  }

  static local(): ProcessesPanePorts {
    return {
      listTasks: (sessionIds) => AppControl.call('sessionTasks.list', { sessionIds: [...sessionIds] }),
      scriptLastLines: (sessionId) => AppControl.call('sessions.scriptLastLines', { sessionId }),
      stopRun: async (runId) => IpcFailure.sentenceOf(
        await AppControl.sessionsDone('sessions.finalize', { session: AppControl.sessionOf(runId), expect: 'stop' }),
        'Stop',
      ),
      removeRun: async (runId) => IpcFailure.sentenceOf(
        await AppControl.sessionsDone('sessions.remove', { session: AppControl.sessionOf(runId) }),
        'Remove',
      ),
    }
  }
}

export function ProcessesPane(props: {
  ref?: React.Ref<HTMLElement>
  sessionId: string
  runs: readonly SessionScriptRunInfo[]
  visible: boolean
  ports: ProcessesPanePorts
  onOpen(task: TabControlTaskRef, title: string): void
}): React.JSX.Element {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const serviceRunning = props.runs.some((run) => run.phase === 'inner' && run.scriptId === 'service' && run.state === 'running')
  const tasks = useProcessesPaneTasks(props.sessionId, props.ports, props.visible, serviceRunning)
  const runsById = new Map(props.runs.map((run) => [run.runId, run]))
  const shellsById = new Map<string, SessionShellRow>()
  const subagentsById = new Map<string, SessionSubagentRow>()
  for (const row of tasks.rows)
    switch (row.kind) {
      case 'shell': shellsById.set(row.shellId, row); break
      case 'subagent': subagentsById.set(row.subagentId, row); break
      default: throw new Error(`Unknown session task row: ${JSON.stringify(row satisfies never)}`)
    }
  const processes = SessionProcesses.listOf(props.runs, tasks.rows)
  const running = processes.filter((item) => item.running)
  const history = processes.filter((item) => !item.running)

  const perform = useCallback((runId: string, action: 'stop' | 'remove') => {
    const key = `${action}:${runId}`
    setBusy((current) => new Set(current).add(key))
    setError(null)
    const call = action === 'stop' ? props.ports.stopRun(runId) : props.ports.removeRun(runId)
    void call
      .then((failure) => { if (failure !== null) setError(failure) })
      .catch((thrown: unknown) => setError(`${action === 'stop' ? 'Stop' : 'Remove'} failed: ${ErrorText.of(thrown)}`))
      .finally(() => {
        setBusy((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      })
  }, [props.ports])

  const renderItem = (process: SessionProcess): React.JSX.Element | null => {
    const kind = process.kind
    if (kind === 'service' || kind === 'requested') {
      if (process.task.kind !== 'script') throw new Error(`Expected script task for ${kind}`)
      const run = runsById.get(process.task.runId)
      if (run === undefined) return null
      return (
        <RunRow
          key={`script:${run.runId}`}
          run={run}
          kind={kind}
          lastLine={kind === 'service' && run.state === 'running' ? tasks.serviceLines.get(run.runId) ?? null : null}
          stopping={busy.has(`stop:${run.runId}`)}
          removing={busy.has(`remove:${run.runId}`)}
          onOpen={() => props.onOpen(process.task, run.title)}
          onStop={() => perform(run.runId, 'stop')}
          onRemove={() => perform(run.runId, 'remove')}
        />
      )
    } else if (kind === 'shell') {
      if (process.task.kind !== 'shell') throw new Error('Expected shell task for shell')
      const row = shellsById.get(process.task.shellId)
      if (row === undefined) return null
      return (
        <ShellRow
          key={`shell:${row.shellId}`}
          row={row}
          onOpen={() => props.onOpen(process.task, ProcessesText.shellTitleOf(row))}
        />
      )
    } else if (kind === 'subagent') {
      if (process.task.kind !== 'subagent') throw new Error('Expected subagent task for subagent')
      const row = subagentsById.get(process.task.subagentId)
      if (row === undefined) return null
      return (
        <SubagentRow
          key={`subagent:${row.subagentId}`}
          row={row}
          onOpen={() => props.onOpen(process.task, ProcessesText.subagentTitleOf(row))}
        />
      )
    } else
      throw new Error(`Unknown process kind: ${JSON.stringify(kind satisfies never)}`)
  }

  return (
    <section className="processes-pane" ref={props.ref} tabIndex={-1} aria-label="Processes">
      {tasks.error !== null && <p className="processes-pane__error" role="alert">{tasks.error}</p>}
      {error !== null && <p className="processes-pane__error" role="alert">{error}</p>}
      {processes.length === 0 && <p className="processes-pane__empty">No processes in this session.</p>}
      {running.length > 0 && (
        <div className="processes-pane__section">
          <h3 className="processes-pane__heading">Running</h3>
          <ul className="processes-pane__list">{running.map(renderItem)}</ul>
        </div>
      )}
      {history.length > 0 && (
        <div className="processes-pane__section">
          <h3 className="processes-pane__heading">History</h3>
          <ul className="processes-pane__list">{history.map(renderItem)}</ul>
        </div>
      )}
    </section>
  )
}

function RunRow(props: {
  run: SessionScriptRunInfo
  kind: 'service' | 'requested'
  lastLine: string | null
  stopping: boolean
  removing: boolean
  onOpen(): void
  onStop(): void
  onRemove(): void
}): React.JSX.Element {
  const { run, kind } = props
  const running = run.state === 'running'
  const glyph = running && kind === 'service'
    ? SessionNodeState.characterOf('service', false)
    : SessionNodeState.runCharacterOf(run.state)
  const paint: SessionPaint = running && kind === 'service' ? 'ok' : SessionNodeState.runPaintOf(run.state)
  const detail = ProcessesText.runDetailOf(run)
  return (
    <li
      className="processes-pane__row"
      data-process-kind={kind}
      data-process-id={run.runId}
      data-state={run.state}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button')) return
        props.onOpen()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        props.onOpen()
      }}
    >
      <span className={`processes-pane__glyph processes-pane__glyph--paint-${paint}`} data-paint={paint} aria-hidden="true">
        <SignalGlyph glyph={glyph} />
      </span>
      <div className="processes-pane__body">
        <div className="processes-pane__line">
          <span className="processes-pane__title" title={run.title}>{run.title}</span>
          <span className="processes-pane__tag">{kind === 'service' ? 'service' : 'run'}</span>
        </div>
        {props.lastLine !== null && <div className="processes-pane__detail" title={props.lastLine}>{props.lastLine}</div>}
        <div className="processes-pane__meta">
          {running
            ? <><span>running · </span><ElapsedText startedAt={run.startedAt} /></>
            : <span>{detail}</span>}
        </div>
      </div>
      <div className="processes-pane__actions">
        {running && (
          <button
            type="button"
            className="processes-pane__button"
            disabled={props.stopping}
            onClick={(event) => { event.stopPropagation(); props.onStop() }}
          >
            Stop
          </button>
        )}
        {!running && run.row && (
          <button
            type="button"
            className="processes-pane__button"
            disabled={props.removing}
            onClick={(event) => { event.stopPropagation(); props.onRemove() }}
          >
            Remove
          </button>
        )}
      </div>
    </li>
  )
}

function ShellRow(props: { row: SessionShellRow; onOpen(): void }): React.JSX.Element {
  const { row } = props
  const paint = SessionTaskGlyphs.paintOf(row.state)
  const commandLabel = `$ ${row.command}`
  return (
    <li
      className="processes-pane__row"
      data-process-kind="shell"
      data-process-id={row.shellId}
      data-state={row.state}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        props.onOpen()
      }}
    >
      <span className={`processes-pane__glyph processes-pane__glyph--paint-${paint}`} data-paint={paint} aria-hidden="true">
        <SignalGlyph glyph={SessionTaskGlyphs.characterOf(row.state)} />
      </span>
      <div className="processes-pane__body">
        <div className="processes-pane__line">
          <span className="processes-pane__title processes-pane__title--mono" title={row.description ?? row.command}>
            {commandLabel}
          </span>
          <span className="processes-pane__tag">shell</span>
          {row.runs === 'agent' && (
            <span className="processes-pane__tag" title="Background shell running an agent">agent</span>
          )}
        </div>
        <div className="processes-pane__meta">
          {row.state === 'running'
            ? <><span>running · </span><ElapsedText startedAt={row.startedAt} /></>
            : <span>{ProcessesText.taskMetaOf(row.state, row.startedAt, row.endedAt)}</span>}
        </div>
      </div>
    </li>
  )
}

function SubagentRow(props: { row: SessionSubagentRow; onOpen(): void }): React.JSX.Element {
  const { row } = props
  const paint = SessionTaskGlyphs.paintOf(row.state)
  return (
    <li
      className="processes-pane__row"
      data-process-kind="subagent"
      data-process-id={row.subagentId}
      data-state={row.state}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        props.onOpen()
      }}
    >
      <span className={`processes-pane__glyph processes-pane__glyph--paint-${paint}`} data-paint={paint} aria-hidden="true">
        <SignalGlyph glyph={SessionTaskGlyphs.characterOf(row.state)} />
      </span>
      <div className="processes-pane__body">
        <div className="processes-pane__line">
          <span className="processes-pane__tag">{row.agentType}</span>
          <span className="processes-pane__title" title={row.description}>{row.description}</span>
        </div>
        {row.step !== null && <div className="processes-pane__detail" title={row.step}>{row.step}</div>}
        <div className="processes-pane__meta">
          {row.state === 'running'
            ? <><span>running · </span><ElapsedText startedAt={row.startedAt} /></>
            : <span>{ProcessesText.taskMetaOf(row.state, row.startedAt, row.endedAt)}</span>}
        </div>
      </div>
    </li>
  )
}

class ProcessesText {
  private static readonly titleMaxConst = 200

  /** Strips the repeated title prefix from the library summary, preserving `exited · exit 0` and `failed · exit 3 · 2 s`. */
  static runDetailOf(run: SessionScriptRunInfo): string {
    const prefix = `${run.title} · `
    return run.summary.startsWith(prefix) ? run.summary.slice(prefix.length) : run.summary
  }

  /** State word plus duration for native shells and sub-agents; neither carries an exit code. */
  static taskMetaOf(state: SessionShellState | SessionSubagentState, startedAt: number, endedAt: number | null): string {
    const word = SessionTaskGlyphs.titleOf(state).toLowerCase()
    return endedAt === null ? word : `${word} · ${ScriptDuration.text(Math.max(0, endedAt - startedAt))}`
  }

  static shellTitleOf(row: SessionShellRow): string {
    return ProcessesText.trim(`$ ${row.command}`)
  }

  static subagentTitleOf(row: SessionSubagentRow): string {
    return ProcessesText.trim(`${row.agentType}: ${row.description}`)
  }

  private static trim(title: string): string {
    return title.length <= ProcessesText.titleMaxConst ? title : `${title.slice(0, ProcessesText.titleMaxConst - 1)}…`
  }
}
