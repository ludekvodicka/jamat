import { SessionWorkspaceKeys } from '../../../lib-orchestrator/clientApi/sessionWorkspace'
import { TabControlTask, type TabControlTaskRef } from '../../../lib-orchestrator/clientApi/tabControl'
import type { SessionOpen } from '../../../lib-orchestrator/clientApi/sessionViewItems'
import { createHash, randomUUID } from 'node:crypto'

import type {
  RemoteControlStepResult,
  RemoteControlTabCommandDto,
  RemoteControlTabDto,
  RemoteControlTabOpenFileDto,
  RemoteControlTabOpenCommitDto,
  RemoteControlCommitStatusDto,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTabRequester, RemoteControlTabsPort } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { TabControlCommand, TabControlTaskItem } from '../../../lib-orchestrator/clientApi/tabControl'
import type { VersioningCommitDraftDto, VersioningCommitPath } from '../../../lib-orchestrator/versioning/versioningCommit'
import { type TerminalTarget, TerminalTargetCodec } from '../../../lib-orchestrator/clientApi/terminalTarget'
import type { TabFileOpenResolver } from './tabFileOpenResolver'
import type { VersioningCommitManager } from '../versioning/versioningCommitManager'
import type { AttentionEntry, AttentionQueue } from '../attention/attentionQueue'

import type { TabRequestPort, TabControlTaskOpenedDto, TabControlWorkflowOpenedDto, TabControlSnapinOpenedDto } from '../../../lib-orchestrator/shared/tabRequestPort.types'
export type { TabControlTaskOpenedDto, TabControlWorkflowOpenedDto, TabControlSnapinOpenedDto } from '../../../lib-orchestrator/shared/tabRequestPort.types'

type CommitReviewCommand = Omit<Extract<TabControlCommand, { kind: 'open-commit' }>, 'requestId' | 'activate'>

export interface TabControlBrokerDeps {
  recordOpen?(open: Omit<SessionOpen, 'sequence'>): Promise<SessionOpen>
  reportError?(message: string): void
  requestId?(): string
  activateSessionOnCommit?(): boolean
  activateSessionOnDocument?(): boolean
}

export class TabControlBroker implements RemoteControlTabsPort {
  private readonly projectedOpens: Set<string>
  private readonly projectedReviews: Map<string, RemoteControlCommitStatusDto>
  private commitTurn: Promise<void>
  private stopping: boolean
  private readonly requestId: () => string
  private readonly tabs: TabRequestPort
  private readonly fileOpenResolver: Pick<TabFileOpenResolver, 'resolve'>
  private readonly commits: Pick<VersioningCommitManager, 'prepare' | 'attach' | 'releaseUnattached' | 'status' | 'cancel' | 'reviews'>
  private readonly attention: Pick<AttentionQueue, 'add' | 'changed'>
  private readonly deps: TabControlBrokerDeps | undefined

  constructor(
    tabs: TabRequestPort,
    fileOpenResolver: Pick<TabFileOpenResolver, 'resolve'>,
    commits: Pick<VersioningCommitManager, 'prepare' | 'attach' | 'releaseUnattached' | 'status' | 'cancel' | 'reviews'>,
    attention: Pick<AttentionQueue, 'add' | 'changed'>,
    deps?: TabControlBrokerDeps,
  ) {
    this.projectedOpens = new Set()
    this.projectedReviews = new Map()
    this.commitTurn = Promise.resolve()
    this.stopping = false
    this.tabs = tabs
    this.fileOpenResolver = fileOpenResolver
    this.commits = commits
    this.attention = attention
    this.deps = deps
    this.requestId = deps?.requestId ?? randomUUID
  }

