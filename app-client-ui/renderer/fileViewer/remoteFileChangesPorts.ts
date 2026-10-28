import type { AppClientUiBridge, FileChangesOpenFileResult, IpcResult } from '../../shared/appClientUiIpc'
import type { SessionTarget } from '../../shared/sessionWorkspace'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { RemoteChangesRequest } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { RemoteContentRead } from '../../shared/remoteContentRead'
import { RemoteChangesResults } from '../../shared/remoteChangesResults'

export class RemoteFileChangesPorts {
  readonly changes: AppClientUiBridge['fileChanges']
  private readonly target: Extract<SessionTarget, { kind: 'remote' }>
  private readonly open: () => Promise<RemoteSessionView>
  private readonly bridge: Pick<AppClientUiBridge['remote'], 'requestChanges' | 'readChangesPage'>
  private generation = 0
  private closed = false

  constructor(target: Extract<SessionTarget, { kind: 'remote' }>, open: () => Promise<RemoteSessionView>,
    bridge: Pick<AppClientUiBridge['remote'], 'requestChanges' | 'readChangesPage'>, adopt: (document: FileViewerDocument) => FileViewerDocument) {
    this.target = target
    this.open = open
    this.bridge = bridge
    this.changes = {
      list: (sessionId, preferredVcs) => this.session(sessionId, { kind: 'list', preferredVcs }),
      workingTree: (sessionId, source) => this.session(sessionId, { kind: 'working-tree', source }),
      scopedWorkingTree: (source) => this.session(source.sessionId, { kind: 'scoped', source }),
      history: (snapshotId, cursor) => this.request({ kind: 'history', snapshotId, cursor }),
      diff: (request) => this.request({ kind: 'diff', request }),
      openFile: async (snapshotId, fileId) => {
        const answer = await this.request<FileChangesOpenFileResult>({ kind: 'open', snapshotId, fileId })
        if (!answer.ok || !answer.value.ok) return answer
        try { return { ok: true, value: { ok: true, value: adopt(answer.value.value) } } }
        catch (error) { return { ok: false, error: String(error) } }
      },
    }
  }

  clear(): void { this.closed = true; this.generation++ }

  private async session<T>(sessionId: string, request: RemoteChangesRequest): Promise<IpcResult<T>> {
    return sessionId === this.target.sessionId ? this.request(request) : { ok: false, error: 'Changes belong to another session' }
  }

  private async request<T>(request: RemoteChangesRequest): Promise<IpcResult<T>> {
    if (this.closed) return { ok: false, error: 'Remote changes view closed' }
    const generation = this.generation
    try {
      const view = await this.open()
      const first = await this.bridge.requestChanges(this.target.remoteEndpointId, view.viewId, request)
      if (!first.ok) return first
      if (!first.value.ok) return { ok: false, error: first.value.error.detail }
      const bytes = await RemoteContentRead.collect(first.value.value, async (cursor) => {
        const next = await this.bridge.readChangesPage(this.target.remoteEndpointId, view.viewId, cursor)
        if (!next.ok) throw new Error(next.error)
        if (!next.value.ok) throw new Error(next.value.error.detail)
        return next.value.value
      })
      if (generation !== this.generation) return { ok: false, error: 'Remote changes view closed' }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!RemoteChangesResults.valid(request, value)) return { ok: false, error: 'Malformed remote changes response' }
      if ((request.kind === 'list' || request.kind === 'working-tree' || request.kind === 'scoped') && value && typeof value === 'object' && 'ok' in value && value.ok === true
        && 'value' in value && value.value && typeof value.value === 'object' && 'sessionId' in value.value && value.value.sessionId !== this.target.sessionId) return { ok: false, error: 'Changes belong to another session' }
      return { ok: true, value: value as T }
    } catch (error) { return { ok: false, error: String(error) } }
  }
}
