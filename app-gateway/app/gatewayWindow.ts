import type { ProcessPowerMessage } from '../../lib-orchestrator/shared/processWire.types'
import { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import type { UtilityWindowPort, WindowMessage, WindowTerminalPayload } from '../../lib-orchestrator/shared/windowWire.types'
import type { WindowTerminalCall } from '../../lib-orchestrator/sessionManager/windowTerminal.types'
import type { TerminalPort } from '../../lib-orchestrator/sessionManager/terminalPort'
import type { WindowRemoteCall } from '../../lib-orchestrator/remoteControl/windowRemote.types'
import type { PerfSpans } from '../../lib-orchestrator/perfMonitor/perfSpans'
import { ViewerBuffer } from './terminals/viewerBuffer'
import { WindowTerminals } from './terminals/windowTerminals'
import { WindowPeers, type WindowPeersDependencies } from './peers/windowPeers'

export class GatewayWindow {
  readonly peers: WindowPeers
  private readonly port: UtilityWindowPort
  private readonly local: WindowTerminals
  private readonly output: ViewerBuffer<WindowTerminalPayload>
  private readonly calls: ProcessCalls
  private readonly report: (message: string) => void
  private readonly timer: ReturnType<typeof setInterval>
  private closed: boolean

  constructor(windowId: string, accepting: boolean, port: UtilityWindowPort,
    terminals: Pick<TerminalPort, 'capabilities' | 'attach' | 'input' | 'resize' | 'setGeometryActive' | 'detach' | 'authorize'>,
    remote: WindowPeersDependencies, perf: PerfSpans, report: (message: string) => void) {
    this.closed = false
    this.port = port
    this.report = report
    this.output = new ViewerBuffer({
      bytesOf: (value, generation, sequence) => Buffer.byteLength(JSON.stringify({ ...value, generation, sequence }), 'utf8'),
      send: (value, generation, sequence) => port.postMessage({ ...value, generation, sequence }),
      truncate: generation => {
        this.local.truncate()
        this.peers.truncate()
        port.postMessage({ type: 'stream-truncated', generation })
      },
      resume: () => { this.local.resume(); this.peers.resume() },
    })
    this.local = new WindowTerminals(windowId, accepting, terminals, this.output, perf, report, () => this.close())
    this.peers = new WindowPeers(windowId, accepting, remote, this.output, perf, report, () => this.close())
    this.calls = new ProcessCalls({ send: message => port.postMessage(message),
      invoke: (target, method, args, context) => {
        if (target === 'terminal') return this.local.invoke({ method, args } as WindowTerminalCall, context)
        else if (target === 'remote') return this.peers.invoke({ method, args } as WindowRemoteCall, context)
        else throw new Error(`Unknown window call target: ${target}`)
      },
      event: () => { throw new Error('Window events are not accepted') }, report,
    })
    port.on('message', ({ data }: { data: WindowMessage }) => {
      try { this.receive(data) }
      catch (error) { this.report(String(error)); this.close() }
    })
    port.on('close', () => this.close())
    this.timer = setInterval(() => {
      try { port.postMessage({ type: 'alive' }) }
      catch (error) { this.report(String(error)); this.close() }
    }, 1_000)
    this.timer.unref?.()
    try { port.start() }
    catch (error) { this.report(String(error)); this.close() }
  }

  power(message: ProcessPowerMessage): void {
    if (this.closed) return
    this.calls.power(message)
    this.port.postMessage(message)
  }

  authorize(attachId: string): Promise<string | null> { return this.local.authorize(attachId) }
  changed(): void { if (!this.closed) this.calls.emit('window', 'remote:changed', []) }
  setAccepting(value: boolean): void { this.local.setAccepting(value); this.peers.setAccepting(value) }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.calls.close()
    this.output.close()
    try { this.local.close() }
    finally {
      try { this.peers.close() }
      finally {
        try { this.port.close() }
        catch (error) { this.report(String(error)) }
      }
    }
  }

  private receive(message: WindowMessage): void {
    if (this.closed) return
    switch (message.type) {
      case 'frame-received': this.output.received(message.generation, message.sequence, message.failed === true); return
      case 'stream-reset': this.output.resetReceived(message.generation); return
      case 'call': case 'pending': case 'reply': case 'cancel': case 'received': case 'event': this.calls.receive(message); return
      case 'power': case 'alive': case 'terminal-frame': case 'remote-terminal-frame': case 'stream-truncated': throw new Error(`Unexpected window message: ${message.type}`)
      default: throw new Error(`Unknown window message: ${(message as { type: string }).type}`)
    }
  }
}
