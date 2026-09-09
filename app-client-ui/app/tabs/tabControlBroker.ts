import { randomUUID } from 'node:crypto'

import type {
  RemoteControlStepResult,
  RemoteControlTabCommandDto,
  RemoteControlTabDto,
  RemoteControlTabOpenFileDto,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTabsPort } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { TabControlAck, TabControlCommand } from '../../shared/tabControl'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import type { WorkspacePanelIndex } from './workspacePanelIndex'
import type { TabFileOpenResolver } from './tabFileOpenResolver'

type TabControlBrokerDto = RemoteControlTabCommandDto | RemoteControlTabOpenFileDto
type TabControlBrokerResult = RemoteControlStepResult<TabControlBrokerDto>

interface PendingTabControlCommand {
  windowId: string
  command: TabControlCommand
  timer: ReturnType<typeof setTimeout>
  resolve(result: TabControlBrokerResult): void
}

export interface TabControlBrokerDeps {
  requestId?(): string
  timeoutMilliseconds?: number
}

export class TabControlBroker implements RemoteControlTabsPort {
  private static readonly timeoutMillisecondsConst = 5_000
  private readonly pending = new Map<string, PendingTabControlCommand>()
  private readonly requestId: () => string
  private readonly timeoutMilliseconds: number

  constructor(
    private readonly windows: WorkspaceWindows,
    private readonly index: WorkspacePanelIndex,
    private readonly fileOpenResolver: Pick<TabFileOpenResolver, 'resolve'>,
    deps?: TabControlBrokerDeps,
  ) {
    this.requestId = deps?.requestId ?? randomUUID
    this.timeoutMilliseconds = deps?.timeoutMilliseconds
      ?? TabControlBroker.timeoutMillisecondsConst
  }

  async list(): Promise<readonly RemoteControlTabDto[]> {
    return this.index.snapshot().map((panel) => ({
      ...panel,
      params: { ...panel.params },
    }))
  }

  async open(
    sessionId: string,
    tabTitle: string,
    options: { plain: boolean },
  ): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    try {
      this.windows.focusOrRecreate('main')
    } catch {
      return TabControlBroker.error('unavailable', 'The main workspace window is unavailable')
    }
    return this.request('main', {
      kind: 'open-session',
      requestId: this.requestId(),
      sessionId,
      tabTitle,
      plain: options.plain,
    })
  }

  async focus(panelId: string): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    const windowId = this.index.ownerOf(panelId)
    if (windowId === null)
      return TabControlBroker.error('not-found', `No tab ${JSON.stringify(panelId)}`)
    try {
      this.windows.focusOrRecreate(windowId)
    } catch {
      return TabControlBroker.error('unavailable', 'The tab owner window is unavailable')
    }
    return this.request(windowId, {
      kind: 'focus-panel',
      requestId: this.requestId(),
      panelId,
    })
  }

  async openFile(
    sessionId: string,
    tabTitle: string,
    path: string,
    options: { plain: boolean },
  ): Promise<RemoteControlStepResult<RemoteControlTabOpenFileDto>> {
    const proven = await this.fileOpenResolver.resolve(sessionId, path)
    if (!proven.ok)
      return TabControlBroker.error(proven.code, proven.detail)
    const opened = await this.open(sessionId, tabTitle, options)
    if (!opened.ok)
      return { ok: false, error: opened.error }
    return this.request(opened.value.windowId, {
      kind: 'open-file',
      requestId: this.requestId(),
      panelId: opened.value.panelId,
      source: proven.source,
      documentKey: proven.documentKey,
      title: proven.title,
    })
  }

  async close(panelId: string): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    const windowId = this.index.ownerOf(panelId)
    if (windowId === null)
      return TabControlBroker.error('not-found', `No tab ${JSON.stringify(panelId)}`)
    return this.request(windowId, {
      kind: 'close-panel',
      requestId: this.requestId(),
      panelId,
    })
  }

  acknowledge(windowId: string, ack: TabControlAck): void {
    const pending = this.pending.get(ack.requestId)
    if (!pending)
      return
    if (pending.windowId !== windowId)
      throw new Error(`Tab control acknowledgement came from the wrong window: ${windowId}`)
    let result: TabControlBrokerResult
    try {
      result = TabControlBroker.resultOf(pending, ack)
    } catch {
      result = TabControlBroker.error(
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
          TabControlBroker.error('unavailable', 'The workspace renderer was reloaded'),
        )
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()])
      this.finish(
        requestId,
        TabControlBroker.error('unavailable', 'The AppClientUI process is stopping'),
      )
  }

  private request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-file' }>,
  ): Promise<RemoteControlStepResult<RemoteControlTabOpenFileDto>>
  private request(
    windowId: string,
    command: Exclude<TabControlCommand, { kind: 'open-file' }>,
  ): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>>
  private request(
    windowId: string,
    command: TabControlCommand,
  ): Promise<TabControlBrokerResult> {
    if (!this.windows.acceptsWindow(windowId))
      return Promise.resolve(TabControlBroker.error(
        'unavailable',
        'The workspace renderer is unavailable',
      ))
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(
        command.requestId,
        TabControlBroker.error('timeout', 'The workspace renderer did not confirm the tab command'),
      ), this.timeoutMilliseconds)
      this.pending.set(command.requestId, { windowId, command, timer, resolve })
      void this.publish(windowId, command)
    })
  }

  private async publish(windowId: string, command: TabControlCommand): Promise<void> {
    try {
      await this.windows.whenRendererReady(windowId)
      if (!this.pending.has(command.requestId))
        return
      if (!this.windows.acceptsWindow(windowId))
        throw new Error('Workspace renderer is not accepting commands')
      this.windows.publishTo(windowId, 'tabs:control-command', command)
    } catch {
      this.finish(
        command.requestId,
        TabControlBroker.error('unavailable', 'The workspace renderer is unavailable'),
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
      return TabControlBroker.error('operation-failed', result.detail)
    if (pending.command.kind === 'open-session') {
      if (result.kind === 'opened')
        return TabControlBroker.success({
          kind: 'opened',
          panelId: result.panelId,
          windowId: pending.windowId,
        })
      else if (result.kind === 'focused-existing')
        return TabControlBroker.success({
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
        return TabControlBroker.success({
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
        return TabControlBroker.success({
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
        return TabControlBroker.success({
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
