import { RemoteSidebarPorts } from './remoteSidebarPorts'
import { localTerminalNotesPorts, type TerminalNotesPorts } from './notes/terminalNotesPorts'
import type { SessionTranscriptReading } from '../../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import { RemoteCommitPanePorts } from '../../versioning/remoteCommitPanePorts'
import type { RemoteTaskRequest, RemoteTaskListing, RemoteTaskValue } from '../../../../lib-orchestrator/remoteControl/remoteTaskApi.types'
import type { RemoteControlStepResult } from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteTaskResults } from '../../../shared/remoteTaskResults'
import type { SessionViewOpenRequest, SessionViewOperationMap } from '../../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { SharedSessionViewPorts } from './sharedSessionViews'
import { sessionOpenPageSchema } from '../../../shared/sessionViewItems'
import { RemoteContentRead } from '../../../shared/remoteContentRead'
import { RemoteRequestError } from '../../../shared/remoteRequestError'
import type { TerminalDetectResult, TerminalMenuCapture, TerminalDirectoryOpenResult } from '../../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type { FileViewerOpenResult } from '../../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { RemoteFileChangesPorts } from '../../fileViewer/remoteFileChangesPorts'
import { RemoteFileViewerPorts } from '../../fileViewer/remoteFileViewerPorts'
import { FinalizeAgreements, FinalizeWorking } from '../../overlays/finalize/finalizeModel'
import type { RemoteConnectionsSnapshot } from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteSessionDetail, RemoteSessionView } from '../../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { SessionsSnapshot } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge, IpcResult } from '../../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../../shared/appClientUiReport'
import { SnapshotStore } from '../../ipc/snapshotStore'
import type { FileViewerDocument } from '../../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { SessionFilePorts, SessionTarget } from '../../../shared/sessionWorkspace'
import type { TaskPanePorts } from '../../taskView/taskPaneStore'
import type { WorkflowPorts } from '../../workflow/workflowPane'
import { WorkflowPortsOf } from '../../workflow/workflowPorts'
import { CommitPaneBridge, type CommitPanePorts } from '../../versioning/commitPanePorts'
import { AppControl } from '../../ipc/appControl'

export interface SessionPathPorts {
  detect(capture: TerminalMenuCapture): Promise<IpcResult<TerminalDetectResult>>
  openFile: AppClientUiBridge['terminalMenu']['openFile']
  openDirectory: AppClientUiBridge['terminalMenu']['openDirectory']
}

export interface SessionWorkspacePorts {
  openCommit(vcs: 'svn' | 'git', scopeRoot: string): Promise<string | null>
  notes: TerminalNotesPorts | null
  transcript?: () => Promise<IpcResult<SessionTranscriptReading>>
  listTasks?(): Promise<IpcResult<RemoteControlStepResult<RemoteTaskListing>>>
  share?(request: SessionViewOpenRequest): Promise<IpcResult<unknown>>
  paths?: SessionPathPorts | null
  items?: SharedSessionViewPorts | null
  sessions?: SnapshotStore<SessionsSnapshot>
  status(): string | null
  start(): () => void
  subscribe(listener: () => void): () => void
  contentRevision(): number
  dispose(): void
  changes: AppClientUiBridge['fileChanges'] | null
  files: SessionFilePorts | null
  reviews: CommitPanePorts | null
  tasks: TaskPanePorts | null
  actions(report: (sentence: string | null) => void, openFile: (document: FileViewerDocument) => string | null): WorkflowPorts
}

export class SessionWorkspaceProviders {
  static localFiles(): SessionFilePorts {
    return { viewer: window.appClient.fileViewer, directories: window.appClient.fileViewer, changes: window.appClient.fileChanges }
  }

