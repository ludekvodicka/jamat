import type { PeerAuthority } from './peerProcess.types'
import type { RemoteSessionViewRequest } from './remoteSessionApi.types'
import { RemoteSessionSchemas } from './remoteSessionSchemas'

export class RemoteSessionCapabilities {
  static refusal(peer: PeerAuthority, request: RemoteSessionViewRequest): string | null {
    if (!peer.capabilities.includes('session-workspace.views') || request.epoch !== peer.connectionId)
      return 'Session view connection is not admitted'
    if (!peer.capabilities.includes(RemoteSessionSchemas.viewCapabilities[request.operation]))
      return request.operation === 'actions.press' ? 'Session actions are unsupported' : 'Remote content is unsupported'
    if (request.operation === 'actions.press' && 'kind' in request.body) {
      let capability: 'session-workspace.conflicts' | 'session-workspace.history'
      if (request.body.kind === 'resolve-conflict') capability = 'session-workspace.conflicts'
      else if (request.body.kind === 'clear-history') capability = 'session-workspace.history'
      else throw new Error(`Unknown session command: ${JSON.stringify(request.body)}`)
      if (!peer.capabilities.includes(capability)) return 'This session command is unsupported by the source'
    }
    if (request.operation === 'reviews.request' && request.body.kind === 'create' && !peer.capabilities.includes('session-workspace.commands'))
      return 'Opening source reviews requires session workspace commands support'
    if (request.operation === 'reviews.request' && (request.body.kind === 'workflow'
      || request.body.kind === 'decide' && request.body.decision.kind === 'finish')
      && (!peer.capabilities.includes('session-workspace.finish') || !peer.capabilities.includes('session-workspace.actions')))
      return 'Shared Finish approval is unsupported by this peer'
    if (request.operation === 'items.open' && request.body.item.kind === 'file' && !peer.capabilities.includes('session-workspace.files'))
      return 'Source files are unsupported'
    if (request.operation === 'items.open' && request.body.item.kind === 'task' && !peer.capabilities.includes('session-workspace.tasks'))
      return 'Source tasks are unsupported'
    return null
  }
}
