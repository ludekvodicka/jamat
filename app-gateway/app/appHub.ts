import type { ControllerLeaseRelease } from '../../lib-orchestrator/hostClient/hostClient.types'
import { LocalHostConnection } from '../../lib-orchestrator/hostClient/hostConnection'
import { TerminalAttachSocket } from '../../lib-orchestrator/hostClient/terminalAttachSocket'
import { TerminalGateway } from '../../lib-orchestrator/sessionManager/terminalGateway'
import type { TerminalProcessCall, TerminalProcessControl } from '../../lib-orchestrator/sessionManager/terminalProcess.types'
import { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import type { ProcessCallMessage, ProcessMessage, ProcessPowerMessage, ProcessPort } from '../../lib-orchestrator/shared/processWire.types'
import type { PerfSpans } from '../../lib-orchestrator/perfMonitor/perfSpans'
import { GatewayTerminalService } from './terminals/gatewayTerminalService'
import type { GatewayAppContext } from './appContext'
import type { UtilityWindowPort } from '../../lib-orchestrator/shared/windowWire.types'
import { GatewayWindow } from './gatewayWindow'
import { GatewayPeers } from './peers/gatewayPeers'
import { OutboundPeers } from './peers/outboundPeers'
import type { RemotePasteFileChunk } from '../../lib-orchestrator/remoteControl/remoteOutbound.types'

export class GatewayAppHub {
  private readonly connection: LocalHostConnection
  private readonly terminals: TerminalGateway
  private readonly service: GatewayTerminalService
  private readonly calls: ProcessCalls
  private readonly sent: (message: ProcessMessage) => void
  private readonly nativeCalls: ProcessCalls
  private orchestratorPort: ProcessPort | null
  private readonly pendingOrchestration: ProcessMessage[]
  private readonly peers: GatewayPeers
  private readonly outbound: OutboundPeers
  private readonly unsubscribe: () => void
  private readonly windows: Map<string, { epoch: string; terminals: GatewayWindow }>
  private readonly perf: PerfSpans
  private stopping: boolean
  private disposal: Promise<void> | null

  constructor(context: Pick<GatewayAppContext, 'hostDescriptorFile' | 'controllerId'>, perf: PerfSpans, send: (message: ProcessMessage) => void, sent: (message: ProcessMessage) => void = () => {}) {
    this.sent = sent
    this.perf = perf
    this.windows = new Map()
    this.stopping = false
    this.disposal = null
    this.orchestratorPort = null
    this.pendingOrchestration = []
    this.calls = new ProcessCalls({ send: message => this.sendOrchestration(message),
      invoke: async (target, method, args, context) => {
        if (target === 'peers') return this.peers.invoke(method, args, context)
        if (target === 'outbound') return this.outbound.invoke(method, args)
        if (target === 'windows') {
          const [windowId, epoch] = args as [string, string]
          const window = this.windows.get(windowId)
          if (window?.epoch !== epoch) {
            if (method === 'authorize' || method === 'remote-view') return Promise.resolve(null)
            throw new Error('Gateway window authorization expired')
          }
          switch (method) {
            case 'authorize': return window.terminals.authorize(args[2] as string)
            case 'remote-view': return window.terminals.peers.authorizeView(args[2] as string, args[3] as string)
            case 'remote-paste-image': return window.terminals.peers.pasteImage(args[2] as string, args[3] as string, args[4] as string)
            case 'remote-paste-file': return window.terminals.peers.pasteFile(args[2] as string, args[3] as string, args[4] as RemotePasteFileChunk)
            default: throw new Error(`Unknown window operation: ${method}`)
          }
        }
        if (target !== 'terminals') throw new Error(`Unknown gateway call target: ${target}`)
        return this.service.invoke({ method, args } as TerminalProcessCall, context)
      },
      event: (target, name, payload) => {
        if (target === 'peers') { this.peers.event(name, payload); return }
        if (target === 'outbound') { this.outbound.event(name, payload); return }
        if (target !== 'terminals') throw new Error(`Unknown gateway event target: ${target}`)
        this.service.control({ name, payload } as TerminalProcessControl)
      },
      report: message => console.error(message),
    })
    this.nativeCalls = new ProcessCalls({ send,
      invoke: async (target, method, args, context) => {
        context.pending()
        if (target === 'outbound' && method === 'session-view') return this.outbound.invoke(method, args)
        if (target !== 'windows') throw new Error('Unknown native gateway target: ' + target)
        const [windowId, epoch] = args as [string, string]
        const window = this.windows.get(windowId)
        if (window?.epoch !== epoch) {
          if (method === 'authorize' || method === 'remote-view') return null
          throw new Error('Gateway window authorization expired')
        }
        switch (method) {
          case 'authorize': return window.terminals.authorize(args[2] as string)
          case 'remote-view': return window.terminals.peers.authorizeView(args[2] as string, args[3] as string)
          case 'remote-paste-image': return window.terminals.peers.pasteImage(args[2] as string, args[3] as string, args[4] as string)
          case 'remote-paste-file': return window.terminals.peers.pasteFile(args[2] as string, args[3] as string, args[4] as RemotePasteFileChunk)
          default: throw new Error('Unknown native gateway request: ' + method)
        }
      }, event: () => { throw new Error('Native gateway events are not accepted') }, report: message => console.error(message) })
    this.connection = new LocalHostConnection({
      descriptorFile: context.hostDescriptorFile,
      controllerId: context.controllerId,
      onError: message => { if (!this.calls.emit('diagnostics', 'host-error', message)) console.error(message) },
    })
    this.terminals = new TerminalGateway({
      descriptorOf: () => this.connection.descriptor(), leaseIdOf: () => this.connection.leaseId(),
      socketFactory: deps => new TerminalAttachSocket(deps),
      onError: message => { if (!this.calls.emit('diagnostics', 'terminal-error', message)) console.error(message) },
      activity: {
        userInput: marks => this.calls.emit('terminals', 'userInput', marks),
        pendingInputHint: counts => this.calls.emit('terminals', 'pendingInputHint', [...counts]),
      },
    })
    this.peers = new GatewayPeers(this.calls, this.terminals, perf, () => this.outbound.changed())
    this.outbound = new OutboundPeers(this.calls, () => this.peers.state(), () => {
      this.nativeCalls.emit('outbound-work', 'state', this.outbound.snapshot())
      for (const window of this.windows.values()) window.terminals.changed()
    })
    this.service = new GatewayTerminalService(this.terminals, event =>
      perf.span('gateway.frame', () => this.calls.emit('terminals', event.name, event.payload)))
    this.unsubscribe = this.connection.onChanged(() => {
      if (this.connection.leaseId() !== null) this.terminals.leaseChanged()
      this.publishConnection()
    })
  }

  start(): void { this.publishConnection(); this.connection.start() }
  receive(message: ProcessCallMessage): void { this.nativeCalls.receive(message) }
  heartbeat(): void {
    this.nativeCalls.alive()
    if (this.orchestratorPort) this.orchestratorPort.postMessage({ type: 'heartbeat', seq: 0 })
    this.publishConnection()
  }

  connectOrchestrator(port: ProcessPort): void {
    if (this.orchestratorPort || this.stopping) throw new Error('Gateway orchestration endpoint is already connected or stopping')
    this.orchestratorPort = port
    port.on('message', ({ data }: { data: ProcessMessage }) => {
      try {
        switch (data.type) {
          case 'heartbeat-reply': this.calls.alive(); return
          case 'call': case 'pending': case 'reply': case 'cancel': case 'received': case 'event': this.calls.receive(data); return
          default: throw new Error('Unexpected orchestration message: ' + data.type)
        }
      } catch (error) { console.error(error); this.calls.close(); port.close() }
    })
    port.on('close', () => this.calls.close())
    port.start()
    for (const message of this.pendingOrchestration.splice(0)) { port.postMessage(message); this.sent(message) }
    this.publishConnection()
  }

  private sendOrchestration(message: ProcessMessage): void {
    if (this.orchestratorPort) { this.orchestratorPort.postMessage(message); this.sent(message) }
    else this.pendingOrchestration.push(message)
  }

  power(message: ProcessPowerMessage): void {
    this.calls.power(message)
    this.nativeCalls.power(message)
    for (const window of this.windows.values())
      try { window.terminals.power(message) }
      catch (error) { console.error(error); window.terminals.close() }
  }

  openWindow(windowId: string, epoch: string, accepting: boolean, port: UtilityWindowPort): void {
    if (this.stopping) { port.close(); return }
    this.windows.get(windowId)?.terminals.close()
    this.windows.set(windowId, { epoch, terminals: new GatewayWindow(windowId, accepting, port, this.terminals, {
      outbound: () => this.outbound.port(), snapshot: () => this.outbound.snapshot(),
      clipboard: (endpointId, privateId, signal) => this.nativeCalls.call('outbound-work', 'clipboard', [windowId, epoch, endpointId, privateId], { signal }),
      releaseMedia: (endpointId, viewId, documentId) => { this.nativeCalls.emit('outbound-work', 'release-media', { endpointId, viewId, documentId }) },
    }, this.perf,
      message => { if (!this.calls.emit('diagnostics', 'terminal-error', message)) console.error(message) }) })
  }

  setWindowAccepting(windowId: string, epoch: string, accepting: boolean): void {
    const window = this.windows.get(windowId)
    if (window?.epoch === epoch) window.terminals.setAccepting(accepting)
  }

  closeWindow(windowId: string, epoch: string): void {
    const window = this.windows.get(windowId)
    if (window?.epoch !== epoch) return
    this.windows.delete(windowId)
    window.terminals.close()
  }

  leaseRelease(): ControllerLeaseRelease { return this.connection.releaseResult() }

  stop(): Promise<void> {
    return this.disposal ??= this.drain()
  }

  private async drain(): Promise<void> {
    this.stopping = true
    try {
      for (const window of this.windows.values()) window.terminals.close()
      this.windows.clear()
      this.outbound.stop()
      try { await this.peers.stop() }
      finally { this.service.stop() }
    }
    finally {
      this.calls.close()
      this.nativeCalls.close()
      this.orchestratorPort?.close()
      this.pendingOrchestration.length = 0
      this.unsubscribe()
      await this.connection.stop()
    }
  }

  private publishConnection(): void {
    if (this.stopping) return
    this.sendOrchestration({ type: 'host-connection', value: { descriptor: this.connection.descriptor(),
      leaseId: this.connection.leaseId(), debug: this.connection.debugView() } })
  }
}
