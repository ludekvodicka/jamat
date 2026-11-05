import type { EventEmitter } from 'node:events'
import { writeSync } from 'node:fs'
import { join } from 'node:path'
import { AwakeClock } from '../../lib-orchestrator/shared/awakeClock'
import { ProcessCalls } from '../../lib-orchestrator/shared/processCalls'
import type { ProcessCallContext } from '../../lib-orchestrator/shared/processCalls'
import type { ProcessMessage, ProcessPort, ProcessStoppedMessage } from '../../lib-orchestrator/shared/processWire.types'
import { PerfMonitor } from '../../lib-orchestrator/perfMonitor/perfMonitor'
import { PerfNames } from '../../lib-orchestrator/perfMonitor/perfNames'
import { PerfProfiler } from '../../lib-orchestrator/perfMonitor/perfProfiler'
import type { PerfBuild } from '../../lib-orchestrator/perfMonitor/perfRecord.types'
import { ClientStatePaths } from '../../lib-orchestrator/shared/clientStatePaths'
import { OrchestratorRequestMethodsConst, OrchestratorNoticeMethodsConst } from '../../lib-orchestrator/clientApi/orchestratorProcess'
import type { ShellSnapshot } from '../../lib-orchestrator/clientApi/orchestratorProcess.types'
import type { OrchestratorApi } from '../../lib-orchestrator/clientApi/orchestratorApi.types'
import type { ServiceCaller } from '../../lib-orchestrator/clientApi/serviceTransport.types'
import { OrchestratorHub } from './appHub'
import { OrchestratorAppContext } from './appContext'
import { ShellPortClient } from './ports/shellPortClient'
import { WindowServiceTransport } from './ports/windowServiceTransport'

export type OrchestratorParentPort = Pick<EventEmitter, 'on'> & { postMessage(message: ProcessMessage): void }

export class OrchestratorApp {
  private readonly parent: OrchestratorParentPort
  private readonly build: PerfBuild
  private readonly bundleDirectory: string
  private readonly exit: (code: number) => void
  private readonly clock: AwakeClock
  private readonly calls: ProcessCalls
  private readonly callers: Map<string, ServiceCaller>
  private perf: PerfMonitor | null
  private hub: OrchestratorHub | null
  private shell: ShellPortClient | null
  private windows: WindowServiceTransport | null
  private gateway: ProcessCalls | null
  private gatewayPort: ProcessPort | null
  private timer: ReturnType<typeof setInterval> | null
  private lastHeartbeat: number
  private initialized: boolean
  private initializing: Promise<void> | null
  private stopping: Promise<void> | null
  private smoke: boolean

