import type { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { RemoteControlRequestUnion } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteControlPeerProfile } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { OutboundProcessIdentity, RemoteOutboundPort, RemoteNetworkState } from '../../../lib-orchestrator/remoteControl/remoteOutbound.types'
import type { PeerProcessState } from '../../../lib-orchestrator/remoteControl/peerProcess.types'
import type { RemoteSessionViewRequest } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { RemoteControlPeerClient } from '../../../lib-orchestrator/remoteControl/remoteControlPeerClient'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import { RemoteConnectionsManager } from './remoteConnectionsManager'

export class OutboundPeers {
  private readonly calls: Pick<ProcessCalls, 'emit'>
  private readonly inbound: () => PeerProcessState
  private readonly notify: () => void
  private manager: RemoteConnectionsManager | null
  private profiles: readonly RemoteControlPeerProfile[]
  private revision: number
  private stopping: boolean

  constructor(calls: Pick<ProcessCalls, 'emit'>, inbound: OutboundPeers['inbound'], notify: () => void) {
    this.calls = calls
    this.inbound = inbound
    this.notify = notify
    this.manager = null
    this.profiles = []
    this.revision = 0
    this.stopping = false
  }

  invoke(method: string, args: unknown[]): unknown {
    switch (method) {
      case 'initialize': return this.initialize(args[0] as OutboundProcessIdentity)
      case 'execute': return this.port().execute(args[0] as string, args[1] as RemoteControlRequestUnion)
      case 'session-view': return this.port().sessionView(args[0] as string, args[1] as RemoteSessionViewRequest)
      case 'network-state': return this.networkState()
      case 'stop': this.stop(); return
      default: throw new Error(`Unknown outbound peer operation: ${method}`)
    }
  }

  event(name: string, payload: unknown): void {
    if (this.stopping) return
    switch (name) {
      case 'profiles':
        this.profiles = structuredClone(payload as readonly RemoteControlPeerProfile[])
        if (!this.manager) throw new Error('Outbound peers are not initialized')
        this.manager.reloadProfiles()
        return
      case 'retry':
        if (!this.manager) throw new Error('Outbound peers are not initialized')
        this.manager.retryNow(payload as string)
        return
      case 'changed': this.changed(); return
      case 'stop': this.stop(); return
      default: throw new Error(`Unknown outbound peer event: ${name}`)
    }
  }

  port(): RemoteOutboundPort {
    if (!this.manager) throw new Error('Outbound peers are not initialized')
    return this.manager
  }

  snapshot(): RemoteConnectionsSnapshot {
    return this.networkState().connections
  }

  private networkState(): RemoteNetworkState {
    const inbound = this.inbound()
    return { listener: inbound.listener,
      connections: { revision: this.revision, outbound: this.manager?.snapshot().outbound ?? [], inbound: inbound.inbound } }
  }

  changed(): void {
    this.revision++
    this.calls.emit('outbound', 'state', this.snapshot())
    this.notify()
  }

  stop(): void { this.stopping = true; this.manager?.stop() }

  private initialize(value: OutboundProcessIdentity): void {
    if (this.manager || this.stopping) throw new Error('Outbound peers cannot initialize twice or while stopping')
    this.profiles = structuredClone(value.profiles)
    const client = new RemoteControlPeerClient(value.identity, payload => RemoteControlPeerKeys.sign(value.privateKey, payload), {
      onError: message => this.calls.emit('diagnostics', 'terminal-error', message),
    })
    this.manager = new RemoteConnectionsManager({
      identity: value.identity, profiles: () => this.profiles, connect: (profile, signal) => client.connect(profile, signal),
      onChanged: () => this.changed(),
      onSessionRemoved: (endpointId, sessionId) => { this.calls.emit('outbound', 'session-removed', { endpointId, sessionId }) },
      onError: message => { this.calls.emit('diagnostics', 'terminal-error', message) },
    })
    this.manager.start()
    this.changed()
  }
}