  static forTarget(target: SessionTarget, remote?: SnapshotStore<RemoteConnectionsSnapshot>): SessionWorkspacePorts {
    if (target.kind === 'local') return {
      openCommit: async (vcs, scopeRoot) => {
        const result = await window.appClient.versioning.openCommitTab(target.sessionId, vcs, scopeRoot)
        return result.ok ? result.value.ok ? null : result.value.error.detail : result.error
      },
      notes: localTerminalNotesPorts,
      transcript: async () => { const answer = await AppControl.value('sessions.transcript', { session: AppControl.sessionOf(target.sessionId) }); return answer.ok ? { ok: true, value: answer.value.reading } : answer },
      share: window.appClient.tabs?.openSharedItem ? (request) => window.appClient.tabs.openSharedItem(target.sessionId, request) : undefined,
      items: window.appClient.tabs?.sessionItems ? { read: (cursor) => window.appClient.tabs.sessionItems(target.sessionId, cursor),
        subscribe: (changed) => window.appClient.onTabsOpenTerminalTargets(() => changed()) } : null,
      status: () => null, start: () => () => {}, subscribe: () => () => {}, contentRevision: () => 0, dispose: () => {},
      changes: window.appClient.fileChanges,
      files: SessionWorkspaceProviders.localFiles(),
      reviews: CommitPaneBridge.of(),
      tasks: {
        openTerminal: async (runId) => { const answer = await AppControl.call('tabs.open', { session: { kind: 'sessionId', sessionId: runId } }); return !answer.ok ? answer.error : !answer.value.ok ? answer.value.error.detail : null },
        scriptOutput: (request) => AppControl.call('sessions.scriptOutput', request),
        transcript: (request) => AppControl.call('sessionTasks.transcript', request),
        shellOutput: (request) => AppControl.call('sessionTasks.shellOutput', request),
      },
      actions: (report, openFile) => WorkflowPortsOf.of(target.sessionId, report, openFile),
    }
    else if (target.kind === 'remote') {
      if (!remote) throw new Error('Remote sessions store is required')
      return new RemoteSessionWorkspace(target, remote)
    }
    else throw new Error(`Unknown session target: ${JSON.stringify(target)}`)
  }
}

class RemoteSessionWorkspace implements SessionWorkspacePorts {
  private sidebar: RemoteSidebarPorts
  get notes(): TerminalNotesPorts | null { return this.endpoint()?.workspaceCapabilities?.includes('session-workspace.sidebar') ? this.sidebar.notes : null }
  transcript = (): Promise<IpcResult<SessionTranscriptReading>> => this.sidebar.transcript()
  private content: RemoteFileViewerPorts
  private changesContent: RemoteFileChangesPorts
  private changesPorts: AppClientUiBridge['fileChanges']
  private filePorts: SessionFilePorts
  get files(): SessionFilePorts | null {
    const endpoint = this.endpoint()
    return endpoint?.workspaceCapabilities?.includes('session-workspace.files') && endpoint.workspaceCapabilities.includes('session-workspace.views') ? this.filePorts : null
  }
  get changes(): AppClientUiBridge['fileChanges'] | null {
    const endpoint = this.endpoint()
    return endpoint?.workspaceCapabilities?.includes('session-workspace.changes') && endpoint.workspaceCapabilities.includes('session-workspace.views') ? this.changesPorts : null
  }
  async openCommit(vcs: 'svn' | 'git', scopeRoot: string): Promise<string | null> {
    if (!this.reviews || !this.endpoint()?.workspaceCapabilities?.includes('session-workspace.commands'))
      return 'This peer does not support opening source reviews'
    const answer = await this.reviewContent.create(vcs, scopeRoot)
    return !answer.ok ? answer.error : !answer.value.ok ? answer.value.detail : null
  }

