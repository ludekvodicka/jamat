import type { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { PeerProcessIdentity, PeerProcessState } from '../../../lib-orchestrator/remoteControl/peerProcess.types'
import type { RemoteControlPeerIdentity } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteControlEventKind } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemotePeerListenerPort, RemoteInboundPort, RemoteControlListenerSettings, RemoteListenerApplyResult } from '../../../lib-orchestrator/remoteControl/remotePeerListener.types'

export class GatewayPeerClient implements RemotePeerListenerPort, RemoteInboundPort {
  private readonly calls: Pick<ProcessCalls, 'call' | 'emit'>
  private readonly onChanged: () => void
  private readonly flush: () => void
  private state: PeerProcessState
  private initialized: boolean
  private stopped: Promise<void> | null

  constructor(calls: Pick<ProcessCalls, 'call' | 'emit'>, onChanged: () => void, flush: () => void) {
    this.calls = calls
    this.onChanged = onChanged
    this.flush = flush
    this.state = { listener: { status: 'disabled' }, inbound: [] }
    this.initialized = false
    this.stopped = null
  }

  async initialize(identity: PeerProcessIdentity): Promise<void> {
    await this.calls.call('peers', 'initialize', [identity])
    this.initialized = true
  }

  runtime(): PeerProcessState['listener'] { return structuredClone(this.state.listener) }
  snapshot(): PeerProcessState['inbound'] { return structuredClone(this.state.inbound) }
  apply(settings: RemoteControlListenerSettings): Promise<RemoteListenerApplyResult> { return this.calls.call('peers', 'apply', [settings]) }
  updateTrust(trust: readonly RemoteControlPeerIdentity[]): Promise<void> { return this.calls.call('peers', 'trust', [trust]) }
  closeEndpoint(computerId: string, endpointId: string): Promise<void> { return this.calls.call('peers', 'revoke', [computerId, endpointId]) }
  publishEvent(kind: RemoteControlEventKind): void { if (this.initialized) this.calls.emit('peers', 'publish', kind) }
  beginStop(): void { if (this.initialized) this.calls.emit('peers', 'begin-stop', null) }

  stop(): Promise<void> {
    this.beginStop()
    this.stopped ??= (this.initialized ? this.calls.call<void>('peers', 'stop', []) : Promise.resolve()).finally(this.flush)
    return this.stopped
  }

  event(name: string, payload: unknown): void {
    if (name !== 'state') throw new Error(`Unknown peer state event: ${name}`)
    this.state = payload as PeerProcessState
    this.onChanged()
  }
}
