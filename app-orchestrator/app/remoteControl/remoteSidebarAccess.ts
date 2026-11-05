import { randomUUID } from 'node:crypto'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { RemoteSidebarRequest } from '../../../lib-orchestrator/remoteControl/remoteSidebarApi.types'
import type { RemoteContentCursor } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { SessionTranscriptAccess } from '../sessionTranscript/sessionTranscriptAccess'
import type { RemoteSessionInteraction } from './remoteSessionViews'
import { RemoteContentAccess } from './remoteContentAccess'
import { RemoteContentPages } from './remoteContentPages'
import { RemoteControlOperationStore } from '../../../lib-orchestrator/remoteControl/remoteControlOperationStore'
import type { ServiceContextCompactionIpc } from '../contextCompaction/serviceContextCompactionIpc'

export class RemoteSidebarAccess {
  private readonly registry: Pick<RemoteControlRegistry, 'execute'>
  private readonly transcript: Pick<SessionTranscriptAccess, 'read'>
  private readonly active: (view: RemoteSessionInteraction) => boolean
  private readonly pages = new RemoteContentPages()
  private readonly compact: Pick<ServiceContextCompactionIpc, 'claimAutomatic' | 'noteManual' | 'cooldown' | 'deliver'>
  private readonly replay = new RemoteControlOperationStore()

  constructor(registry: RemoteSidebarAccess['registry'], transcript: RemoteSidebarAccess['transcript'], active: RemoteSidebarAccess['active'], compact: RemoteSidebarAccess['compact']) {
    this.registry = registry
    this.transcript = transcript
    this.active = active
    this.compact = compact
  }

  async request(view: RemoteSessionInteraction, request: RemoteSidebarRequest) {
    let value: unknown
    if (request.kind === 'transcript') value = { ok: true, value: await this.transcript.read(view.sessionId) }
    else if (request.kind === 'compact') {
      const result = await this.replay.runOrRefuse(JSON.stringify([view.peerId, view.sessionId]), request.operationId, JSON.stringify(request), async () => {
        if (request.action === 'claim') return this.compact.claimAutomatic(view.sessionId)
        else if (request.action === 'note') { this.compact.noteManual(view.sessionId); return null }
        else if (request.action === 'cooldown') return this.compact.cooldown(view.sessionId)
        else if (request.action === 'deliver') return this.compact.deliver(view.sessionId)
        else throw new Error(`Unknown compact action: ${request.action satisfies never}`)
      })
      value = result.ok ? { ok: true, value: result.value } : result
    }
    else {
      const operation = this.operation(request)
      const body = { sessionId: view.sessionId, ...(request.kind === 'save-notes' ? { notes: request.notes } : {}) }
      const answer = await this.registry.execute({ protocol: RemoteControlConst.protocol, requestId: randomUUID(), operation, body,
        ...('operationId' in request ? { operationId: request.operationId } : {}) }, {
        callerId: JSON.stringify(['session-sidebar', view.peerId, view.sessionId]), callerKind: 'window', allowedOperations: [operation],
      })
      value = answer.ok ? { ok: true, value: answer.value ?? null } : { ok: false, error: answer.error }
    }
    if (!this.active(view)) return { ok: false as const, error: { code: 'unavailable' as const, detail: 'Source sidebar view was released' } }
    return this.pages.put(RemoteContentAccess.owner(view), { sessionId: view.sessionId, request, result: value })
  }

  page(view: RemoteSessionInteraction, cursor: RemoteContentCursor) { return this.pages.read(RemoteContentAccess.owner(view), cursor) }
  release(view: RemoteSessionInteraction): void { this.pages.release(RemoteContentAccess.owner(view)) }

  private operation(request: Exclude<RemoteSidebarRequest, { kind: 'transcript' | 'compact' }>): string {
    switch (request.kind) {
      case 'notes': return 'directoryNotes.get'
      case 'save-notes': return 'directoryNotes.save'
      case 'import-prompt': return 'directoryNotes.importPrompt'
      case 'model': return 'sessions.model'
      default: throw new Error(`Unknown sidebar request: ${JSON.stringify(request satisfies never)}`)
    }
  }
}
