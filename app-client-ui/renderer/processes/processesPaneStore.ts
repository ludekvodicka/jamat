import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionTaskListing, SessionTaskRow } from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'

export interface ProcessesPaneTaskPorts {
  listTasks(sessionIds: readonly string[]): Promise<IpcResult<RemoteControlStepResult<Record<string, SessionTaskListing>>>>
  scriptLastLines(sessionId: string): Promise<IpcResult<RemoteControlStepResult<readonly { runId: string; line: string | null }[]>>>
}

export interface ProcessesPaneTasksState {
  rows: readonly SessionTaskRow[]
  serviceLines: ReadonlyMap<string, string | null>
  error: string | null
}

type ProcessesTaskRead =
  | { kind: 'rows'; rows: readonly SessionTaskRow[] }
  | { kind: 'error'; message: string }

type ServiceLinesRead =
  | { kind: 'lines'; lines: readonly { runId: string; line: string | null }[] }
  | { kind: 'stop' }
  | { kind: 'retry' }

export function useProcessesPaneTasks(
  sessionId: string,
  ports: ProcessesPaneTaskPorts,
  visible: boolean,
  serviceRunning: boolean,
): ProcessesPaneTasksState {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const changed = (): void => setDocumentVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  const shown = visible && documentVisible
  const store = useMemo(() => new ProcessesPaneStore(sessionId, ports, shown, serviceRunning), [sessionId, ports])
  const state = useSyncExternalStore((changed) => store.subscribe(changed), () => store.current())
  useEffect(() => store.start(), [store])
  useEffect(() => store.setVisible(shown), [store, shown])
  useEffect(() => store.setServiceRunning(serviceRunning), [store, serviceRunning])
  return state
}

/**
 * Polls native background shells and sub-agents every 3 s while visible, and running services' last
 * output lines every 2 s while visible and a service runs, single-flight. Stops when hidden.
 */
export class ProcessesPaneStore {
  static readonly refreshMillisecondsConst = 3_000
  static readonly serviceLinesRefreshMillisecondsConst = 2_000

  private readonly sessionId: string
  private readonly ports: ProcessesPaneTaskPorts
  private readonly subscribers = new Set<() => void>()
  private state: ProcessesPaneTasksState = { rows: [], serviceLines: new Map(), error: null }
  private rowsPrint = '[]'
  private linesPrint = '[]'
  private visible: boolean
  private serviceRunning: boolean
  private stopped = true
  private reading = false
  private readingLines = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private linesTimer: ReturnType<typeof setTimeout> | null = null

  constructor(sessionId: string, ports: ProcessesPaneTaskPorts, visible: boolean, serviceRunning = false) {
    this.sessionId = sessionId
    this.ports = ports
    this.visible = visible
    this.serviceRunning = serviceRunning
  }

  /** Arms the polls and returns their teardown function. */
  start(): () => void {
    this.stopped = false
    void this.tick()
    void this.tickLines()
    return () => this.stop()
  }

  /** Showing the pane reads at once; hiding it clears both timers and stops polling. */
  setVisible(visible: boolean): void {
    if (this.visible === visible)
      return
    this.visible = visible
    if (!visible) {
      this.clearTimer()
      this.clearLinesTimer()
      return
    }
    void this.tick()
    void this.tickLines()
  }

