import type { ProcessCallContext } from '../../../lib-orchestrator/shared/processCalls'
import type { PeerAuthority, PeerForwardPort } from '../../../lib-orchestrator/remoteControl/peerProcess.types'
import type { RemoteControl } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { RemoteSessionViewRequest, RemoteSessionStateRequest } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { RemoteControlPeerIdentity } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteControlAuditEntry } from '../../../lib-orchestrator/remoteControl/remoteControlAuditRows'
import { RemoteControlAuditRows } from '../../../lib-orchestrator/remoteControl/remoteControlAuditRows'
import type { PastedFileStore, PastedFileChunk } from '../../../lib-orchestrator/pastedFiles/pastedFileStore'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import type { RemoteSessionViews } from './remoteSessionViews'
import type { RemoteSessionSnapshots } from './remoteSessionSnapshots'
import type { RemoteControlAudit } from './remoteControlAudit'

export interface PeerWorkServiceDeps {
  control: Pick<RemoteControl, 'execute'>
  views: Pick<RemoteSessionViews, 'request' | 'releaseConnection'>
  snapshots: Pick<RemoteSessionSnapshots, 'page'>
  files: Pick<PastedFileStore, 'saveImage' | 'receive'>
  audit: Pick<RemoteControlAudit, 'append' | 'flush'>
  unknownPeer(claimant: RemoteControlPeerIdentity, remoteAddress: string): void
  bound(host: string, port: number): string | null
}

export class PeerWorkService implements PeerForwardPort {
  private readonly deps: PeerWorkServiceDeps
  private readonly work: Set<Promise<unknown>>
  private stopping: boolean

  constructor(deps: PeerWorkServiceDeps) { this.deps = deps; this.work = new Set(); this.stopping = false }

  async invoke(method: string, args: unknown[], context: ProcessCallContext): Promise<unknown> {
    context.signal.throwIfAborted()
    if (this.stopping) throw new Error('Peer work is stopping')
    switch (method) {
      case 'execute': {
        context.pending()
        return this.execute(args[0] as PeerAuthority, args[1], context.signal)
      }
      case 'view': {
        const peer = args[0] as PeerAuthority, request = args[1] as RemoteSessionViewRequest
        if (request.operation === 'actions.press' || request.operation === 'reviews.request') context.pending()
        return this.view(peer, request, context.signal)
      }
      case 'state': return this.state(args[0] as PeerAuthority, args[1] as RemoteSessionStateRequest, context.signal)
      case 'paste-image': return this.deps.files.saveImage(args[0] as string, args[1] as Uint8Array)
      case 'paste-file': return this.deps.files.receive(args[0] as string, args[1] as string, args[2] as PastedFileChunk)
      case 'bound': return this.deps.bound(args[0] as string, args[1] as number)
      default: throw new Error(`Unknown peer work method: ${method}`)
    }
  }

  event(name: string, payload: unknown): void {
    switch (name) {
      case 'audit': this.deps.audit.append(payload as RemoteControlAuditEntry); return
      case 'release': this.releaseConnection(payload as PeerAuthority); return
      case 'unknown-peer': {
        if (this.stopping) return
        const value = payload as { claimant: RemoteControlPeerIdentity; remoteAddress: string }
        this.deps.unknownPeer(value.claimant, value.remoteAddress)
        return
      }
      default: throw new Error(`Unknown peer work event: ${name}`)
    }
  }

  async execute(peer: PeerAuthority, request: unknown, signal: AbortSignal): ReturnType<PeerForwardPort['execute']> {
    signal.throwIfAborted()
    if (this.stopping) throw new Error('Peer work is stopping')
    const caller = {
      callerId: `remote-peer:${peer.remoteIdentity.remoteComputerId}:${peer.remoteIdentity.remoteEndpointId}`,
      callerKind: 'remote-peer' as const,
      allowedOperations: RemoteControlPeerConst.controlOperations.filter(operation => peer.capabilities.includes(`control:${operation}`)),
    }
    return this.track(this.deps.control.execute(request, caller).then(response => {
      this.deps.audit.append(RemoteControlAuditRows.control(Date.now(), 'peer-control', request, response,
        { callerId: caller.callerId, callerKind: caller.callerKind }))
      return response
    }))
  }

  async view(peer: PeerAuthority, request: RemoteSessionViewRequest, signal: AbortSignal): ReturnType<PeerForwardPort['view']> {
    signal.throwIfAborted()
    if (this.stopping) throw new Error('Peer work is stopping')
    const release = (): void => this.releaseConnection(peer)
    signal.addEventListener('abort', release, { once: true })
    return this.track(this.deps.views.request(peer, request).then(result => {
      if (signal.aborted) release()
      return result
    }))
  }

  async state(_peer: PeerAuthority, request: RemoteSessionStateRequest, signal: AbortSignal): ReturnType<PeerForwardPort['state']> {
    signal.throwIfAborted()
    return this.deps.snapshots.page(request)
  }

  releaseConnection(peer: PeerAuthority): void { this.deps.views.releaseConnection(peer) }
  flush(): void { this.deps.audit.flush() }
  beginStop(): void { this.stopping = true }

  async stop(): Promise<void> {
    this.beginStop()
    await Promise.allSettled([...this.work])
    this.flush()
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work)
    return work.finally(() => this.work.delete(work))
  }
}
