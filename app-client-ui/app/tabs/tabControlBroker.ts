import { randomUUID } from 'node:crypto'

import type {
  RemoteControlStepResult,
  RemoteControlTabCommandDto,
  RemoteControlTabDto,
  RemoteControlTabOpenFileDto,
  RemoteControlTabOpenCommitDto,
  RemoteControlCommitStatusDto,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTabsPort } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { TabControlAck, TabControlCommand } from '../../shared/tabControl'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import type { WorkspacePanelIndex } from './workspacePanelIndex'
import type { TabFileOpenResolver } from './tabFileOpenResolver'
import type { VersioningCommitManager } from '../versioning/versioningCommitManager'

type TabControlBrokerDto = RemoteControlTabCommandDto | RemoteControlTabOpenFileDto | RemoteControlTabOpenCommitDto
type TabControlBrokerResult = RemoteControlStepResult<TabControlBrokerDto>

interface PendingTabControlCommand {
  windowId: string
  command: TabControlCommand
  timer: ReturnType<typeof setTimeout>
  resolve(result: TabControlBrokerResult): void
}

interface QueuedCommitReview {
  draftId: string
  command: Omit<Extract<TabControlCommand, { kind: 'open-commit' }>, 'requestId' | 'activate'>
}

interface CommitReviewSequence {
  previousPanelId: string | null
  openedAt: number
  reviews: QueuedCommitReview[]
}

export interface TabControlBrokerDeps {
  requestId?(): string
  timeoutMilliseconds?: number
  activateSessionOnCommit?(): boolean
  activateSessionOnDocument?(): boolean
  returnToPreviousSessionAfterCommit?(): boolean
  /** How long a recorded return stays valid, or null for no limit. */
  returnWindowMilliseconds?(): number | null
  now?(): number
}

export class TabControlBroker implements RemoteControlTabsPort {
  private static readonly timeoutMillisecondsConst = 5_000
  private readonly pending = new Map<string, PendingTabControlCommand>()
  private commitSequence: CommitReviewSequence | null = null
  private commitTurn: Promise<void> = Promise.resolve()
  private commitChangeQueued = false
  private stopping = false
  private readonly requestId: () => string
  private readonly timeoutMilliseconds: number
  private readonly windows: WorkspaceWindows
  private readonly index: WorkspacePanelIndex
  private readonly fileOpenResolver: Pick<TabFileOpenResolver, 'resolve'>
  private readonly commits: Pick<VersioningCommitManager, 'prepare' | 'attach' | 'releaseUnattached' | 'status' | 'cancel' | 'reviews'>
  private readonly deps: TabControlBrokerDeps | undefined

  constructor(
    windows: WorkspaceWindows,
    index: WorkspacePanelIndex,
    fileOpenResolver: Pick<TabFileOpenResolver, 'resolve'>,
    commits: Pick<VersioningCommitManager, 'prepare' | 'attach' | 'releaseUnattached' | 'status' | 'cancel' | 'reviews'>,
    deps?: TabControlBrokerDeps,
  ) {
    this.windows = windows
    this.index = index
    this.fileOpenResolver = fileOpenResolver
    this.commits = commits
    this.deps = deps
    this.requestId = deps?.requestId ?? randomUUID
    this.timeoutMilliseconds = deps?.timeoutMilliseconds
      ?? TabControlBroker.timeoutMillisecondsConst
  }

  async list(): Promise<readonly RemoteControlTabDto[]> {
    return this.index.snapshot().map((panel) => ({
      ...panel,
      params: { ...panel.params },
      ...(panel.sessionId === null ? {} : { commitReviews: this.commits.reviews(panel.sessionId, panel.windowId) }),
    }))
  }

  async openCommit(sessionId: string, tabTitle: string, vcs: 'svn' | 'git', scope: string | null,
    proposal: string | null, options: { plain: boolean; showRefusal?: true; paths?: readonly string[] }): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>> {
    return this.withCommitTurn(() => this.openCommitNow(sessionId, tabTitle, vcs, scope, proposal, options))
  }