  /** Starts the 2 s last-line poll once a service runs, and stops/clears lines once none runs. */
  setServiceRunning(serviceRunning: boolean): void {
    if (this.serviceRunning === serviceRunning)
      return
    this.serviceRunning = serviceRunning
    if (!serviceRunning) {
      this.clearLinesTimer()
      if (this.state.serviceLines.size > 0) {
        this.linesPrint = '[]'
        this.state = { ...this.state, serviceLines: new Map() }
        this.publish()
      }
      return
    }
    void this.tickLines()
  }

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => {
      this.subscribers.delete(onChanged)
    }
  }

  /** Held rather than built per call: `useSyncExternalStore` reads this on every render. */
  current(): ProcessesPaneTasksState {
    return this.state
  }

  private stop(): void {
    this.stopped = true
    this.clearTimer()
    this.clearLinesTimer()
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.visible || this.reading)
      return
    this.clearTimer()
    this.reading = true
    const result = await this.read()
    this.reading = false
    if (this.stopped)
      return
    this.apply(result)
    if (!this.visible)
      return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, ProcessesPaneStore.refreshMillisecondsConst)
  }

  private async tickLines(): Promise<void> {
    if (this.stopped || !this.visible || !this.serviceRunning || this.readingLines)
      return
    this.clearLinesTimer()
    this.readingLines = true
    const result = await this.readLines()
    this.readingLines = false
    if (this.stopped)
      return
    switch (result.kind) {
      case 'lines':
        if (this.serviceRunning) this.applyLines(result.lines)
        break
      case 'stop':
        return
      case 'retry':
        break
      default:
        throw new Error(`Unknown service lines read result: ${JSON.stringify(result satisfies never)}`)
    }
    if (!this.visible || !this.serviceRunning)
      return
    this.linesTimer = setTimeout(() => {
      this.linesTimer = null
      void this.tickLines()
    }, ProcessesPaneStore.serviceLinesRefreshMillisecondsConst)
  }

  private async read(): Promise<ProcessesTaskRead> {
    try {
      const answer = await this.ports.listTasks([this.sessionId])
      if (!answer.ok) return { kind: 'error', message: `Reading processes: ${answer.error}` }
      if (!answer.value.ok) return { kind: 'error', message: `Reading processes: ${answer.value.error.detail}` }
      const listing = answer.value.value[this.sessionId]
      if (listing === undefined || listing.kind === 'none') return { kind: 'rows', rows: [] }
      else if (listing.kind === 'tasks') return { kind: 'rows', rows: listing.rows }
      else throw new Error(`Unknown session task listing: ${JSON.stringify(listing satisfies never)}`)
    } catch (thrown) {
      return { kind: 'error', message: `Reading processes: ${ErrorText.of(thrown)}` }
    }
  }

  private async readLines(): Promise<ServiceLinesRead> {
    try {
      const answer = await this.ports.scriptLastLines(this.sessionId)
      if (!answer.ok) return { kind: 'retry' }
      if (!answer.value.ok) return answer.value.error.code === 'not-found' ? { kind: 'stop' } : { kind: 'retry' }
      return { kind: 'lines', lines: answer.value.value }
    } catch {
      return { kind: 'retry' }
    }
  }

  private apply(result: ProcessesTaskRead): void {
    switch (result.kind) {
      case 'rows': {
        const print = JSON.stringify(result.rows)
        if (print === this.rowsPrint && this.state.error === null) return
        const rows = print === this.rowsPrint ? this.state.rows : result.rows
        this.rowsPrint = print
        this.state = { ...this.state, rows, error: null }
        this.publish()
        return
      }
      case 'error': {
        if (this.state.error === result.message) return
        this.state = { ...this.state, error: result.message }
        this.publish()
        return
      }
      default:
        throw new Error(`Unknown processes read result: ${JSON.stringify(result satisfies never)}`)
    }
  }

  private applyLines(lines: readonly { runId: string; line: string | null }[]): void {
    const entries = lines.map((entry) => [entry.runId, entry.line] as const)
    const print = JSON.stringify(entries)
    if (print === this.linesPrint) return
    this.linesPrint = print
    this.state = { ...this.state, serviceLines: new Map(entries) }
    this.publish()
  }

  private publish(): void {
    for (const subscriber of this.subscribers)
      subscriber()
  }

  private clearTimer(): void {
    if (this.timer !== null)
      clearTimeout(this.timer)
    this.timer = null
  }

  private clearLinesTimer(): void {
    if (this.linesTimer !== null)
      clearTimeout(this.linesTimer)
    this.linesTimer = null
  }
}
