import type { ProcessCalls, ProcessCallContext } from '../../../lib-orchestrator/shared/processCalls'
import type { PerfSpans } from '../../../lib-orchestrator/perfMonitor/perfSpans'
import { RemoteControlLiveTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlLiveTerminal'
import { RemoteControlPeerKeys } from '../../../lib-orchestrator/remoteControl/remoteControlPeerKeys'
import { RemoteControlAuditRows } from '../../../lib-orchestrator/remoteControl/remoteControlAuditRows'
import type { PeerAuthority, PeerProcessIdentity, PeerProcessState } from '../../../lib-orchestrator/remoteControl/peerProcess.types'
import type { RemoteControlEventKind } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlPeerIdentity } from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteControlListenerSettings } from '../../../lib-orchestrator/remoteControl/remotePeerListener.types'
import { PeerTrustSet } from '../../../lib-orchestrator/remoteControl/peerTrustSet'
import { RemoteControlInboundRegistry } from './remoteControlInboundRegistry'
import { RemoteControlPeerServer } from './remoteControlPeerServer'
import { RemotePeerListenerManager } from './remotePeerListenerManager'

export class GatewayPeers {
  private readonly calls: Pick<ProcessCalls, 'call' | 'emit'>
  private readonly terminals: ConstructorParameters<typeof RemoteControlLiveTerminal>[0]
  private readonly perf: Pick<PerfSpans, 'span'>
  private readonly trust: PeerTrustSet
  private listener: RemotePeerListenerManager | null
  private inbound: RemoteControlInboundRegistry | null
  private bundleText: string | null
  private stopping: boolean
  private stopped: Promise<void> | null
  private readonly changed: () => void

  constructor(calls: GatewayPeers['calls'], terminals: GatewayPeers['terminals'], perf: Pick<PerfSpans, 'span'>, changed: () => void) {
    this.calls = calls
    this.terminals = terminals
    this.perf = perf
    this.trust = new PeerTrustSet()
    this.listener = null
    this.inbound = null
    this.bundleText = null
    this.stopping = false
    this.stopped = null
    this.changed = changed
  }

  state(): PeerProcessState { return { listener: this.listener?.runtime() ?? { status: 'disabled' }, inbound: this.inbound?.snapshot() ?? [] } }

  async invoke(method: string, args: unknown[], _context: ProcessCallContext): Promise<unknown> {
    switch (method) {
      case 'initialize': return this.initialize(args[0] as PeerProcessIdentity)
      case 'apply': {
        if (!this.listener) throw new Error('Gateway peers are not initialized')
        return this.listener.apply(args[0] as RemoteControlListenerSettings)
      }
      case 'trust': {
        this.trust.replace(args[0] as readonly RemoteControlPeerIdentity[])
        await this.inbound?.reconcileTrust()
        return
      }
      case 'revoke': {
        const [computerId, endpointId] = args as [string, string]
        this.trust.revoke(computerId, endpointId)
        await this.inbound?.closeEndpoint(computerId, endpointId)
        return
      }
      case 'stop': return this.stop()
      default: throw new Error(`Unknown gateway peer operation: ${method}`)
    }
  }

  event(name: string, payload: unknown): void {
    switch (name) {
      case 'begin-stop': this.beginStop(); return
      case 'bundle': this.bundleText = payload as string | null; return
      case 'publish': this.inbound?.publishEvent(payload as RemoteControlEventKind); return
      default: throw new Error(`Unknown gateway peer event: ${name}`)
    }
  }

  beginStop(): void { this.stopping = true; this.listener?.beginStop() }

  stop(): Promise<void> {
    this.beginStop()
    this.stopped ??= this.drain()
    return this.stopped
  }

  private initialize(value: PeerProcessIdentity): void {
    if (this.listener || this.stopping) throw new Error('Gateway peers cannot initialize twice or while stopping')
    this.trust.replace(value.trust)
    this.bundleText = value.bundleText
    const terminal = new RemoteControlLiveTerminal(this.terminals, {
      onError: message => this.report(message),
      files: {
        saveImage: (sessionId, bytes) => this.calls.call('peer-work', 'paste-image', [sessionId, bytes]),
        receive: (uploadId, sessionId, chunk) => this.calls.call('peer-work', 'paste-file', [uploadId, sessionId, chunk]),
      },
    })
    this.inbound = new RemoteControlInboundRegistry({
      perf: this.perf, terminal, trust: this.trust,
      audit: {
        socket: (transport, request, response, caller) => {
          this.calls.emit('peer-work', 'audit', RemoteControlAuditRows.socket(Date.now(), transport, request, response, caller))
        },
        peerControl: (request, response, caller) => {
          this.calls.emit('peer-work', 'audit', RemoteControlAuditRows.control(Date.now(), 'peer-control', request, response, caller))
        },
      },
      forward: {
        execute: (peer, request, signal) => this.calls.call('peer-work', 'execute', [GatewayPeers.authority(peer), request], { signal }),
        view: (peer, request, signal) => this.calls.call('peer-work', 'view', [GatewayPeers.authority(peer), request], { signal }),
        state: (peer, request, signal) => this.calls.call('peer-work', 'state', [GatewayPeers.authority(peer), request], { signal }),
        releaseConnection: peer => { this.calls.emit('peer-work', 'release', GatewayPeers.authority(peer)) },
      },
      onChanged: () => this.publish(), onError: message => this.report(message),
    })
    this.listener = new RemotePeerListenerManager({
      serverFactory: () => new RemoteControlPeerServer({
        identity: value.identity, sign: payload => RemoteControlPeerKeys.sign(value.privateKey, payload),
        trustedInbound: (computerId, endpointId) => this.trust.trustedInbound(computerId, endpointId),
        onConnection: connection => this.inbound!.add(connection),
        onUnknownPeer: (claimant, remoteAddress) => { this.calls.emit('peer-work', 'unknown-peer', { claimant, remoteAddress }) },
        pairingBundleText: () => this.bundleText, onError: message => this.report(message),
      }),
      onBound: async (host, port) => { this.bundleText = await this.calls.call('peer-work', 'bound', [host, port]) },
      onChanged: () => this.publish(),
    })
    this.publish()
  }

  private async drain(): Promise<void> {
    try { await this.listener?.stop() }
    finally { await this.inbound?.stop() }
  }

  private publish(): void {
    this.calls.emit('peers', 'state', this.state())
    this.changed()
  }

  private report(message: string): void {
    if (!this.calls.emit('diagnostics', 'terminal-error', message)) console.error(message)
  }

  private static authority(peer: PeerAuthority): PeerAuthority {
    return { connectionId: peer.connectionId, remoteIdentity: peer.remoteIdentity, capabilities: peer.capabilities }
  }
}