  constructor(parent: OrchestratorParentPort, build: PerfBuild, bundleDirectory: string, exit: (code: number) => void, now: () => number = () => performance.now()) {
    this.parent = parent
    this.build = build
    this.bundleDirectory = bundleDirectory
    this.exit = exit
    this.clock = new AwakeClock(now)
    this.lastHeartbeat = this.clock.now()
    this.callers = new Map()
    this.perf = null
    this.hub = null
    this.shell = null
    this.windows = null
    this.gateway = null
    this.gatewayPort = null
    this.timer = null
    this.initialized = false
    this.initializing = null
    this.stopping = null
    this.smoke = false
    this.calls = new ProcessCalls({ send: message => parent.postMessage(message),
      invoke: (target, method, args, context) => this.invoke(target, method, args, context),
      event: (target, name, payload) => this.event(target, name, payload), report: message => console.error(message) })
  }
  start(): void {
    this.parent.on('message', ({ data, ports }: { data: ProcessMessage; ports?: ProcessPort[] }) => {
      void this.receive(data, ports).catch(error => {
        try { this.parent.postMessage({ type: 'startup-error', error: String(error) }) } catch { /* Parent loss still drains the owners. */ }
        void this.stop(1)
      })
    })
    this.parent.on('close', () => { void this.stop(0) })
    this.parent.postMessage({ type: 'hello', process: 'orchestrator', build: this.build })
    this.timer = setInterval(() => { setTimeout(() => this.checkParent(), 0).unref?.() }, 1_000)
  }
  private async receive(message: ProcessMessage, ports?: ProcessPort[]): Promise<void> {
    switch (message.type) {
      case 'initialize': {
        if (this.initialized || this.stopping || !message.bootstrap || ports?.length !== 1) throw new Error('Orchestrator initialization requires its bootstrap and private gateway endpoint')
        this.initialized = true
        this.smoke = message.bootstrap.smoke
        const context = new OrchestratorAppContext(message.bootstrap, this.build, this.bundleDirectory)
        const directory = ClientStatePaths.perfDirectory(message.identity.configIdentity, message.identity.channel)
        const names = new PerfNames(Object.keys(OrchestratorHub.ipcChannelsConst))
        this.perf = new PerfMonitor({ process: 'orchestrator', build: this.build, directory, names,
          profiler: new PerfProfiler(join(directory, 'profiles'), 'orchestrator'), report: value => console.error(value) })
        this.perf.start()
        const port = this.gatewayPort = ports[0]!
        this.gateway = new ProcessCalls({ send: value => port.postMessage(value),
          invoke: (target, method, args, context) => {
            if (target !== 'peer-work' || !this.hub) throw new Error('Unknown orchestration peer request')
            return this.hub.transport.invoke(method, args, context)
          }, event: (target, name, payload) => this.hub!.transport.event(target, name, payload), report: value => console.error(value) })
        this.shell = new ShellPortClient(this.calls, message.bootstrap.shell)
        this.windows = new WindowServiceTransport((channel, args) => { this.calls.emit('renderer-events', channel, args) })
        this.hub = new OrchestratorHub(context.runtime, this.shell, this.windows, this.gateway, this.perf, names,
          event => { this.calls.emit('orchestrator', 'event', event) })
        port.on('message', ({ data }: { data: ProcessMessage }) => {
          try {
            switch (data.type) {
              case 'host-connection': this.hub!.api.hostConnection(data.value); this.hub!.publishProjection(); return
              case 'heartbeat': this.gateway!.alive(); port.postMessage({ type: 'heartbeat-reply', seq: data.seq }); return
              case 'heartbeat-reply': this.gateway!.alive(); return
              case 'call': case 'pending': case 'reply': case 'received': case 'cancel': case 'event': this.gateway!.receive(data); return
              default: throw new Error('Unexpected gateway message: ' + data.type)
            }
          } catch (error) { console.error(error); void this.stop(1) }
        })
        port.on('close', () => { this.hub?.api.hostClosed(); void this.stop(1) })
        port.start()
        this.initializing = this.hub.initialize()
        await this.initializing
        if (!this.stopping) this.parent.postMessage({ type: 'ready' })
        return
      }
      case 'heartbeat': {
        const gap = this.clock.now() - this.lastHeartbeat
        if (gap > 2_000) this.perf?.event({ kind: 'unresponsive', target: 'main', ms: gap - 1_000 })
        this.lastHeartbeat = this.clock.now()
        this.calls.alive()
        this.hub?.publishProjection()
        this.parent.postMessage({ type: 'heartbeat-reply', seq: message.seq })
        return
      }
      case 'power':
        if (this.clock.power(message.epoch, message.event).late) this.lastHeartbeat = this.clock.now()
        this.calls.power(message)
        this.gateway?.power(message)
        this.windows?.power(message)
        return
      case 'window-port':
        if (!this.windows || !message.caller || message.caller.id !== message.epoch || ports?.length !== 1) throw new Error('Window endpoint requires a broker-proven caller')
        this.callers.set(message.windowId, message.caller)
        this.windows.open(message.caller, ports[0]!)
        return
      case 'window-close': {
        const caller = this.callers.get(message.windowId)
        if (caller?.id === message.epoch) this.windows?.close(caller, message.reason ?? 'reload')
        if (caller?.id === message.epoch && message.reason === 'closed') this.callers.delete(message.windowId)
        return
      }
      case 'stop': void this.stop(0); return
      case 'call': case 'pending': case 'reply': case 'cancel': case 'received': case 'event': this.calls.receive(message); return
      case 'window-accepting': return
      case 'hello': case 'ready': case 'heartbeat-reply': case 'alive': case 'startup-error': case 'stopped': case 'host-connection': case 'orchestrator-port':
        throw new Error('Unexpected parent message: ' + message.type)
      default: throw new Error('Unknown parent message: ' + (message as { type: string }).type)
    }
  }
  private async invoke(target: string, method: string, args: unknown[], context: ProcessCallContext): Promise<unknown> {
    if (target === 'debug' && method === 'block') return this.block(args[0])
    if (target !== 'orchestrator' || !this.hub || !OrchestratorRequestMethodsConst.some(name => name === method)) throw new Error('Unknown orchestration request: ' + method)
    context.pending()
    const api = this.hub.api
    const requestId = method === 'mediaOpen' ? (args[0] as Parameters<OrchestratorApi['mediaOpen']>[0]).requestId : null
    const cancel = (): void => { if (requestId !== null) api.mediaCancel(requestId) }
    context.signal.addEventListener('abort', cancel, { once: true })
    try {
      context.signal.throwIfAborted()
      return await (api[method as typeof OrchestratorRequestMethodsConst[number]] as (...values: unknown[]) => unknown)(...args)
    } finally { context.signal.removeEventListener('abort', cancel) }
  }
  private event(target: string, name: string, payload: unknown): void {
    if (target === 'shell') {
      if (name === 'snapshot') this.shell!.update(payload as ShellSnapshot)
      else if (name === 'notice') { const value = payload as { id: string; event: 'clicked' | 'closed' }; this.shell!.notice(value.id, value.event) }
      else throw new Error('Unknown shell event: ' + name)
    } else if (target === 'orchestrator') {
      if (!this.hub) throw new Error('Orchestrator is not initialized')
      if (name === 'beginQuit') this.hub.beginQuit()
      else if (OrchestratorNoticeMethodsConst.some(method => method === name))
        (this.hub.api[name as typeof OrchestratorNoticeMethodsConst[number]] as (...args: unknown[]) => void)(...payload as unknown[])
      else throw new Error('Unknown orchestration notice: ' + name)
    } else throw new Error('Unknown parent event target: ' + target)
  }
  private block(value: unknown): void {
    const request = value as { target?: string; id?: string; milliseconds?: number }
    if (!this.smoke || request?.target !== 'orchestrator' || typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.id)
      || (request.milliseconds !== 3_000 && request.milliseconds !== 20_000)) throw new Error('Invalid smoke orchestration block')
    const boundary = (phase: 'start' | 'end'): void => { writeSync(1, '[latency-smoke] ' + JSON.stringify({ kind: 'block', phase,
      id: request.id, target: request.target, process: 'orchestrator', pid: process.pid, milliseconds: request.milliseconds,
      at: Number(process.hrtime.bigint()) / 1e6 }) + '\n') }
    boundary('start')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, request.milliseconds)
    boundary('end')
  }
  checkParent(): void {
    this.clock.tick()
    const ms = this.clock.now() - this.lastHeartbeat
    if (this.stopping || ms < 30_000) return
    this.perf?.event({ kind: 'hang', target: 'main', ms })
    void this.stop(1)
  }
  stop(code: number): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.hub?.beginQuit()
    for (const caller of this.callers.values()) this.windows?.close(caller, 'closed')
    this.callers.clear()
    this.windows?.stop()
    this.stopping = (async () => {
      const deadline = setTimeout(() => this.exit(code), 15_000)
      let recordsSettled = false
      try {
        await this.initializing?.catch(() => {})
        recordsSettled = await this.hub?.dispose() ?? false
        await this.perf?.stop()
      } catch (error) { console.error('Orchestrator cleanup failed: ' + String(error)) }
      finally {
        clearTimeout(deadline)
        this.shell?.dispose()
        this.gateway?.close()
        this.gatewayPort?.close()
        this.calls.close()
        const receipt: ProcessStoppedMessage = { type: 'stopped', process: 'orchestrator', recordsSettled }
        try { writeSync(1, '[client-drain] ' + JSON.stringify(receipt) + '\n') } catch { /* Lost output must not prevent process exit. */ }
        try { this.parent.postMessage(receipt) } catch { /* A departed parent cannot receive the drain result. */ }
        this.exit(code)
      }
    })()
    return this.stopping
  }
}
