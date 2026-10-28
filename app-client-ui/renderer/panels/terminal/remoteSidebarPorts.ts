import type { RemoteSessionView } from '../../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { RemoteSidebarRequest } from '../../../../lib-orchestrator/remoteControl/remoteSidebarApi.types'
import type { SessionModelReading } from '../../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type { SessionTranscriptReading } from '../../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type { AppClientUiBridge, IpcResult } from '../../../shared/appClientUiIpc'
import type { DirectoryNotesImportResult, DirectoryNotesSnapshot } from '../../../shared/directoryNotes'
import { RemoteContentRead } from '../../../shared/remoteContentRead'
import { RemoteSidebarResults } from '../../../shared/remoteSidebarResults'
import type { TerminalNotesPorts } from './notes/terminalNotesPorts'

export class RemoteSidebarPorts {
  readonly notes: TerminalNotesPorts
  private readonly endpointId: string
  private readonly sessionId: string
  private readonly open: () => Promise<RemoteSessionView>
  private readonly bridge: AppClientUiBridge['remote']
  private closed = false
  private static readonly pending = new Map<string, { payload: string; operationId: string; at: number; epoch?: string }>()

  constructor(endpointId: string, sessionId: string, open: () => Promise<RemoteSessionView>, bridge: AppClientUiBridge['remote']) {
    this.endpointId = endpointId
    this.sessionId = sessionId
    this.open = open
    this.bridge = bridge
    this.notes = {
      get: async (id) => {
        const answer = await this.forSession<DirectoryNotesSnapshot>(id, { kind: 'notes' })
        return answer.ok ? { ok: true, value: { ok: true, value: answer.value } } : answer
      },
      save: async (id, notes) => {
        const answer = await this.forSession<null>(id, { kind: 'save-notes', notes, operationId: crypto.randomUUID() })
        return answer.ok ? { ok: true, value: { ok: true } } : answer
      },
      importPrompt: (id) => this.forSession<DirectoryNotesImportResult>(id, { kind: 'import-prompt', operationId: crypto.randomUUID() }),
      subscribe: (changed) => { const timer = setInterval(() => { if (!this.closed) changed(null) }, 3000); return () => clearInterval(timer) },
    }
  }

  close(): void { this.closed = true }
  model(): Promise<IpcResult<SessionModelReading>> { return this.request({ kind: 'model' }) }
  transcript(): Promise<IpcResult<SessionTranscriptReading>> { return this.request({ kind: 'transcript' }) }

  private forSession<T>(sessionId: string, request: RemoteSidebarRequest): Promise<IpcResult<T>> {
    return sessionId === this.sessionId ? this.request(request) : Promise.resolve({ ok: false, error: 'Sidebar belongs to another source session' })
  }

  private async request<T>(request: RemoteSidebarRequest): Promise<IpcResult<T>> {
    if (this.closed) return { ok: false, error: 'Source sidebar was retired' }
    const key = 'operationId' in request ? JSON.stringify([this.endpointId, this.sessionId, request.kind, request.kind === 'compact' ? request.action : null]) : null
    if (key && 'operationId' in request) {
      const payload = JSON.stringify({ ...request, operationId: undefined })
      const prior = RemoteSidebarPorts.pending.get(key)
      if (prior) {
        if (prior.payload !== payload || Date.now() - prior.at > 5 * 60_000)
          return { ok: false, error: `The previous ${request.kind} outcome is uncertain. Inspect the source before changing it again.` }
        request = { ...request, operationId: prior.operationId }
      } else {
        if (RemoteSidebarPorts.pending.size >= 128) return { ok: false, error: 'Too many unconfirmed source operations' }
        RemoteSidebarPorts.pending.set(key, { payload, operationId: request.operationId, at: Date.now() })
      }
    }
    try {
      const view = await this.open()
      const pending = key ? RemoteSidebarPorts.pending.get(key) : undefined
      if (pending?.epoch && pending.epoch !== view.epoch)
        return { ok: false, error: `The source connection changed before ${request.kind} was confirmed. Inspect its original outcome on the source computer.` }
      if (pending) pending.epoch = view.epoch
      if (this.closed) return { ok: false, error: 'Source sidebar was retired' }
      const first = await this.bridge.requestSidebar(this.endpointId, view.viewId, request)
      if (!first.ok) return first
      if (!first.value.ok) return { ok: false, error: first.value.error.detail }
      const bytes = await RemoteContentRead.collect(first.value.value, async (cursor) => {
        const next = await this.bridge.readSidebarPage(this.endpointId, view.viewId, cursor)
        if (!next.ok) throw new Error(next.error)
        if (!next.value.ok) throw new Error(next.value.error.detail)
        return next.value.value
      })
      if (this.closed) return { ok: false, error: 'Source sidebar was retired' }
      const result = RemoteSidebarResults.parse(this.sessionId, request, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      if (key) RemoteSidebarPorts.pending.delete(key)
      return result.ok ? { ok: true, value: result.value as T } : { ok: false, error: result.error.detail }
    } catch (error) { return { ok: false, error: String(error) } }
  }

  static model(endpointId: string, sessionId: string): Promise<IpcResult<SessionModelReading>> { return this.read(endpointId, sessionId, { kind: 'model' }) }

  static compact<T>(endpointId: string, sessionId: string, action: Extract<RemoteSidebarRequest, { kind: 'compact' }>['action']): Promise<IpcResult<T>> {
    return this.read(endpointId, sessionId, { kind: 'compact', action, operationId: crypto.randomUUID() })
  }

  private static async read<T>(endpointId: string, sessionId: string, request: RemoteSidebarRequest): Promise<IpcResult<T>> {
    const answer = await window.appClient.remote.openView(endpointId, sessionId)
    if (!answer.ok) return answer
    if (!answer.value.ok) return { ok: false, error: answer.value.error.detail }
    const view = answer.value.value
    try { return await new RemoteSidebarPorts(endpointId, sessionId, async () => view, window.appClient.remote).request<T>(request) }
    finally { await window.appClient.remote.closeView(endpointId, view.viewId) }
  }
}
