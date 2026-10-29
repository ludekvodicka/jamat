import { SessionWorkspaceKeys } from '../../shared/sessionWorkspace'
import { TabControlTask, type TabControlTaskRef } from '../../shared/tabControl'
import type { SessionOpen } from '../../shared/sessionViewItems'
import { createHash, randomUUID } from 'node:crypto'

import type {
  RemoteControlStepResult,
  RemoteControlTabCommandDto,
  RemoteControlTabDto,
  RemoteControlTabOpenFileDto,
  RemoteControlTabOpenCommitDto,
  RemoteControlCommitStatusDto,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTabsPort } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { TabControlAck, TabControlCommand, TabControlTaskItem } from '../../shared/tabControl'
import type { VersioningCommitDraftDto, VersioningCommitPath } from '../../shared/versioningCommit'
import { type TerminalTarget, TerminalTargetCodec } from '../../shared/terminalTarget'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import type { WorkspacePanelIndex } from './workspacePanelIndex'
import type { TabFileOpenResolver } from './tabFileOpenResolver'
import type { VersioningCommitManager } from '../versioning/versioningCommitManager'

/** A client-only answer: the task view is never a protocol operation, so it has no wire DTO. */
export interface TabControlTaskOpenedDto {
  kind: 'task-opened'
  panelId: string
  windowId: string
}

/** A client-only answer, like the task view's. */
export interface TabControlWorkflowOpenedDto {
  kind: 'workflow-opened'
  panelId: string
  windowId: string
}

export interface TabControlSnapinOpenedDto {
  kind: 'snapin-opened'
  panelId: string
  windowId: string
}

type TabControlBrokerDto = RemoteControlTabCommandDto | RemoteControlTabOpenFileDto | RemoteControlTabOpenCommitDto
  | TabControlTaskOpenedDto | TabControlWorkflowOpenedDto | TabControlSnapinOpenedDto
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
  /** The workflow an action's review returns to instead of the previous panel. */
  returnToWorkflow: TabControlWorkflowReturn | null
  openedAt: number
  reviews: QueuedCommitReview[]
}

/** The session whose workflow a review hands the focus back to, and the title its tab opens under. */
export interface TabControlWorkflowReturn {
  sessionId: string
  tabTitle: string
}