  async list(): Promise<readonly RemoteControlTabDto[]> {
    return this.tabs.snapshot().map((panel) => ({
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
      // A person's own open is in front at once; an agent's opens behind and waits in the attention queue.
      const activate = options.showRefusal === true
      const queued = !activate && (this.deps?.activateSessionOnCommit?.() ?? true)
      const existing = this.tabs.panelsOfSession(sessionId)[0]
      const opened = existing === undefined
        ? await this.openTab(sessionId, tabTitle, { activate })
        : { ok: true as const, value: { windowId: existing.windowId, panelId: existing.panel.panelId } }
      if (!opened.ok) return opened
      const command: CommitReviewCommand = {
        kind: 'open-commit', panelId: opened.value.panelId, vcs, ...(draftId ? { reviewId: draftId } : {}),
        scopeRoot: prepared.ok ? prepared.value.scopeRoot : scope ?? '.',
        ...(prepared.ok && prepared.value.paths !== undefined ? { paths: prepared.value.paths } : {}),
        title: prepared.ok ? prepared.value.title : `Commit ${vcs.toUpperCase()}`,
        messageApplied: prepared.ok && prepared.messageApplied,
      }
      const sharedOpen = draftId === null ? undefined : await this.recordOpen(sessionId, draftId, command.title, { kind: 'review', reviewId: draftId, vcs, scopeRoot: command.scopeRoot }, options.intentId)
      const result = await this.tabs.request(opened.value.windowId, { ...command, requestId: this.requestId(), activate, ...(sharedOpen ? { sharedOpen } : {}) })
      if (result.ok && draftId !== null) {
        this.commits.attach(draftId, result.value.windowId)
        if (queued) this.attention.add(this.reviewEntry(draftId, sessionId, tabTitle, { ...command, panelId: result.value.panelId }))
      }
      return result.ok && draftId !== null ? { ok: true, value: { ...result.value, commitSessionId: draftId } } : result
    } finally { if (draftId !== null) this.commits.releaseUnattached(draftId) }
  }

  projectReview(target: TerminalTarget, draft: VersioningCommitDraftDto, itemKey: string, openId: string): Promise<void> {
    return this.withCommitTurn(async () => {
      const id = SessionWorkspaceKeys.of(target, draft.draftId)
      const intent = SessionWorkspaceKeys.of(target, openId)
      if (this.projectedOpens.has(intent) || this.stopping) return
      const owner = this.tabs.panelsOfTerminalTarget(TerminalTargetCodec.key(target))[0]
      if (!owner) return
      this.projectedOpens.add(intent)
      this.updateProjectedReview(target, draft, false)
      const command: CommitReviewCommand = { kind: 'open-commit', panelId: owner.panel.panelId,
        target, reviewId: draft.draftId, openId, itemKey, vcs: draft.vcs, scopeRoot: draft.scopeRoot, paths: draft.paths,
        title: `Commit ${draft.vcs.toUpperCase()}`, messageApplied: false }
      const answer = await this.tabs.request(owner.windowId, { ...command, requestId: this.requestId(), activate: false })
      if (!answer.ok) { this.projectedReviews.delete(id); return }
      if (this.deps?.activateSessionOnCommit?.() ?? true) this.attention.add(this.reviewEntry(id, target.sessionId, owner.panel.title, command))
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

  /** A review changed: the attention queue reads whether the one in front of the person is done. */
  commitsChanged(): void {
    if (!this.stopping) this.attention.changed()
  }

  /**
   * A review waits in the attention queue until the person stops typing. It holds the queue while
   * the person is in it, and it is done once committed or closed; a failed or running commit keeps it.
   */
  private reviewEntry(draftId: string, sessionId: string, title: string, command: CommitReviewCommand): AttentionEntry {
    return { key: draftId, kind: 'commit-review', sessionId, title, automatic: true, holds: true,
      wanted: () => {
        const status = this.reviewStatus(draftId)
        return status !== null && !TabControlBroker.reviewFinished(status) && this.tabs.ownerOf(command.panelId) !== null
      },
      show: () => this.showReview(command) }
  }

  /** Selects the review already in its tab, in whichever window holds that tab now. */
  private async showReview(command: CommitReviewCommand): Promise<string | null> {
    const windowId = this.tabs.ownerOf(command.panelId)
    if (this.stopping || windowId === null) return null
    const result = await this.tabs.request(windowId, { ...command, requestId: this.requestId(), activate: true, existingOnly: true, messageApplied: false })
    return result.ok ? result.value.panelId : null
  }

  private static reviewFinished(status: RemoteControlCommitStatusDto): boolean {
    if (status.state === 'committed') return true
    else if (status.state === 'running') return false
    else if (status.state === 'editing' || status.state === 'cancelled' || status.state === 'failed' || status.state === 'external-closed') return status.closed
    else throw new Error(`Unknown commit state: ${JSON.stringify(status.state)}`)
  }

  private withCommitTurn<T>(operation: () => Promise<T>): Promise<T> {
    // Keep arrival order through async prepare and renderer acknowledgements.
    const next = this.commitTurn.then(operation, operation)
    this.commitTurn = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * The port's open. A person's click is in front at once; an agent's tab opens behind the one in
   * front and waits in the attention queue, so it never lands in the middle of what the person types.
   */
  async open(sessionId: string, tabTitle: string, requestedBy: RemoteControlTabRequester): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    if (requestedBy === 'person') return this.openTab(sessionId, tabTitle)
    else if (requestedBy === 'agent') {
      const opened = await this.openTab(sessionId, tabTitle, { activate: false })
      if (opened.ok) this.attention.add({ key: `session-opened:${sessionId}`, kind: 'session-opened', sessionId, title: tabTitle,
        automatic: true, holds: false, wanted: () => this.tabs.panelsOfSession(sessionId).length > 0,
        show: () => this.showSession(sessionId, tabTitle) })
      return opened
    } else throw new Error(`Unknown tab requester: ${JSON.stringify(requestedBy satisfies never)}`)
  }

  /** The session's tab in front, opened first when it has none: the panel that shows it, or null. */
  async showSession(sessionId: string, tabTitle: string): Promise<string | null> {
    if (this.stopping) return null
    const existing = this.tabs.panelsOfSession(sessionId)[0]
    const shown = existing === undefined ? await this.openTab(sessionId, tabTitle) : await this.focus(existing.panel.panelId)
    return shown.ok ? shown.value.panelId : null
  }

  async openTab(
    sessionId: string,
    tabTitle: string,
    options?: { activate?: boolean },
  ): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    return this.tabs.request('main', {
      kind: 'open-session',
      requestId: this.requestId(),
      sessionId,
      tabTitle,
      ...(options?.activate === undefined ? {} : { activate: options.activate }),
    })
  }

  async focus(panelId: string): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    const windowId = this.tabs.ownerOf(panelId)
    if (windowId === null)
      return TabControlBroker.error('not-found', `No tab ${JSON.stringify(panelId)}`)
    return this.tabs.request(windowId, {
      kind: 'focus-panel',
      requestId: this.requestId(),
      panelId,
    })
  }

  async openSnapin(kind: string, title: string): Promise<RemoteControlStepResult<TabControlSnapinOpenedDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const panelId = `snapin:${kind}`
    const windowId = this.tabs.ownerOf(panelId) ?? this.tabs.lastFocusedWindowId() ?? 'main'
    return this.tabs.request(windowId, { kind: 'open-snapin', requestId: this.requestId(), panelId, snapinKind: kind, title })
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
    const opened = await this.openTab(sessionId, tabTitle, { activate })
    if (!opened.ok)
      return { ok: false, error: opened.error }
    const sharedOpen = await this.recordOpen(sessionId, proven.documentKey, proven.title, { kind: 'file', source: proven.source }, intentId)
    return this.tabs.request(opened.value.windowId, {
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
    const existing = this.tabs.panelsOfSession(item.sessionId)[0]
    const opened = existing === undefined
      ? await this.openTab(item.sessionId, tabTitle, { activate: true })
      : { ok: true as const, value: { windowId: existing.windowId, panelId: existing.panel.panelId } }
    if (!opened.ok) return opened
    const sharedOpen = await this.recordOpen(item.sessionId, item.key, item.title, { kind: 'task', task: item.task }, intentId)
    return this.tabs.request(opened.value.windowId, {
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
    const existing = this.tabs.panelsOfSession(sessionId)[0]
    const opened = existing === undefined
      ? await this.openTab(sessionId, tabTitle, { activate: true })
      : { ok: true as const, value: { windowId: existing.windowId, panelId: existing.panel.panelId } }
    if (!opened.ok) return opened
    const sharedOpen = await this.recordOpen(sessionId, `workflow:${sessionId}`, 'Session actions', { kind: 'workflow' }, intentId)
    return this.tabs.request(opened.value.windowId, {
      ...(sharedOpen ? { sharedOpen } : {}),
      kind: 'open-workflow',
      requestId: this.requestId(),
      panelId: opened.value.panelId,
      sessionId,
    })
  }

  async openSessionTask(target: TerminalTarget, task: TabControlTaskRef, title: string): Promise<RemoteControlStepResult<TabControlTaskOpenedDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const owner = this.tabs.panelsOfTerminalTarget(TerminalTargetCodec.key(target))[0]
    if (!owner) return TabControlBroker.error('not-found', 'The session terminal is no longer open')
    const localKey = TabControlTask.keyOf(target.sessionId, task)
    let key: string
    if (target.kind === 'remote') key = SessionWorkspaceKeys.of(target, localKey)
    else if (target.kind === 'local') key = localKey
    else throw new Error(`Unknown terminal target: ${JSON.stringify(target satisfies never)}`)
    return this.tabs.request(owner.windowId, { kind: 'open-task', requestId: this.requestId(), panelId: owner.panel.panelId,
      target, item: { key, sessionId: target.sessionId, task, title } })
  }

  async openSessionActions(target: TerminalTarget): Promise<RemoteControlStepResult<TabControlWorkflowOpenedDto>> {
    if (this.stopping) return TabControlBroker.error('unavailable', 'The AppClientUI process is stopping')
    const owner = this.tabs.panelsOfTerminalTarget(TerminalTargetCodec.key(target))[0]
    if (owner === undefined) return TabControlBroker.error('not-found', 'The session terminal is no longer open')
    return this.tabs.request(owner.windowId, { kind: 'open-workflow', requestId: this.requestId(),
      panelId: owner.panel.panelId, sessionId: target.sessionId, target })
  }

  private async recordOpen(sessionId: string, key: string, title: string, item: SessionOpen['item'], intentId?: string): Promise<SessionOpen | undefined> {
    try { return await this.deps?.recordOpen?.({ sessionId, key, title, item, openId: intentId === undefined ? randomUUID() : createHash('sha256').update(JSON.stringify([sessionId, intentId])).digest('hex') }) }
    catch (error) { this.deps?.reportError?.(String(error)); return undefined }
  }

  async close(panelId: string): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>> {
    const windowId = this.tabs.ownerOf(panelId)
    if (windowId === null)
      return TabControlBroker.error('not-found', `No tab ${JSON.stringify(panelId)}`)
    return this.tabs.request(windowId, {
      kind: 'close-panel',
      requestId: this.requestId(),
      panelId,
    })
  }

  cancelAll(): void { this.stopping = true }

  private static error<T = never>(code: 'not-found' | 'unavailable' | 'timeout' | 'operation-failed', detail: string): RemoteControlStepResult<T> {
    return { ok: false, error: { code, detail } }
  }
}
