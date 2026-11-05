import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { ProcessCallMessage, ProcessPowerMessage } from '../../../lib-orchestrator/shared/processWire.types'
import { OrchestratorRequestMethodsConst, OrchestratorNoticeMethodsConst } from '../../../lib-orchestrator/clientApi/orchestratorProcess'
import type { OrchestratorEvent, OrchestratorProjection, OrchestratorNativeApi, ShellSnapshot } from '../../../lib-orchestrator/clientApi/orchestratorProcess.types'
import type { AppClientUiIpcEventMap } from '../../../lib-orchestrator/clientApi/appClientUiIpc'
import type { ShellPort } from '../../../lib-orchestrator/shared/shellPort.types'
import { ShellPortServer } from './shellPortServer'

export class OrchestratorApiClient {
  readonly api: OrchestratorNativeApi
  private readonly calls: ProcessCalls
  private readonly shell: ShellPortServer
  private readonly ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private projection: OrchestratorProjection | null
  private configReceived: boolean
  private connected: boolean
  private closed: boolean
  private readonly report: (message: string) => void

  constructor(deps: { send(message: ProcessCallMessage): void; shell: ShellPort; shellSnapshot(): ShellSnapshot;
    event(event: OrchestratorEvent): void; publish(channel: keyof AppClientUiIpcEventMap, args: unknown[]): void; report(message: string): void }) {
    this.projection = null
    this.configReceived = false
    this.connected = false
    this.closed = false
    this.report = deps.report
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    void this.ready.catch(() => {})
    this.calls = new ProcessCalls({ send: deps.send,
      invoke: (target, method, args, context) => {
        if (target !== 'shell') throw new Error('Unknown orchestration call target: ' + target)
        return this.shell.invoke(method, args, context)
      }, event: (target, name, payload) => {
        if (target === 'shell') this.shell.event(name, payload)
        else if (target === 'renderer-events') deps.publish(name as keyof AppClientUiIpcEventMap, payload as unknown[])
        else if (target === 'orchestrator' && name === 'event') {
          const event = payload as OrchestratorEvent
          if (event.kind === 'projection') this.projection = event.value
          else {
            if (event.kind === 'config') this.configReceived = true
            deps.event(event)
          }
        } else throw new Error('Unknown orchestration event: ' + target + '/' + name)
      }, report: deps.report })
    this.shell = new ShellPortServer(deps.shell, { emit: (target, name, value) => this.connected && this.calls.emit(target, name, value) }, deps.shellSnapshot)
    const methods: Record<string, unknown> = {}
    for (const method of OrchestratorRequestMethodsConst)
      methods[method] = async (...args: unknown[]) => { await this.ready; return this.calls.call('orchestrator', method, args) }
    for (const method of OrchestratorNoticeMethodsConst)
      methods[method] = (...args: unknown[]) => this.notice(method, args)
    methods.processTree = () => this.state().processTree
    methods.snapinDefinitions = () => this.state().snapins
    this.api = methods as unknown as OrchestratorNativeApi
  }
  receive(message: ProcessCallMessage): void { this.connected = true; this.calls.receive(message) }
  initialized(): void {
    this.state()
    if (!this.configReceived) throw new Error('Orchestrator configuration is not ready')
    this.connected = true
    this.resolveReady()
  }
  private state(): OrchestratorProjection {
    if (!this.projection) throw new Error('Orchestrator projection is not ready')
    return this.projection
  }
  shellChanged(): void { if (this.connected) this.shell.changed() }
  beginQuit(): void { if (this.connected) this.calls.emit('orchestrator', 'beginQuit', null) }
  async block(request: unknown): Promise<void> { await this.ready; return this.calls.call('debug', 'block', [request]) }
  alive(): void { this.calls.alive() }
  power(message: ProcessPowerMessage): void { this.calls.power(message) }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectReady(new Error('Orchestrator stopped before ready'))
    this.shell.stop()
    this.calls.close()
  }
  private notice(method: string, args: unknown[]): void {
    if (this.closed) return
    void this.ready.then(() => { this.calls.emit('orchestrator', method, args) }).catch(error => this.report(String(error)))
  }
}
