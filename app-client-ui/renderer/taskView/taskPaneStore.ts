import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionScriptOutput } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  SessionShellOutput,
  SessionSubagentTranscript,
} from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import type { TabControlTaskRef } from '../../shared/tabControl'

export interface TaskPaneTarget {
  sessionId: string
  task: TabControlTaskRef
}

type TaskPaneReply<T> = Promise<IpcResult<RemoteControlStepResult<T>>>

export interface TaskPanePorts {
  transcript(request: { sessionId: string; subagentId: string; known?: string }): TaskPaneReply<SessionSubagentTranscript>
  shellOutput(request: { sessionId: string; shellId: string; known?: string }): TaskPaneReply<SessionShellOutput>
  scriptOutput(request: { sessionId: string; runId: string }): TaskPaneReply<SessionScriptOutput>
}

export type TaskPaneView =
  | { kind: 'loading' }
  | { kind: 'failed'; reason: string }
  | { kind: 'none'; reason: string }
  | Extract<SessionSubagentTranscript, { kind: 'transcript' }>
  | Extract<SessionShellOutput, { kind: 'output' }>
  | { kind: 'script'; output: SessionScriptOutput; error?: string }

/**
 * The poll behind one open task item. It lives exactly as long as the item is the active one of
 * its split, so "another item became active" is `stop()`; it reads only while the tab is visible.
 *
 * Each read sends the revision it holds, so a view that did not move costs one stat in the library.
 * While the task runs it reads every 2 s; a read that finds it settled is the last one, and the
 * next read (the tab shown again, the item opened again) that finds it running again, a resumed
 * agent, starts the clock again. Script reads continue while the library answers live output, even
 * after the runtime ends, because collapse may happen later. The first saved-log answer stops them.
 */
export class TaskPaneStore {
  static readonly refreshMillisecondsConst = 2_000

  private readonly target: TaskPaneTarget
  private readonly ports: TaskPanePorts
  private readonly subscribers = new Set<() => void>()
  private view: TaskPaneView = { kind: 'loading' }
  private revision: string | null = null
  private visible: boolean
  private stopped = true
  private reading = false
  private scriptPending = true
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(target: TaskPaneTarget, ports: TaskPanePorts, visible: boolean) {
    this.target = target
    this.ports = ports
    this.visible = visible
  }

  /** Arms the poll with one read and hands back the one function that disarms it. */
  start(): () => void {
    this.stopped = false
    void this.tick()
    return () => this.stop()
  }

  /** A tab shown again reads once at once; a hidden one reads nothing. */
  setVisible(visible: boolean): void {
    if (this.visible === visible)
      return
    this.visible = visible
    if (!visible) {
      this.clearTimer()
      return
    }
    void this.tick()
  }

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => {
      this.subscribers.delete(onChanged)
    }
  }

  /** Held rather than built per call: `useSyncExternalStore` reads this on every render. */
  current(): TaskPaneView {
    return this.view
  }

  private stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.visible || this.reading)
      return
    this.clearTimer()
    this.reading = true
    const next = await this.read()
    this.reading = false
    if (this.stopped)
      return
    if (next !== null) {
      this.view = next
      for (const subscriber of this.subscribers)
        subscriber()
    }
    if (!this.visible || !this.running())
      return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, TaskPaneStore.refreshMillisecondsConst)
  }

  /** The next view, or null for `unchanged`, which keeps what is drawn. */
  private async read(): Promise<TaskPaneView | null> {
    const known = this.revision === null ? {} : { known: this.revision }
    const { sessionId, task } = this.target
    let answer: IpcResult<RemoteControlStepResult<SessionSubagentTranscript | SessionShellOutput>>
    try {
      switch (task.kind) {
        case 'subagent':
          answer = await this.ports.transcript({ sessionId, subagentId: task.subagentId, ...known })
          break
        case 'shell':
          answer = await this.ports.shellOutput({ sessionId, shellId: task.shellId, ...known })
          break
        case 'script': return this.readScript(sessionId, task.runId)
        default: throw new Error(`Unknown session task: ${JSON.stringify(task satisfies never)}`)
      }
    } catch (thrown) {
      return this.failed(ErrorText.of(thrown))
    }
    if (!answer.ok) return this.failed(answer.error)
    if (!answer.value.ok) return this.failed(answer.value.error.detail)
    const reading = answer.value.value
    switch (reading.kind) {
      case 'transcript':
      case 'output':
        this.revision = reading.revision
        return reading
      case 'unchanged': return null
      case 'none':
        this.revision = null
        return { kind: 'none', reason: reading.reason }
      default: throw new Error(`Unknown task reading: ${JSON.stringify(reading satisfies never)}`)
    }
  }

  private failed(reason: string): TaskPaneView {
    this.revision = null
    return { kind: 'failed', reason }
  }

  private async readScript(sessionId: string, runId: string): Promise<TaskPaneView> {
    try {
      const answer = await this.ports.scriptOutput({ sessionId, runId })
      if (!answer.ok) return this.scriptFailed(answer.error)
      if (!answer.value.ok)
        return this.scriptFailed(answer.value.error.detail, answer.value.error.code !== 'not-found')
      const output = answer.value.value
      // A finished runtime may be read before the manager captures and collapses it.
      this.scriptPending = output.state === 'running' || output.source === 'live'
      return { kind: 'script', output }
    } catch (thrown) {
      return this.scriptFailed(ErrorText.of(thrown))
    }
  }

  private scriptFailed(reason: string, retry = true): TaskPaneView {
    this.scriptPending = retry
    return this.view.kind === 'script' ? { ...this.view, error: reason } : { kind: 'failed', reason }
  }

  private running(): boolean {
    if (this.target.task.kind === 'script') return this.scriptPending
    const view = this.view
    switch (view.kind) {
      case 'loading':
      case 'failed':
      case 'none': return false
      case 'transcript': return view.header.state === 'running'
      case 'output': return view.state === 'running'
      case 'script': return this.scriptPending
      default: throw new Error(`Unknown task view: ${JSON.stringify(view satisfies never)}`)
    }
  }

  private clearTimer(): void {
    if (this.timer !== null)
      clearTimeout(this.timer)
    this.timer = null
  }
}