export interface TabControlBrokerDeps {
  recordOpen?(open: Omit<SessionOpen, 'sequence'>): Promise<SessionOpen>
  reportError?(message: string): void
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
  private readonly projectedOpens = new Set<string>()
  private readonly projectedReviews = new Map<string, RemoteControlCommitStatusDto>()
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
    proposal: string | null, options: {
      showRefusal?: true
      intentId?: string
      paths?: readonly VersioningCommitPath[]
      fresh?: true
      /** Type the review's close line into its session (the CLI opened it). */
      wakeOnClose?: true
      returnToWorkflow?: TabControlWorkflowReturn
    }): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>> {
    return this.withCommitTurn(() => this.openCommitNow(sessionId, tabTitle, vcs, scope, proposal, options))
  }

  private async openCommitNow(...args: Parameters<TabControlBroker['openCommit']>): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const [sessionId, tabTitle, vcs, scope, proposal, options] = args
    const prepared = await this.commits.prepare(sessionId, vcs, scope, proposal, options.paths,
      { ...options.fresh === undefined ? {} : { fresh: options.fresh }, ...options.wakeOnClose === undefined ? {} : { wakeOnClose: options.wakeOnClose } })
    if (!prepared.ok && !(options.showRefusal && prepared.code === 'no-working-copy'))
      return TabControlBroker.error(prepared.code === 'unknown-session' ? 'not-found' : 'operation-failed', prepared.detail)
    const draftId = prepared.ok ? prepared.value.draftId : null
    try {
      if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
      const automatic = options.showRefusal !== true && (this.deps?.activateSessionOnCommit?.() ?? true)
      const activePanelId = this.activePanel(this.windows.lastFocusedWorkspace()?.windowId)
      // An unfinished review left in another session must not suppress later activation requests.
      if (automatic && this.commitSequence?.reviews[0]?.command.panelId !== activePanelId)
        this.commitSequence = null
      const activate = options.showRefusal === true || (automatic && this.commitSequence === null)
      const shouldReturn = automatic && (this.deps?.returnToPreviousSessionAfterCommit?.() ?? true)
      const previousPanelId = shouldReturn ? activePanelId : null
      const existing = this.index.panelsOfSession(sessionId)[0]
      const opened = existing === undefined
        ? await this.open(sessionId, tabTitle, { ...options, activate })
        : { ok: true as const, value: { windowId: existing.windowId, panelId: existing.panel.panelId } }
      if (!opened.ok) return opened
      if (activate) this.windows.focusOrRecreate(opened.value.windowId)
      const command: QueuedCommitReview['command'] = {
        kind: 'open-commit', panelId: opened.value.panelId, vcs, ...(draftId ? { reviewId: draftId } : {}),
        scopeRoot: prepared.ok ? prepared.value.scopeRoot : scope ?? '.',
        ...(prepared.ok && prepared.value.paths !== undefined ? { paths: prepared.value.paths } : {}),
        title: prepared.ok ? prepared.value.title : `Commit ${vcs.toUpperCase()}`,
        messageApplied: prepared.ok && prepared.messageApplied,
      }
      const sharedOpen = draftId === null ? undefined : await this.recordOpen(sessionId, draftId, command.title, { kind: 'review', reviewId: draftId, vcs, scopeRoot: command.scopeRoot }, options.intentId)
      const result = await this.request(opened.value.windowId, { ...command, requestId: this.requestId(), activate, ...(sharedOpen ? { sharedOpen } : {}) })
      if (result.ok && draftId !== null) {
        this.commits.attach(draftId, result.value.windowId)
        const panelId = result.value.panelId
        if (automatic) {
          this.commitSequence ??= { previousPanelId: previousPanelId !== panelId ? previousPanelId : null,
            returnToWorkflow: shouldReturn ? options.returnToWorkflow ?? null : null, openedAt: this.now(), reviews: [] }
          if (!this.commitSequence.reviews.some((review) => review.draftId === draftId))
            this.commitSequence.reviews.push({ draftId, command: { ...command, panelId } })
          this.commitsChanged()
        }
      }
      return result.ok && draftId !== null ? { ok: true, value: { ...result.value, commitSessionId: draftId } } : result
    } finally { if (draftId !== null) this.commits.releaseUnattached(draftId) }
  }

  projectReview(target: TerminalTarget, draft: VersioningCommitDraftDto, itemKey: string, openId: string): Promise<void> {
    return this.withCommitTurn(async () => {
      const id = SessionWorkspaceKeys.of(target, draft.draftId)
      const intent = SessionWorkspaceKeys.of(target, openId)
      if (this.projectedOpens.has(intent) || this.stopping) return
      const owner = this.index.panelsOfTerminalTarget(TerminalTargetCodec.key(target))[0]
      if (!owner) return
      this.projectedOpens.add(intent)
      this.updateProjectedReview(target, draft, false)
      const automatic = this.deps?.activateSessionOnCommit?.() ?? true
      const active = this.activePanel(this.windows.lastFocusedWorkspace()?.windowId)
      if (automatic && this.commitSequence?.reviews[0]?.command.panelId !== active) this.commitSequence = null
      const activate = automatic && this.commitSequence === null
      const command: QueuedCommitReview['command'] = { kind: 'open-commit', panelId: owner.panel.panelId,
        target, reviewId: draft.draftId, openId, itemKey, vcs: draft.vcs, scopeRoot: draft.scopeRoot, paths: draft.paths,
        title: `Commit ${draft.vcs.toUpperCase()}`, messageApplied: false }
      if (activate) this.windows.focusOrRecreate(owner.windowId)
      const answer = await this.request(owner.windowId, { ...command, requestId: this.requestId(), activate })
      if (!answer.ok) { this.projectedReviews.delete(id); return }
      if (automatic) {
        this.commitSequence ??= { previousPanelId: active !== owner.panel.panelId ? active : null,
          returnToWorkflow: null, openedAt: this.now(), reviews: [] }
        if (!this.commitSequence.reviews.some((review) => review.draftId === id)) this.commitSequence.reviews.push({ draftId: id, command })
      }
      this.commitsChanged()
    })
  }

  updateProjectedReview(target: TerminalTarget, draft: VersioningCommitDraftDto, closed: boolean): void {
    const phase = draft.phase
    let state: RemoteControlCommitStatusDto['state']
    if (draft.externalReview === 'running') state = 'running'
    else if (phase.kind === 'done') state = 'committed'
    else if (phase.kind === 'cancelled') state = 'cancelled'
    else if (phase.kind === 'failed') state = 'failed'
    else if (phase.kind === 'running') state = 'running'
    else if (phase.kind === 'editing') state = 'editing'
    else throw new Error(`Unknown review phase: ${JSON.stringify(phase satisfies never)}`)
    const id = SessionWorkspaceKeys.of(target, draft.draftId)
    this.projectedReviews.set(id, { kind: 'commit-status', commitSessionId: id, sessionId: draft.sessionId,
      vcs: draft.vcs, scopeRoot: draft.scopeRoot, state, closed, revision: phase.kind === 'done' ? phase.revision : null,
      detail: phase.kind === 'failed' ? phase.detail : null })
    this.commitsChanged()
  }

  private reviewStatus(id: string): RemoteControlCommitStatusDto | null { return this.projectedReviews.get(id) ?? this.commits.status(id) }

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
    const status = this.reviewStatus(current.draftId)
    if (status !== null && !TabControlBroker.reviewFinished(status)) return
    // Completing a background review must not take focus from the person's current work.
    if (status === null || this.activePanel(this.windows.focusedWorkspace()?.windowId) !== current.command.panelId) {
      this.commitSequence = null
      return
    }
    sequence.reviews.shift()
    while (sequence.reviews.length > 0) {
      const next = sequence.reviews[0]
      const nextStatus = this.reviewStatus(next.draftId)
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
    if (this.deps?.returnToPreviousSessionAfterCommit?.() === false) return
    // An action's review goes back to its workflow, which goes on there, however long the review took.
    if (sequence.returnToWorkflow !== null) {
      await this.openWorkflow(sequence.returnToWorkflow.sessionId, sequence.returnToWorkflow.tabTitle)
      return
    }
    if (sequence.previousPanelId === null) return
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
    options?: { activate?: boolean },
  ): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    try {
      if (options?.activate !== false) this.windows.focusOrRecreate('main')
    } catch {
      return TabControlBroker.error('unavailable', 'The main workspace window is unavailable')
    }
    return this.request('main', {
      kind: 'open-session',
      requestId: this.requestId(),
      sessionId,
      tabTitle,
      ...(options?.activate === undefined ? {} : { activate: options.activate }),
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

  async openSnapin(kind: string, title: string): Promise<RemoteControlStepResult<TabControlSnapinOpenedDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const panelId = `snapin:${kind}`
    const windowId = this.index.ownerOf(panelId) ?? this.windows.lastFocusedWorkspace()?.windowId ?? 'main'
    try { this.windows.focusOrRecreate(windowId) }
    catch { return TabControlBroker.error('unavailable', 'The workspace window is unavailable') }
    return this.request(windowId, { kind: 'open-snapin', requestId: this.requestId(), panelId, snapinKind: kind, title })
  }

  async openFile(
    sessionId: string,
    tabTitle: string,
    path: string,
    intentId?: string,
  ): Promise<RemoteControlStepResult<RemoteControlTabOpenFileDto>> {
    const proven = await this.fileOpenResolver.resolve(sessionId, path)
    if (!proven.ok)
      return TabControlBroker.error(proven.code, proven.detail)
    const activate = this.deps?.activateSessionOnDocument?.() ?? false
    const opened = await this.open(sessionId, tabTitle, { activate })
    if (!opened.ok)
      return { ok: false, error: opened.error }
    const sharedOpen = await this.recordOpen(sessionId, proven.documentKey, proven.title, { kind: 'file', source: proven.source }, intentId)
    return this.request(opened.value.windowId, {
      ...(sharedOpen ? { sharedOpen } : {}),
      kind: 'open-file',
      requestId: this.requestId(),
      panelId: opened.value.panelId,
      source: proven.source,
      documentKey: proven.documentKey,
      title: proven.title,
    })
  }

  /**
   * A sub-agent's view in its parent's split, in whichever window holds the parent's tab. Asked for
   * by a click, so the tab comes forward and its window takes the focus, unlike a document an agent
   * opens in the background.
   */
  async openTask(
    tabTitle: string,
    item: TabControlTaskItem,
    intentId?: string,
  ): Promise<RemoteControlStepResult<TabControlTaskOpenedDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const existing = this.index.panelsOfSession(item.sessionId)[0]
    const opened = existing === undefined
      ? await this.open(item.sessionId, tabTitle, { activate: true })
      : { ok: true as const, value: { windowId: existing.windowId, panelId: existing.panel.panelId } }
    if (!opened.ok) return opened
    try {
      this.windows.focusOrRecreate(opened.value.windowId)
    } catch {
      return TabControlBroker.error('unavailable', 'The tab owner window is unavailable')
    }
    const sharedOpen = await this.recordOpen(item.sessionId, item.key, item.title, { kind: 'task', task: item.task }, intentId)
    return this.request(opened.value.windowId, {
      ...(sharedOpen ? { sharedOpen } : {}),
      kind: 'open-task',
      requestId: this.requestId(),
      panelId: opened.value.panelId,
      item,
    })
  }

  /**
   * The session's workflow item in its own tab, the path `openTask` takes: the tab is found or
   * opened, its window takes the focus, and the window makes the item active.
   */
  async openWorkflow(sessionId: string, tabTitle: string, intentId?: string): Promise<RemoteControlStepResult<TabControlWorkflowOpenedDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const existing = this.index.panelsOfSession(sessionId)[0]
    const opened = existing === undefined
      ? await this.open(sessionId, tabTitle, { activate: true })
      : { ok: true as const, value: { windowId: existing.windowId, panelId: existing.panel.panelId } }
    if (!opened.ok) return opened
    try {
      this.windows.focusOrRecreate(opened.value.windowId)
    } catch {
      return TabControlBroker.error('unavailable', 'The tab owner window is unavailable')
    }
    const sharedOpen = await this.recordOpen(sessionId, `workflow:${sessionId}`, 'Session actions', { kind: 'workflow' }, intentId)
    return this.request(opened.value.windowId, {
      ...(sharedOpen ? { sharedOpen } : {}),
      kind: 'open-workflow',
      requestId: this.requestId(),
      panelId: opened.value.panelId,
      sessionId,
    })
  }

  async openSessionTask(target: TerminalTarget, task: TabControlTaskRef, title: string): Promise<RemoteControlStepResult<TabControlTaskOpenedDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const owner = this.index.panelsOfTerminalTarget(TerminalTargetCodec.key(target))[0]
    if (!owner) return TabControlBroker.error('not-found', 'The session terminal is no longer open')
    try { this.windows.focusOrRecreate(owner.windowId) }
    catch { return TabControlBroker.error('unavailable', 'The tab owner window is unavailable') }
    const localKey = TabControlTask.keyOf(target.sessionId, task)
    const key = target.kind === 'remote' ? SessionWorkspaceKeys.of(target, localKey) : localKey
    return this.request(owner.windowId, { kind: 'open-task', requestId: this.requestId(), panelId: owner.panel.panelId,
      target, item: { key, sessionId: target.sessionId, task, title } })
  }

  async openSessionActions(target: TerminalTarget): Promise<RemoteControlStepResult<TabControlWorkflowOpenedDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const owner = this.index.panelsOfTerminalTarget(TerminalTargetCodec.key(target))[0]
    if (owner === undefined) return TabControlBroker.error('not-found', 'The session terminal is no longer open')
    try {
      this.windows.focusOrRecreate(owner.windowId)
    } catch {
      return TabControlBroker.error('unavailable', 'The tab owner window is unavailable')
    }
    return this.request(owner.windowId, { kind: 'open-workflow', requestId: this.requestId(),
      panelId: owner.panel.panelId, sessionId: target.sessionId, target })
  }

  private async recordOpen(sessionId: string, key: string, title: string, item: SessionOpen['item'], intentId?: string): Promise<SessionOpen | undefined> {
    try { return await this.deps?.recordOpen?.({ sessionId, key, title, item, openId: intentId === undefined ? randomUUID() : createHash('sha256').update(JSON.stringify([sessionId, intentId])).digest('hex') }) }
    catch (error) { this.deps?.reportError?.(String(error)); return undefined }
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
    command: Extract<TabControlCommand, { kind: 'open-task' }>,
  ): Promise<RemoteControlStepResult<TabControlTaskOpenedDto>>
  private request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-workflow' }>,
  ): Promise<RemoteControlStepResult<TabControlWorkflowOpenedDto>>
  private request(
    windowId: string,
    command: Extract<TabControlCommand, { kind: 'open-snapin' }>,
  ): Promise<RemoteControlStepResult<TabControlSnapinOpenedDto>>
  private request(
    windowId: string,
    command: Exclude<TabControlCommand, { kind: 'open-file' | 'open-commit' | 'open-task' | 'open-workflow' | 'open-snapin' }>,
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
    if (pending.command.kind === 'open-snapin') {
      if (result.kind !== 'snapin-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected open-snapin result: ${JSON.stringify(result)}`)
      return TabControlBroker.success({ kind: 'snapin-opened', panelId: result.panelId, windowId: pending.windowId })
    }
    if (pending.command.kind === 'open-commit') {
      if (result.kind !== 'commit-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected commit result: ${JSON.stringify(result)}`)
      return TabControlBroker.success({ kind: 'commit-opened', panelId: result.panelId, windowId: pending.windowId,
        scopeRoot: pending.command.scopeRoot, messageApplied: pending.command.messageApplied })
    }
    if (pending.command.kind === 'open-task') {
      if (result.kind !== 'task-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected open-task result: ${JSON.stringify(result)}`)
      return TabControlBroker.success({ kind: 'task-opened', panelId: result.panelId, windowId: pending.windowId })
    }
    if (pending.command.kind === 'open-workflow') {
      if (result.kind !== 'workflow-opened' || result.panelId !== pending.command.panelId)
        throw new Error(`Unexpected open-workflow result: ${JSON.stringify(result)}`)
      return TabControlBroker.success({ kind: 'workflow-opened', panelId: result.panelId, windowId: pending.windowId })
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
