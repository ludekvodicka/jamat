import type { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteControlPeerProfile } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { OutboundProcessIdentity, RemoteOutboundPort, RemoteOutboundProfiles, RemoteWindowIdentity, RemoteNetworkState } from '../../../lib-orchestrator/remoteControl/remoteOutbound.types'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'

export class GatewayOutboundClient implements RemoteOutboundProfiles {
  private readonly calls: Pick<ProcessCalls, 'call' | 'emit'>
  private readonly profiles: () => readonly RemoteControlPeerProfile[]
  private readonly changed: () => void
  private readonly removed: (endpointId: string, sessionId: string) => void
  private state: RemoteConnectionsSnapshot
  private initialized: boolean

  constructor(calls: GatewayOutboundClient['calls'], profiles: GatewayOutboundClient['profiles'], changed: () => void,
    removed: GatewayOutboundClient['removed']) {
    this.calls = calls
    this.profiles = profiles
    this.changed = changed
    this.removed = removed
    this.state = { revision: 0, outbound: [], inbound: [] }
    this.initialized = false
  }

  async initialize(identity: Omit<OutboundProcessIdentity, 'profiles'>): Promise<void> {
    await this.calls.call('outbound', 'initialize', [{ ...identity, profiles: this.profiles() } satisfies OutboundProcessIdentity])
    this.initialized = true
  }

  snapshot(): RemoteConnectionsSnapshot { return structuredClone(this.state) }
  networkState(): Promise<RemoteNetworkState> { return this.calls.call('outbound', 'network-state', []) }
  viewEpoch(endpointId: string): string | null {
    const state = this.state.outbound.find(endpoint => endpoint.remoteEndpointId === endpointId)
    return state?.status === 'connected' ? state.connectionId : null
  }
  execute(...args: Parameters<RemoteOutboundPort['execute']>): ReturnType<RemoteOutboundPort['execute']> { return this.calls.call('outbound', 'execute', args) }
  sessionView(...args: Parameters<RemoteOutboundPort['sessionView']>): ReturnType<RemoteOutboundPort['sessionView']> { return this.calls.call('outbound', 'session-view', args) }
  reloadProfiles(): void { if (this.initialized) this.calls.emit('outbound', 'profiles', this.profiles()) }
  retryNow(endpointId: string): void { if (this.initialized) this.calls.emit('outbound', 'retry', endpointId) }
  notifyChanged(): void { if (this.initialized) this.calls.emit('outbound', 'changed', null) }
  stop(): void { if (this.initialized) this.calls.emit('outbound', 'stop', null) }

  authorizeView(window: RemoteWindowIdentity, endpointId: string, viewId: string): Promise<RemoteSessionView | null> {
    return this.calls.call('windows', 'remote-view', [window.windowId, window.epoch, endpointId, viewId])
  }
  pasteImage(window: RemoteWindowIdentity, ...args: Parameters<RemoteOutboundPort['terminalPasteImage']>): ReturnType<RemoteOutboundPort['terminalPasteImage']> {
    return this.calls.call('windows', 'remote-paste-image', [window.windowId, window.epoch, ...args])
  }
  pasteFile(window: RemoteWindowIdentity, ...args: Parameters<RemoteOutboundPort['terminalPasteFile']>): ReturnType<RemoteOutboundPort['terminalPasteFile']> {
    return this.calls.call('windows', 'remote-paste-file', [window.windowId, window.epoch, ...args])
  }

  event(name: string, payload: unknown): void {
    switch (name) {
      case 'state': this.state = payload as RemoteConnectionsSnapshot; this.changed(); return
      case 'session-removed': {
        const value = payload as { endpointId: string; sessionId: string }
        this.removed(value.endpointId, value.sessionId)
        return
      }
      default: throw new Error(`Unknown outbound peer state: ${name}`)
    }
  }
}
