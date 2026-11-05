import type { RemoteControlStepResult, RemoteControlTabCommandDto, RemoteControlTabOpenFileDto, RemoteControlTabOpenCommitDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { TabControlCommand, TabControlAck, TabControlTaskOpenedDto, TabControlWorkflowOpenedDto, TabControlSnapinOpenedDto, TabControlBrokerDto, TabControlBrokerResult, TabRequestPort, TabPanelSnapshot, TabPanelOwner } from '../../../lib-orchestrator/shared/tabRequestPort.types'
import type { WorkspaceWindows } from './workspaceWindows'
import type { WorkspacePanelIndex } from '../tabs/workspacePanelIndex'

interface PendingTabControlCommand {
  windowId: string
  command: TabControlCommand
  timer: ReturnType<typeof setTimeout>
  resolve(result: TabControlBrokerResult): void
}

export class TabWindowRouter implements TabRequestPort {
  private readonly windows: WorkspaceWindows
  private readonly index: WorkspacePanelIndex
  private readonly timeoutMilliseconds: number
  private readonly pending: Map<string, PendingTabControlCommand>
  private stopping: boolean

  constructor(windows: WorkspaceWindows, index: WorkspacePanelIndex, timeoutMilliseconds = 5_000) {
    this.windows = windows
    this.index = index
    this.timeoutMilliseconds = timeoutMilliseconds
    this.pending = new Map()
    this.stopping = false
  }

  snapshot(): readonly TabPanelSnapshot[] { return this.index.snapshot() }
  ownerOf(panelId: string): string | null { return this.index.ownerOf(panelId) }
  panelsOfSession(sessionId: string): readonly TabPanelOwner[] { return this.index.panelsOfSession(sessionId) }
  panelsOfTerminalTarget(targetKey: string): readonly TabPanelOwner[] { return this.index.panelsOfTerminalTarget(targetKey) }
  lastFocusedWindowId(): string | null { return this.windows.lastFocusedWorkspace()?.windowId ?? null }

  acknowledge(windowId: string, ack: TabControlAck): void {
    const pending = this.pending.get(ack.requestId)
    if (!pending)
      return
    if (pending.windowId !== windowId)
      throw new Error(`Tab control acknowledgement came from the wrong window: ${windowId}`)
    let result: TabControlBrokerResult
    try {
      result = TabWindowRouter.resultOf(pending, ack)
    } catch {
      result = TabWindowRouter.error(
        'operation-failed',
        'The workspace renderer returned an invalid tab result',
      )
    }
    this.finish(ack.requestId, result)
  }

  rendererGone(windowId: string): void {
    for (const [requestId, pending] of this.pending)
      if (pending.windowId === windowId)
        this.finish(
          requestId,
          TabWindowRouter.error('unavailable', 'The workspace renderer was reloaded'),
        )
  }

  cancelAll(): void {
    this.stopping = true
    for (const requestId of [...this.pending.keys()])
      this.finish(
        requestId,
        TabWindowRouter.error('unavailable', 'The AppClientUI process is stopping'),
      )
  }

  request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-commit' }>,
  ): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>>
  request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-file' }>,
  ): Promise<RemoteControlStepResult<RemoteControlTabOpenFileDto>>
  request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-task' }>,
  ): Promise<RemoteControlStepResult<TabControlTaskOpenedDto>>
  request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-workflow' }>,
  ): Promise<RemoteControlStepResult<TabControlWorkflowOpenedDto>>
  request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-snapin' }>,
  ): Promise<RemoteControlStepResult<TabControlSnapinOpenedDto>>
  request(
    windowId: string,
    command: Exclude<TabControlCommand, { kind: 'open-file' | 'open-commit' | 'open-task' | 'open-workflow' | 'open-snapin' }>,
  ): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>>
  request(
    windowId: string,
    command: TabControlCommand,
  ): Promise<TabControlBrokerResult> {
    // Focus and pending registration share one native turn so a reload cannot fall between them.
    if (!this.stopping) {
      try {
        if (TabWindowRouter.shouldFocus(command)) this.windows.focusOrRecreate(windowId)
      } catch {
        let detail: string
        if (command.kind === 'open-session') detail = 'The main workspace window is unavailable'
        else if (command.kind === 'open-snapin') detail = 'The workspace window is unavailable'
        else if (command.kind === 'open-commit' || command.kind === 'open-task' || command.kind === 'open-workflow' || command.kind === 'focus-panel')
          detail = 'The tab owner window is unavailable'
        else if (command.kind === 'open-file' || command.kind === 'close-panel') throw new Error('A background tab command attempted to focus a window')
        else throw new Error(`Unknown tab control command: ${JSON.stringify(command satisfies never)}`)
        return Promise.resolve(TabWindowRouter.error('unavailable', detail))
      }
    }
    if (this.stopping || !this.windows.acceptsWindow(windowId))
      return Promise.resolve(TabWindowRouter.error(
        'unavailable',
        'The workspace renderer is unavailable',
      ))
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(
        command.requestId,
        TabWindowRouter.error('timeout', 'The workspace renderer did not confirm the tab command'),
      ), this.timeoutMilliseconds)
      this.pending.set(command.requestId, { windowId, command, timer, resolve })
      void this.publish(windowId, command)
    })
  }

  private async publish(windowId: string, command: TabControlCommand): Promise<void> {
    try {
      await this.windows.whenRendererReady(windowId)
      if (this.pending.get(command.requestId)?.command !== command)
        return
      if (!this.windows.acceptsWindow(windowId))
        throw new Error('Workspace renderer is not accepting commands')
      this.windows.publishTo(windowId, 'tabs:control-command', command)
    } catch {
      this.finish(
        command.requestId,
        TabWindowRouter.error('unavailable', 'The workspace renderer is unavailable'),
      )
    }
  }

  private finish(
    requestId: string,
    result: TabControlBrokerResult,
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending)
      return
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve(result)
  }

  private static resultOf(
    pending: PendingTabControlCommand,
    ack: TabControlAck,
  ): TabControlBrokerResult {
    const result = ack.result
    if (result.kind === 'failed')
      return TabWindowRouter.error('operation-failed', result.detail)
    if (pending.command.kind === 'open-snapin') {
      if (result.kind !== 'snapin-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected open-snapin result: ${JSON.stringify(result)}`)
      return TabWindowRouter.success({ kind: 'snapin-opened', panelId: result.panelId, windowId: pending.windowId })
    }
    if (pending.command.kind === 'open-commit') {
      if (result.kind !== 'commit-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected commit result: ${JSON.stringify(result)}`)
      return TabWindowRouter.success({ kind: 'commit-opened', panelId: result.panelId, windowId: pending.windowId,
        scopeRoot: pending.command.scopeRoot, messageApplied: pending.command.messageApplied })
    }
    if (pending.command.kind === 'open-task') {
      if (result.kind !== 'task-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected open-task result: ${JSON.stringify(result)}`)
      return TabWindowRouter.success({ kind: 'task-opened', panelId: result.panelId, windowId: pending.windowId })
    }
    if (pending.command.kind === 'open-workflow') {
      if (result.kind !== 'workflow-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected open-workflow result: ${JSON.stringify(result)}`)
      return TabWindowRouter.success({ kind: 'workflow-opened', panelId: result.panelId, windowId: pending.windowId })
    }
    if (pending.command.kind === 'open-session') {
      if (result.kind === 'opened')
        return TabWindowRouter.success({
          kind: 'opened',
          panelId: result.panelId,
          windowId: pending.windowId,
        })
      else if (result.kind === 'focused-existing')
        return TabWindowRouter.success({
          kind: 'focused-existing',
          panelId: result.panelId,
          windowId: result.windowId,
        })
      else if (result.kind === 'focused' || result.kind === 'closed'
        || result.kind === 'file-opened')
        throw new Error(`Unexpected open result: ${JSON.stringify(result)}`)
      else
        throw new Error(`Unknown open result: ${JSON.stringify(result)}`)
    } else if (pending.command.kind === 'focus-panel') {
      if (result.kind === 'focused')
        return TabWindowRouter.success({
          kind: 'focused-existing',
          panelId: result.panelId,
          windowId: pending.windowId,
        })
      else if (result.kind === 'opened'
        || result.kind === 'focused-existing'
        || result.kind === 'closed'
        || result.kind === 'file-opened')
        throw new Error(`Unexpected focus result: ${JSON.stringify(result)}`)
      else
        throw new Error(`Unknown focus result: ${JSON.stringify(result)}`)
    } else if (pending.command.kind === 'close-panel') {
      if (result.kind === 'closed')
        return TabWindowRouter.success({
          kind: 'closed',
          panelId: result.panelId,
          windowId: pending.windowId,
        })
      else if (result.kind === 'opened'
        || result.kind === 'focused-existing'
        || result.kind === 'focused'
        || result.kind === 'file-opened')
        throw new Error(`Unexpected close result: ${JSON.stringify(result)}`)
      else
        throw new Error(`Unknown close result: ${JSON.stringify(result)}`)
    } else if (pending.command.kind === 'open-file') {
      if (result.kind === 'file-opened') {
        if (result.panelId !== pending.command.panelId)
          throw new Error(`Open-file acknowledged another panel: ${JSON.stringify(result)}`)
        return TabWindowRouter.success({
          kind: 'file-opened',
          panelId: result.panelId,
          windowId: pending.windowId,
          path: pending.command.source.path,
        })
      } else if (result.kind === 'opened'
        || result.kind === 'focused-existing'
        || result.kind === 'focused'
        || result.kind === 'closed')
        throw new Error(`Unexpected open-file result: ${JSON.stringify(result)}`)
      else
        throw new Error(`Unknown open-file result: ${JSON.stringify(result)}`)
    } else
      throw new Error(`Unknown tab control command: ${JSON.stringify(pending.command)}`)
  }

  private static shouldFocus(command: TabControlCommand): boolean {
    if (command.kind === 'open-session' || command.kind === 'open-commit') return command.activate !== false
    else if (command.kind === 'focus-panel' || command.kind === 'open-snapin' || command.kind === 'open-task' || command.kind === 'open-workflow') return true
    else if (command.kind === 'open-file' || command.kind === 'close-panel') return false
    else throw new Error(`Unknown tab control command: ${JSON.stringify(command satisfies never)}`)
  }

  private static success<T extends TabControlBrokerDto>(value: T): RemoteControlStepResult<T> {
    return { ok: true, value }
  }

  private static error<T = never>(
    code: 'not-found' | 'unavailable' | 'timeout' | 'operation-failed',
    detail: string,
  ): RemoteControlStepResult<T> {
    return { ok: false, error: { code, detail } }
  }
}