  async share(request: SessionViewOpenRequest): Promise<IpcResult<unknown>> {
    try {
      const view = await this.open()
      const answer = await window.appClient.remote.openSharedItem(this.target.remoteEndpointId, view.viewId, request)
      if (!answer.ok) return answer
      return answer.value.ok ? { ok: true, value: undefined } : { ok: false, error: answer.value.error.detail }
    } catch (error) { return { ok: false, error: String(error) } }
  }
  get items(): SharedSessionViewPorts | null {
    if (!this.endpoint()?.workspaceCapabilities?.includes('session-workspace.views') || !window.appClient.remote.requestItems) return null
    return {
      subscribe: (changed) => this.remote.subscribe(changed),
      read: async (cursor) => {
        try {
          const view = await this.open()
          const answer = await window.appClient.remote.requestItems(this.target.remoteEndpointId, view.viewId, cursor)
          if (!answer.ok) return answer
          if (!answer.value.ok) return { ok: false, error: answer.value.error.detail }
          const bytes = await RemoteContentRead.collect(answer.value.value, async (next) => {
            const result = await window.appClient.remote.readItemsPage(this.target.remoteEndpointId, view.viewId, next)
            if (!result.ok) throw new Error(result.error)
            if (!result.value.ok) throw new Error(result.value.error.detail)
            return result.value.value
          })
          return { ok: true, value: sessionOpenPageSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
        } catch (error) { return { ok: false, error: String(error) } }
      },
    }
  }
  get paths(): SessionPathPorts | null {
    return this.files ? {
      detect: (capture) => this.content.request({ kind: 'detect', capture }),
      openFile: async (requestId, detectionId) => this.content.adopt(await this.content.request<FileViewerOpenResult>({ kind: 'detected-file', requestId, detectionId })),
      openDirectory: (requestId, detectionId) => this.content.request<TerminalDirectoryOpenResult>({ kind: 'detected-directory', requestId, detectionId }),
    } : null
  }
  private reviewContent: RemoteCommitPanePorts
  get reviews(): CommitPanePorts | null {
    const capabilities = this.endpoint()?.workspaceCapabilities
    return capabilities?.includes('session-workspace.reviews') && capabilities.includes('session-workspace.views')
      && capabilities.includes('session-workspace.changes') ? this.reviewContent.ports : null
  }
  private createReviewPorts(): RemoteCommitPanePorts {
    const local = CommitPaneBridge.viewer()
    return new RemoteCommitPanePorts(this.target, this.generation, () => this.open(), window.appClient.remote, {
      project: (draft, key, openId) => window.appClient.tabs.projectReview?.(this.target, draft, key, openId) ?? Promise.resolve(),
      changed: (draft, closed) => window.appClient.tabs.projectedReviewChanged?.(this.target, draft, closed) ?? Promise.resolve(),
      confirmRevert: local.confirmRevert, settings: local.versioning, changes: this.changesPorts, releaseFile: this.content.viewer.release,
      subscribe: (changed) => this.remote.subscribe(changed), reportError: AppClientUiReport.error,
      computer: () => this.endpoint()?.displayName ?? 'the source computer',
    })
  }
  private taskPorts: TaskPanePorts
  get tasks(): TaskPanePorts | null {
    const capabilities = this.endpoint()?.workspaceCapabilities
    return capabilities?.includes('session-workspace.tasks') && capabilities.includes('session-workspace.views') ? this.taskPorts : null
  }
  listTasks(): Promise<IpcResult<RemoteControlStepResult<RemoteTaskListing>>> { return this.readTask({ kind: 'list' }) }
  private createTaskPorts(): TaskPanePorts {
    const generation = this.generation
    const current = <T extends RemoteTaskValue>(sessionId: string, request: RemoteTaskRequest): Promise<IpcResult<RemoteControlStepResult<T>>> =>
      generation === this.generation ? this.taskFor(sessionId, request) : Promise.resolve({ ok: false, error: 'Source task ports were retired' })
    return {
      transcript: ({ sessionId, subagentId, known }) => current(sessionId, { kind: 'transcript', subagentId, ...(known ? { known } : {}) }),
      shellOutput: ({ sessionId, shellId, known }) => current(sessionId, { kind: 'shell', shellId, ...(known ? { known } : {}) }),
      scriptOutput: ({ sessionId, runId }) => current(sessionId, { kind: 'script', runId }),
    }
  }
  private taskFor<T extends RemoteTaskValue>(sessionId: string, request: RemoteTaskRequest): Promise<IpcResult<RemoteControlStepResult<T>>> {
    return sessionId === this.target.sessionId ? this.readTask(request) : Promise.resolve({ ok: false, error: 'Task belongs to another session' })
  }
  private async readTask<T extends RemoteTaskValue>(request: RemoteTaskRequest): Promise<IpcResult<RemoteControlStepResult<T>>> {
    const generation = this.generation
    if (!this.tasks) return { ok: false, error: 'This peer does not support source tasks.' }
    try {
      const view = await this.open()
      const first = await window.appClient.remote.requestTasks(this.target.remoteEndpointId, view.viewId, request)
      if (!first.ok) return first
      if (!first.value.ok) return { ok: true, value: first.value }
      const bytes = await RemoteContentRead.collect(first.value.value, async (cursor) => {
        const next = await window.appClient.remote.readTaskPage(this.target.remoteEndpointId, view.viewId, { task: request, cursor })
        if (!next.ok) throw new Error(next.error)
        if (!next.value.ok) throw new Error(next.value.error.detail)
        return next.value.value
      })
      if (generation !== this.generation) return { ok: false, error: 'Source task view changed' }
      return { ok: true, value: RemoteTaskResults.parse(this.target.sessionId, request,
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) as RemoteControlStepResult<T> }
    } catch (error) { return { ok: false, error: String(error) } }
  }
  readonly sessions: SnapshotStore<SessionsSnapshot>
  private readonly target: Extract<SessionTarget, { kind: 'remote' }>
  private readonly remote: SnapshotStore<RemoteConnectionsSnapshot>
  private view: Promise<RemoteSessionView> | null = null
  private detail: RemoteSessionDetail | null = null
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private epoch: string | null = null
  private revision = 0
  private detailKey: string | null = null

  constructor(target: Extract<SessionTarget, { kind: 'remote' }>, remote: SnapshotStore<RemoteConnectionsSnapshot>) {
    this.target = target
    this.sidebar = new RemoteSidebarPorts(target.remoteEndpointId, target.sessionId, () => this.open(), window.appClient.remote)
    this.taskPorts = this.createTaskPorts()
    this.remote = remote
    this.epoch = this.endpoint()?.connectionId ?? null
    this.content = new RemoteFileViewerPorts(target, () => this.open(), window.appClient.remote, (url) => window.appClient.fileViewer.openExternal(url))
    this.changesContent = new RemoteFileChangesPorts(target, () => this.open(), window.appClient.remote, (document) => this.content.adoptDocument(document))
    this.changesPorts = this.changesContent.changes
    this.filePorts = { viewer: this.content.viewer, directories: this.content.directories, changes: this.changesPorts }
    this.reviewContent = this.createReviewPorts()
    this.sessions = new SnapshotStore('Remote session actions', {
      read: () => this.read(), subscribe: (changed) => remote.subscribe(changed), reportError: AppClientUiReport.error,
    })
  }

  private endpoint() {
    return this.remote.current().snapshot?.outbound.find((entry) => entry.remoteEndpointId === this.target.remoteEndpointId)
  }

  status(): string | null {
    const endpoint = this.endpoint()
    if (!endpoint || endpoint.status !== 'connected') return 'Remote session is offline. Session actions return when it reconnects.'
    if (!['session-workspace.read', 'session-workspace.views', 'session-workspace.actions'].every((capability) => endpoint.workspaceCapabilities?.some((value) => value === capability)))
      return 'This peer does not support Session actions. Its terminal remains available.'
    return null
  }

  start(): () => void {
    this.epoch = this.endpoint()?.connectionId ?? null
    const stop = this.remote.subscribe(() => {
      const epoch = this.endpoint()?.connectionId ?? null
      if (epoch === this.epoch) return
      this.reset()
      this.epoch = epoch
      this.sessions.refresh()
    })
    return () => { stop(); this.dispose() }
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  contentRevision(): number { return this.generation }

  dispose(): void { this.reset() }

  private reset(): void {
    this.generation++
    this.sidebar.close()
    this.sidebar = new RemoteSidebarPorts(this.target.remoteEndpointId, this.target.sessionId, () => this.open(), window.appClient.remote)
    this.taskPorts = this.createTaskPorts()
    this.content.clear()
    this.changesContent.clear()
    this.reviewContent.clear()
    this.content = new RemoteFileViewerPorts(this.target, () => this.open(), window.appClient.remote, (url) => window.appClient.fileViewer.openExternal(url))
    this.changesContent = new RemoteFileChangesPorts(this.target, () => this.open(), window.appClient.remote, (document) => this.content.adoptDocument(document))
    this.changesPorts = this.changesContent.changes
    this.filePorts = { viewer: this.content.viewer, directories: this.content.directories, changes: this.changesPorts }
    this.reviewContent = this.createReviewPorts()
    const held = this.view
    this.view = null
    this.detail = null
    this.detailKey = null
    if (held) void held.then((view) => window.appClient.remote.closeView(this.target.remoteEndpointId, view.viewId)).catch(() => {})
    for (const listener of this.listeners) listener()
  }

  actions(report: (sentence: string | null) => void, openFile: (document: FileViewerDocument) => string | null): WorkflowPorts {
    const openConflict = async (request: { kind: 'conflict'; path: string } | { kind: 'merge-brief' }): Promise<string | null> => {
      if (!this.endpoint()?.workspaceCapabilities?.includes('session-workspace.conflicts')) return 'This peer does not support conflict files'
      const answer = this.content.adopt(await this.content.request<FileViewerOpenResult>(request))
      return !answer.ok ? answer.error : !answer.value.ok ? answer.value.detail : openFile(answer.value.value)
    }
    return {
      ...(this.endpoint()?.workspaceCapabilities?.includes('session-workspace.history') ? {
        clearHistory: () => this.command({ kind: 'clear-history', revision: this.detail?.revision ?? -1 }),
      } : {}),
      ...(this.tasks ? { tasks: this.tasks } : {}),
      ...(this.reviews && this.endpoint()?.workspaceCapabilities?.includes('session-workspace.finish') ? { reviews: this.reviews } : {}),
      openStep: (target, title) => {
        if (target.kind === 'run')
          void window.appClient.tabs.openSessionTask(this.target, { kind: 'script', runId: target.runId }, title).then((answer) => report(answer.ok ? null : answer.error))
        else if (target.kind === 'agent' || target.kind === 'commit') void this.openRelated(target.runId).then(report)
        else if (target.kind !== 'none' && target.kind !== 'conflicts') throw new Error(`Unknown workflow target: ${JSON.stringify(target satisfies never)}`)
      },
      conflicts: {
        resolve: (path, option, confirm, kind) => this.command({ kind: 'resolve-conflict', revision: this.detail?.revision ?? -1, path,
          ...(kind === undefined ? {} : { conflictKind: kind }), option, ...(confirm ? { confirm: true } : {}) }),
        openFile: (path) => openConflict({ kind: 'conflict', path }), openBrief: () => openConflict({ kind: 'merge-brief' }),
        editorUnavailable: 'TortoiseSVN runs on the source computer. Use its local window to open the native editor.',
        openConflictEditor: async () => 'TortoiseSVN runs on the source computer. Open this conflict there.',
      },
      press: async (action, agreement, commit) => {
        const reason = this.status()
        if (reason) return { kind: 'refused', sentence: reason }
        const detail = this.detail
        const sections = detail?.session.actions?.sections ?? (detail?.session.workflow ? [detail.session.workflow] : [])
        const section = sections.find((candidate) => candidate.actions.includes(action))
        if (!detail || !section) return { kind: 'refused', sentence: 'Session actions changed. Read them again.' }
        try {
          if (action.id === 'open-merger' && action.runId) {
            const sentence = await this.openRelated(action.runId)
            return sentence ? { kind: 'refused', sentence } : { kind: 'done' }
          }
          if (commit?.reviewed) {
            if (!this.endpoint()?.workspaceCapabilities?.includes('session-workspace.finish'))
              return { kind: 'refused', sentence: 'This peer does not support shared Finish approval' }
            const decide = this.reviews?.versioning.decideCommit
            if (!decide || action.id !== 'finish-again' || !action.requiresCommit || commit.reviewed.workflowId !== section.workflowId)
              return { kind: 'refused', sentence: 'This source action cannot approve the shared review' }
            const answer = await decide({ ...commit.reviewed.proof, kind: 'finish', operationId: crypto.randomUUID(),
              workflow: { workflowId: section.workflowId, revision: detail.revision, actionId: 'finish-again', agreement, repositories: commit.repositories, acknowledgedFindings: commit.acknowledgedFindings, reviewVersion: commit.reviewVersion } })
            this.sessions.refresh()
            return WorkflowPortsOf.reviewResult(answer)
          }
          const view = await this.open()
          const answer = await window.appClient.remote.pressAction(this.target.remoteEndpointId, view.viewId,
            { revision: detail.revision, workflowId: section.workflowId, actionId: action.id, agreement, ...(commit ? { commit } : {}) }, crypto.randomUUID())
          this.sessions.refresh()
          if (!answer.ok) return { kind: 'refused', sentence: answer.error }
          const setup = FinalizeAgreements.of(answer)
          if (setup) return { kind: 'agreement', setup }
          const working = FinalizeWorking.of(answer)
          if (working) return { kind: 'working', sentence: working }
          if (!answer.value.ok) return { kind: 'refused', sentence: answer.value.error.detail }
          return { kind: 'done' }
        } catch (error) { return { kind: 'refused', sentence: String(error) } }
      },
    }
  }

  private async openRelated(sessionId: string): Promise<string | null> {
    const selected = await window.appClient.remote.selectSession(this.target.remoteEndpointId, sessionId)
    if (!selected.ok) return selected.error
    if (!selected.value.ok) return selected.value.error.detail
    const opened = await window.appClient.tabs.openSessionActions({ ...this.target, sessionId })
    return opened.ok ? null : opened.error
  }

  private async command(request: Extract<SessionViewOperationMap['actions.press']['request'], { kind: string }>): Promise<string | null> {
    const reason = this.status()
    if (reason) return reason
    const capability = request.kind === 'resolve-conflict' ? 'session-workspace.conflicts' : 'session-workspace.history'
    if (!this.endpoint()?.workspaceCapabilities?.includes(capability)) return 'This peer does not support this session command'
    try {
      const view = await this.open()
      const answer = await window.appClient.remote.pressAction(this.target.remoteEndpointId, view.viewId, request, crypto.randomUUID())
      this.sessions.refresh()
      return !answer.ok ? answer.error : !answer.value.ok ? answer.value.error.detail : null
    } catch (error) { return String(error) }
  }

  private open(): Promise<RemoteSessionView> {
    const epoch = this.endpoint()?.connectionId ?? null
    if (epoch !== this.epoch) { this.reset(); this.epoch = epoch }
    if (!this.view) {
      const generation = this.generation
      const pending = window.appClient.remote.openView(this.target.remoteEndpointId, this.target.sessionId).then((answer) => {
        if (!answer.ok) throw new Error(answer.error)
        if (!answer.value.ok) throw new RemoteRequestError(answer.value.error)
        if (generation !== this.generation) {
          void window.appClient.remote.closeView(this.target.remoteEndpointId, answer.value.value.viewId)
          throw new Error('Session view closed')
        }
        return answer.value.value
      })
      this.view = pending
      void pending.catch(() => { if (this.view === pending) this.view = null })
    }
    return this.view
  }

  private async read(): Promise<IpcResult<SessionsSnapshot>> {
    const generation = this.generation
    const reason = this.status()
    if (reason) return { ok: false, error: reason }
    try {
      const view = await this.open()
      const answer = await window.appClient.remote.readView(this.target.remoteEndpointId, view.viewId)
      if (generation !== this.generation) return { ok: false, error: 'Remote session view closed' }
      if (!answer.ok) return answer
      if (!answer.value.ok) return { ok: false, error: answer.value.error.detail }
      const detailKey = JSON.stringify([view.epoch, answer.value.value])
      if (detailKey !== this.detailKey || this.detail === null) {
        this.detailKey = detailKey
        this.detail = answer.value.value
        this.revision++
      }
      const detail = this.detail
      const snapshot = this.remote.current().snapshot?.outbound.find((entry) => entry.remoteEndpointId === this.target.remoteEndpointId)?.sessions
      if (!snapshot) return { ok: false, error: 'Remote session disconnected' }
      return { ok: true, value: { ...snapshot, revision: this.revision,
        sessions: snapshot.sessions.map((session) => session.sessionId === this.target.sessionId ? detail.session : session) } }
    } catch (error) { return { ok: false, error: String(error) } }
  }
}
