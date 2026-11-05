import { writeSync } from 'node:fs'
import type { ControllerLeaseRelease } from '../../lib-orchestrator/hostClient/hostClient.types'
import { AwakeClock } from '../../lib-orchestrator/shared/awakeClock'
import type { EventEmitter } from 'node:events'
import { SmokeForwardTrace } from './smokeForwardTrace'
import { PerfMonitor } from '../../lib-orchestrator/perfMonitor/perfMonitor'
import { PerfNames } from '../../lib-orchestrator/perfMonitor/perfNames'
import { PerfProfiler } from '../../lib-orchestrator/perfMonitor/perfProfiler'
import type { PerfBuild } from '../../lib-orchestrator/perfMonitor/perfRecord.types'
import type { ProcessMessage, ProcessPort, ProcessStoppedMessage } from '../../lib-orchestrator/shared/processWire.types'
import type { UtilityWindowPort } from '../../lib-orchestrator/shared/windowWire.types'
import { GatewayLock } from './gatewayLock'
import { GatewayAppHub } from './appHub'
import { GatewayAppContext } from './appContext'

export type GatewayParentPort = Pick<EventEmitter, 'on'> & { postMessage(message: ProcessMessage): void }

export class GatewayApp {
  private readonly parent: GatewayParentPort
  private readonly build: PerfBuild
  private readonly exit: (code: number) => void
  private readonly clock: AwakeClock
  private readonly now: () => number
  private perf: PerfMonitor | null
  private lock: GatewayLock | null
  private timer: ReturnType<typeof setInterval> | null
  private lastHeartbeat: number
  private stopping: Promise<void> | null
  private initializing: Promise<void> | null
  private hub: GatewayAppHub | null

  constructor(parent: GatewayParentPort, build: PerfBuild, exit: (code: number) => void, now: () => number = () => performance.now()) {
    this.parent = parent
    this.build = build
    this.exit = exit
    this.clock = new AwakeClock(now)
    this.now = () => this.clock.now()
    this.perf = null
    this.lock = null
    this.timer = null
    this.lastHeartbeat = now()
    this.stopping = null
    this.initializing = null
    this.hub = null
  }

  start(): void {
    this.parent.on('message', ({ data, ports }: { data: ProcessMessage; ports?: UtilityWindowPort[] }) => {
      void this.receive(data, ports).catch(error => {
        try { this.parent.postMessage({ type: 'startup-error', error: error instanceof Error ? error.message : String(error) }) }
        catch { /* A closed parent cannot receive the failure; cleanup still owns the lock. */ }
        void this.stop(1)
      })
    })
    this.parent.on('close', () => { void this.stop(0) })
    this.parent.postMessage({ type: 'hello', build: this.build, process: 'gateway' })
    this.timer = setInterval(() => { setTimeout(() => this.checkParent(), 0).unref?.() }, 1_000)
  }

  private async receive(message: ProcessMessage, ports?: UtilityWindowPort[]): Promise<void> {
    if (this.stopping) return
    switch (message.type) {
      case 'initialize': {
        if (this.lock) throw new Error('Gateway is already initialized')
        const context = new GatewayAppContext(message.identity)
        this.lock = new GatewayLock(context.lockFile)
        this.initializing = (async () => {
          await this.lock!.acquire()
          if (this.stopping) return
          const directory = context.perfDirectory
          this.perf = new PerfMonitor({ process: 'gateway', build: this.build, directory,
            names: new PerfNames([]), profiler: new PerfProfiler(context.profilesDirectory, 'gateway'),
            report: message => console.error(message) })
          this.perf.start()
          this.hub = new GatewayAppHub(context, this.perf, value => {
            this.parent.postMessage(value)
          }, value => {
            if (message.smoke === true) SmokeForwardTrace.sent(value, message.identity.stateDirectory)
          })
          this.hub.start()
          this.parent.postMessage({ type: 'ready' })
        })()
        await this.initializing
        return
      }
      case 'heartbeat': {
        const ms = this.now() - this.lastHeartbeat
        if (ms > 2_000) this.perf?.event({ kind: 'unresponsive', target: 'main', ms: ms - 1_000 })
        this.lastHeartbeat = this.now()
        this.hub?.heartbeat()
        this.parent.postMessage({ type: 'heartbeat-reply', seq: message.seq })
        return
      }
      case 'power':
        if (this.clock.power(message.epoch, message.event).late) this.lastHeartbeat = this.clock.now()
        this.hub?.power(message)
        return
      case 'stop': void this.stop(0); return
      case 'orchestrator-port':
        if (!this.hub || ports?.length !== 1) throw new Error('Orchestration port requires one initialized gateway endpoint')
        this.hub.connectOrchestrator(ports[0]! as ProcessPort)
        return
      case 'window-port':
        if (!this.hub || ports?.length !== 1) throw new Error('Window port requires one endpoint and an initialized gateway')
        this.hub.openWindow(message.windowId, message.epoch, message.accepting, ports[0]!)
        return
      case 'window-accepting': this.hub?.setWindowAccepting(message.windowId, message.epoch, message.accepting); return
      case 'window-close': this.hub?.closeWindow(message.windowId, message.epoch); return
      case 'call': case 'pending': case 'reply': case 'cancel': case 'received': case 'event':
        if (!this.hub) throw new Error('Gateway is not initialized')
        this.hub.receive(message)
        return
      case 'hello': case 'ready': case 'heartbeat-reply': case 'alive': case 'startup-error': case 'stopped':
      case 'host-connection':
        throw new Error(`Unexpected parent message: ${message.type}`)
      default: throw new Error(`Unknown parent message: ${(message as { type: string }).type}`)
    }
  }

  checkParent(): void {
    this.clock.tick()
    const ms = this.now() - this.lastHeartbeat
    if (this.stopping || ms < 30_000) return
    this.perf?.event({ kind: 'hang', target: 'main', ms })
    void this.stop(1)
  }

  stop(code: number): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopping = (async () => {
      const deadline = setTimeout(() => this.exit(code), 3_000)
      let leaseRelease: ControllerLeaseRelease = 'not-held'
      try {
        await this.initializing?.catch(() => {})
        try { await this.hub?.stop() }
        finally {
          leaseRelease = this.hub?.leaseRelease() ?? 'not-held'
          try { await this.perf?.stop() }
          finally { await this.lock?.release() }
        }
      } catch (error) {
        console.error(`Gateway cleanup failed: ${String(error)}`)
      } finally {
        clearTimeout(deadline)
        const receipt: ProcessStoppedMessage = { type: 'stopped', process: 'gateway', leaseRelease }
        try { writeSync(1, '[client-drain] ' + JSON.stringify(receipt) + '\n') } catch { /* Lost output must not prevent process exit. */ }
        try { this.parent.postMessage(receipt) } catch { /* Parent loss is itself a normal stop trigger. */ }
        this.exit(code)
      }
    })()
    return this.stopping
  }
}
