import { randomUUID } from 'node:crypto'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerTransport } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { RemoteControlOperationStore } from '../../../lib-orchestrator/remoteControl/remoteControlOperationStore'
import type { RemoteSessionView, RemoteSessionViewResponse, RemoteSessionReadRequest, SessionViewOperationMap } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import { ErrorText } from '../../shared/errorText'

type Peer = Pick<RemoteControlPeerTransport, 'connectionId' | 'remoteIdentity' | 'capabilities'>
export interface RemoteSessionInteraction extends RemoteSessionView { peerId: string; commitReceipts?: true }
export interface RemoteSessionViewsDeps {
  exists(sessionId: string): boolean
  press(view: RemoteSessionInteraction, body: SessionViewOperationMap['actions.press']['request'], operationId: string): Promise<RemoteControlStepResult<null>>
  read?(view: RemoteSessionInteraction, request: RemoteSessionReadRequest): Promise<RemoteSessionViewResponse['result']>
  release?(view: RemoteSessionInteraction): void
}

export class RemoteSessionViews {
  private readonly deps: RemoteSessionViewsDeps
  private readonly views = new Map<string, RemoteSessionInteraction>()
  private readonly replay = new RemoteControlOperationStore()

  constructor(deps: RemoteSessionViewsDeps) { this.deps = deps }

  async request(peer: Peer, input: unknown): Promise<RemoteSessionViewResponse['result']> {
    const request = RemoteSessionSchemas.viewRequest(input)
    if (!request) return RemoteSessionViews.refused('invalid-request', 'Invalid session view request')
    if (!peer.capabilities.includes('session-workspace.views') || request.epoch !== peer.connectionId)
      return RemoteSessionViews.refused('forbidden', 'Session view connection is not admitted')
    const peerId = JSON.stringify([peer.remoteIdentity.remoteComputerId, peer.remoteIdentity.remoteEndpointId])
    if (request.operation === 'views.open') {
      if (!this.deps.exists(request.body.sessionId)) return RemoteSessionViews.refused('not-found', 'Session no longer exists')
      const existing = [...this.views.values()].find((view) => view.peerId === peerId && view.epoch === request.epoch
        && view.sessionId === request.body.sessionId && view.viewerId === request.body.viewerId)
      if (existing) return { ok: true, value: RemoteSessionViews.publicView(existing) }
      if (this.views.size >= 512) return RemoteSessionViews.refused('unavailable', 'Too many session views')
      const view = { viewId: randomUUID(), epoch: request.epoch, ...request.body, peerId,
        ...(peer.capabilities.includes('session-workspace.commit-receipts') ? { commitReceipts: true as const } : {}) }
      this.views.set(view.viewId, view)
      return { ok: true, value: RemoteSessionViews.publicView(view) }
    }
    const view = this.views.get(request.viewId)
    if (!view || view.peerId !== peerId || view.epoch !== request.epoch || view.sessionId !== request.sessionId || view.viewerId !== request.viewerId)
      return RemoteSessionViews.refused('forbidden', 'Session view is not owned by this viewer')
    if (request.operation === 'views.close') {
      this.release(view)
      return { ok: true, value: null }
    } else if (request.operation === 'actions.press') {
      if (!peer.capabilities.includes('session-workspace.actions')) return RemoteSessionViews.refused('forbidden', 'Session actions are unsupported')
      if ('kind' in request.body && !peer.capabilities.includes(request.body.kind === 'resolve-conflict' ? 'session-workspace.conflicts' : 'session-workspace.history'))
        return RemoteSessionViews.refused('forbidden', 'This session command is unsupported by the source')
      // A detached viewer loses grants, while the accepted promise and its replay entry remain.
      const stored = await this.replay.runOrRefuse(JSON.stringify([peerId, view.sessionId]), request.operationId,
        JSON.stringify({ operation: request.operation, body: request.body }), async () => {
          try { return await this.deps.press(view, request.body, request.operationId) }
          catch (error) { return RemoteSessionViews.refused('operation-failed', ErrorText.of(error)) }
        })
      return stored.ok ? stored.value : stored
    } else if (request.operation === 'sidebar.request' || request.operation === 'sidebar.page' || request.operation === 'reviews.request' || request.operation === 'reviews.page' || request.operation === 'tasks.request' || request.operation === 'tasks.page' || request.operation === 'files.request' || request.operation === 'files.page' || request.operation === 'changes.request' || request.operation === 'changes.page' || request.operation === 'items.request' || request.operation === 'items.page' || request.operation === 'items.open') {
      if (!peer.capabilities.includes(RemoteSessionSchemas.viewCapabilities[request.operation]) || !this.deps.read)
        return RemoteSessionViews.refused('forbidden', 'Remote content is unsupported')
      if (request.operation === 'reviews.request' && request.body.kind === 'create' && !peer.capabilities.includes('session-workspace.commands'))
        return RemoteSessionViews.refused('forbidden', 'Opening source reviews requires session workspace commands support')
      if (request.operation === 'reviews.request' && (request.body.kind === 'workflow'
        || request.body.kind === 'decide' && request.body.decision.kind === 'finish')
        && (!peer.capabilities.includes('session-workspace.finish') || !peer.capabilities.includes('session-workspace.actions')))
        return RemoteSessionViews.refused('forbidden', 'Shared Finish approval is unsupported by this peer')
      if (request.operation === 'items.open' && request.body.item.kind === 'file' && !peer.capabilities.includes('session-workspace.files'))
        return RemoteSessionViews.refused('forbidden', 'Source files are unsupported')
      if (request.operation === 'items.open' && request.body.item.kind === 'task' && !peer.capabilities.includes('session-workspace.tasks'))
        return RemoteSessionViews.refused('forbidden', 'Source tasks are unsupported')
      try { return await this.deps.read(view, request) }
      catch (error) { return RemoteSessionViews.refused('operation-failed', ErrorText.of(error)) }
    } else throw new Error(`Unknown session view operation: ${JSON.stringify(request)}`)
  }

  isActive(view: RemoteSessionInteraction): boolean { return this.views.get(view.viewId) === view }

  releaseConnection(peer: Pick<Peer, 'connectionId' | 'remoteIdentity'>): void {
    for (const view of this.views.values())
      if (view.epoch === peer.connectionId && view.peerId === JSON.stringify([peer.remoteIdentity.remoteComputerId, peer.remoteIdentity.remoteEndpointId])) this.release(view)
  }

  private release(view: RemoteSessionInteraction): void {
    this.views.delete(view.viewId)
    this.deps.release?.(view)
  }

  private static publicView({ viewId, epoch, sessionId, viewerId }: RemoteSessionView): RemoteSessionView {
    return { viewId, epoch, sessionId, viewerId }
  }

  private static refused(code: 'invalid-request' | 'forbidden' | 'not-found' | 'unavailable' | 'operation-failed', detail: string): RemoteControlStepResult<never> {
    return { ok: false, error: { code, detail: detail.slice(0, 4096) } }
  }
}