  private async openCommitNow(...args: Parameters<TabControlBroker['openCommit']>): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const [sessionId, tabTitle, vcs, scope, proposal, options] = args
    const prepared = await this.commits.prepare(sessionId, vcs, scope, proposal, options.paths)
    if (!prepared.ok && !(options.showRefusal && (prepared.code === 'no-working-copy' || prepared.code === 'store-worktree')))
      return TabControlBroker.error(prepared.code === 'unknown-session' ? 'not-found' : 'operation-failed', prepared.detail)
    const draftId = prepared.ok ? prepared.value.draftId : null
    try {
      if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
      const automatic = options.showRefusal !== true && (this.deps?.activateSessionOnCommit?.() ?? true)
      const activate = options.showRefusal === true || (automatic && this.commitSequence === null)
      const shouldReturn = automatic && (this.deps?.returnToPreviousSessionAfterCommit?.() ?? true)
      const previousPanelId = shouldReturn ? this.activePanel(this.windows.lastFocusedWorkspace()?.windowId) : null
      const existing = this.index.panelsOfSession(sessionId)[0]
      const opened = existing === undefined
        ? await this.open(sessionId, tabTitle, { ...options, activate })
        : { ok: true as const, value: { windowId: existing.windowId, panelId: existing.panel.panelId } }
      if (!opened.ok) return opened
      if (activate) this.windows.focusOrRecreate(opened.value.windowId)
      const command: QueuedCommitReview['command'] = {
        kind: 'open-commit', panelId: opened.value.panelId, vcs,
        scopeRoot: prepared.ok ? prepared.value.scopeRoot : scope ?? '.',
        ...(prepared.ok && prepared.value.paths !== undefined ? { paths: prepared.value.paths } : {}),
        title: prepared.ok ? prepared.value.title : `Commit ${vcs.toUpperCase()}`,
        messageApplied: prepared.ok && prepared.messageApplied,
      }
      const result = await this.request(opened.value.windowId, { ...command, requestId: this.requestId(), activate })
      if (result.ok && draftId !== null) {
        this.commits.attach(draftId, result.value.windowId)
        const panelId = result.value.panelId
        if (automatic) {
          this.commitSequence ??= { previousPanelId: previousPanelId !== panelId ? previousPanelId : null,
            openedAt: this.now(), reviews: [] }
          if (!this.commitSequence.reviews.some((review) => review.draftId === draftId))
            this.commitSequence.reviews.push({ draftId, command: { ...command, panelId } })
          this.commitsChanged()
        }
      }
      return result.ok && draftId !== null ? { ok: true, value: { ...result.value, commitSessionId: draftId } } : result
    } finally { if (draftId !== null) this.commits.releaseUnattached(draftId) }
  }

  commitStatus(commitSessionId: string): RemoteControlStepResult<RemoteControlCommitStatusDto> {
    const value = this.commits.status(commitSessionId)
    return value === null ? TabControlBroker.error('not-found', 'The commit session is unknown or expired; its outcome is unknown') : { ok: true, value }
  }

  cancelCommit(commitSessionId: string): Promise<RemoteControlStepResult<RemoteControlCommitStatusDto>> {
    return this.withCommitTurn(() => this.stopping
      ? Promise.resolve(TabControlBroker.error('unavailable', 'The AppClientUI process is stopping'))
      : this.commits.cancel(commitSessionId))
  }

  commitsChanged(): void {
    if (this.commitChangeQueued || this.stopping) return
    this.commitChangeQueued = true
    void this.withCommitTurn(async () => {
      this.commitChangeQueued = false
      await this.advanceCommits()
    })
  }

  private async advanceCommits(): Promise<void> {
    const sequence = this.commitSequence
    const current = sequence?.reviews[0]
    if (sequence === null || current === undefined || this.stopping) return
    const status = this.commits.status(current.draftId)
    if (status !== null && !TabControlBroker.reviewFinished(status)) return
    // Completing a background review must not take focus from the person's current work.
    if (status === null || this.activePanel(this.windows.focusedWorkspace()?.windowId) !== current.command.panelId) {
      this.commitSequence = null
      return
    }
    sequence.reviews.shift()
    while (sequence.reviews.length > 0) {
      const next = sequence.reviews[0]
      const nextStatus = this.commits.status(next.draftId)
      const windowId = this.index.ownerOf(next.command.panelId)
      if (nextStatus === null || TabControlBroker.reviewFinished(nextStatus) || windowId === null) {
        sequence.reviews.shift()
        continue
      }
      if (this.deps?.activateSessionOnCommit?.() === false) {
        this.commitSequence = null
        return
      }
      try { this.windows.focusOrRecreate(windowId) }
      catch { this.commitSequence = null; return }
      const result = await this.request(windowId, { ...next.command, requestId: this.requestId(), activate: true, existingOnly: true, messageApplied: false })
      if (!result.ok) this.commitSequence = null
      return
    }
    this.commitSequence = null
    if (sequence.previousPanelId === null || this.deps?.returnToPreviousSessionAfterCommit?.() === false) return
    const window = this.deps?.returnWindowMilliseconds?.() ?? null
    if (window !== null && this.now() - sequence.openedAt > window) return
    await this.focus(sequence.previousPanelId)
  }

  private static reviewFinished(status: RemoteControlCommitStatusDto): boolean {
    if (status.state === 'committed') return true
    else if (status.state === 'running') return false
    else if (status.state === 'editing' || status.state === 'cancelled' || status.state === 'failed' || status.state === 'external-closed') return status.closed
    else throw new Error(`Unknown commit state: ${JSON.stringify(status.state)}`)
  }

  private withCommitTurn<T>(operation: () => Promise<T>): Promise<T> {
    // Keep arrival order through async prepare and renderer acknowledgements, including completion.
    const next = this.commitTurn.then(operation, operation)
    this.commitTurn = next.then(() => undefined, () => undefined)
    return next
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now()
  }

  private activePanel(windowId: string | undefined): string | null {
    return this.index.snapshot().find((panel) => panel.windowId === windowId && panel.active)?.panelId ?? null
  }

  async open(
    sessionId: string,
    tabTitle: string,
    options: { plain: boolean; activate?: boolean },
  ): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    try {
      if (options.activate !== false) this.windows.focusOrRecreate('main')
    } catch {
      return TabControlBroker.error('unavailable', 'The main workspace window is unavailable')
    }
    return this.request('main', {
      kind: 'open-session',
      requestId: this.requestId(),
      sessionId,
      tabTitle,
      plain: options.plain,
      ...(options.activate === undefined ? {} : { activate: options.activate }),
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
    const activate = this.deps?.activateSessionOnDocument?.() ?? false
    const opened = await this.open(sessionId, tabTitle, { ...options, activate })
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
    this.stopping = true
    this.commitSequence = null
    for (const requestId of [...this.pending.keys()])
      this.finish(
        requestId,
        TabControlBroker.error('unavailable', 'The AppClientUI process is stopping'),
      )
  }

  private request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-commit' }>,
  ): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>>
  private request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-file' }>,
  ): Promise<RemoteControlStepResult<RemoteControlTabOpenFileDto>>
  private request(
    windowId: string,
    command: Exclude<TabControlCommand, { kind: 'open-file' | 'open-commit' }>,
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
    if (pending.command.kind === 'open-commit') {
      if (result.kind !== 'commit-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected commit result: ${JSON.stringify(result)}`)
      return TabControlBroker.success({ kind: 'commit-opened', panelId: result.panelId, windowId: pending.windowId,
        scopeRoot: pending.command.scopeRoot, messageApplied: pending.command.messageApplied })
    }
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
