import type { ServiceCaller, ServiceCallerGoneReason } from '../../../lib-orchestrator/clientApi/serviceTransport.types'
import type { MessagePortMain, UtilityProcess } from 'electron'
import type { PerfBuild, PerfEvent } from '../../../lib-orchestrator/perfMonitor/perfRecord.types'
import { ProcessHeartbeat } from './processHeartbeat'
import type { ChildProcessKind, ProcessCallMessage, ProcessIdentity, ProcessMessage, ProcessPowerMessage, ProcessStoppedMessage } from '../../../lib-orchestrator/shared/processWire.types'
import type { HostConnectionSnapshot } from '../../../lib-orchestrator/hostClient/hostConnection'

export type SupervisedChild = Pick<UtilityProcess, 'on' | 'postMessage' | 'kill'>
interface ChildState {
  child: SupervisedChild
  ready: boolean
  exited: boolean
  failed: boolean
  stopping: Promise<void> | null
  stopRequested: boolean
  receipt: ProcessStoppedMessage | null
  stopped: Promise<void>
  acknowledge: () => void
  resolve: () => void
  reject: (error: Error) => void
  finished: Promise<void>
  finish: () => void
  heartbeat: ProcessHeartbeat
  timer: ReturnType<typeof setInterval> | null
  startup: ReturnType<typeof setTimeout>
}

export class ChildProcessSupervisor {
  private readonly initialization: ((kind: ChildProcessKind) => { message: Extract<ProcessMessage, { type: 'initialize' }>; ports?: MessagePortMain[] }) | undefined
  private readonly fork: (kind: ChildProcessKind) => SupervisedChild
  private readonly build: PerfBuild
  private readonly identity: ProcessIdentity
  private readonly smoke: boolean
  private readonly record: (event: PerfEvent) => void
  private readonly onExit: (kind: ChildProcessKind) => void
  private readonly onMessage: (kind: ChildProcessKind, message: ProcessCallMessage | { type: 'host-connection'; value: HostConnectionSnapshot }) => void
  private readonly onHeartbeat: (kind: ChildProcessKind) => void
  private readonly onClosed: (kind: ChildProcessKind) => void
  private readonly report: (message: string) => void
  private readonly children: Map<ChildProcessKind, ChildState>
  private quitting: boolean

  constructor(deps: { fork: (kind: ChildProcessKind) => SupervisedChild; build: PerfBuild;
    identity: ProcessIdentity; smoke?: boolean; initialization?: ChildProcessSupervisor['initialization']; record: (event: PerfEvent) => void; onExit: (kind: ChildProcessKind) => void;
    onMessage: ChildProcessSupervisor['onMessage']; onHeartbeat: (kind: ChildProcessKind) => void;
    onClosed: (kind: ChildProcessKind) => void;
    report: (message: string) => void }) {
    this.initialization = deps.initialization
    this.fork = deps.fork
    this.build = deps.build
    this.identity = deps.identity
    this.smoke = deps.smoke ?? false
    this.record = deps.record
    this.onExit = deps.onExit
    this.onMessage = deps.onMessage
    this.onHeartbeat = deps.onHeartbeat
    this.onClosed = deps.onClosed
    this.report = deps.report
    this.children = new Map()
    this.quitting = false
  }

  async start(kind: ChildProcessKind): Promise<void> {
    if (this.quitting) throw new Error('Client is quitting')
    if (this.children.has(kind)) throw new Error(`${kind} already started`)
    try {
      await new Promise<void>((resolve, reject) => {
        const child = this.fork(kind)
        let finish!: () => void
        const finished = new Promise<void>(done => { finish = done })
        let acknowledge!: () => void
        const stopped = new Promise<void>(done => { acknowledge = done })
        const state: ChildState = { child, ready: false, exited: false, failed: false, stopping: null, stopRequested: false, receipt: null, stopped, acknowledge, resolve, reject, finish, finished,
          heartbeat: new ProcessHeartbeat(kind, this.record), timer: null,
          startup: setTimeout(() => reject(new Error(`${kind} startup timed out`)), 20_000) }
        this.children.set(kind, state)
        let hello = false
        child.on('message', (message: ProcessMessage) => {
          try {
            switch (message.type) {
              case 'hello':
                if (hello || message.process !== kind || message.build.inputHash !== this.build.inputHash)
                  throw new Error(`${kind} build identity mismatch`)
                hello = true
                if (!this.quitting) {
                  const value = this.initialization?.(kind) ?? { message: { type: 'initialize' as const, identity: this.identity, ...(this.smoke ? { smoke: true } : {}) } }
                  child.postMessage(value.message, value.ports)
                }
                return
              case 'ready':
                if (!hello || state.ready || this.quitting) throw new Error(`${kind} unexpected ready`)
                state.ready = true
                clearTimeout(state.startup)
                state.timer = setInterval(() => {
                  try { child.postMessage({ type: 'heartbeat', seq: state.heartbeat.send() } satisfies ProcessMessage) }
                  catch (error) { this.fail(kind, state, error) }
                }, 1_000)
                state.resolve()
                return
              case 'heartbeat-reply':
                if (state.heartbeat.reply(message.seq)) this.onHeartbeat(kind)
                return
              case 'call': case 'pending': case 'reply': case 'received': case 'cancel': case 'event': case 'host-connection':
                if (!hello) throw new Error(`${kind} message before hello`)
                this.onMessage(kind, message)
                return
              case 'startup-error': throw new Error(`${kind}: ${message.error}`)
              case 'stopped':
                if (!state.stopRequested || message.process !== kind || state.receipt) throw new Error(kind + ' unexpected stopped receipt')
                if (message.process === 'orchestrator') {
                  if (typeof message.recordsSettled !== 'boolean') throw new Error('Invalid records settlement receipt')
                  if (!message.recordsSettled) this.report('Orchestrator stopped without confirmed records settlement')
                } else if (message.process === 'gateway') {
                  switch (message.leaseRelease) {
                    case 'released': case 'not-held': break
                    case 'failed': this.report('Gateway stopped without confirmed Host lease release'); break
                    default: throw new Error('Invalid lease release receipt')
                  }
                } else throw new Error('Unknown stopped process')
                state.receipt = message
                state.acknowledge()
                return
              case 'power': case 'initialize': case 'heartbeat': case 'alive': case 'stop': case 'window-port': case 'window-close': case 'window-accepting': case 'orchestrator-port':
                throw new Error(`Unexpected child message: ${message.type}`)
              default: throw new Error(`Unknown child message: ${(message as { type: string }).type}`)
            }
          } catch (error) {
            this.fail(kind, state, error)
          }
        })
        child.on('exit', () => {
          state.exited = true
          clearTimeout(state.startup)
          if (state.timer) clearInterval(state.timer)
          state.finish()
          this.fail(kind, state, new Error(`${kind} exited`))
        })
        child.on('error', () => this.fail(kind, state, new Error(`${kind} process failed`)))
      })
    } catch (error) {
      this.beginQuit()
      await this.stopAll()
      throw error
    }
  }

  power(message: ProcessPowerMessage): void {
    for (const [kind, state] of this.children) {
      if (state.exited || state.failed) continue
      state.heartbeat.power(message)
      try { state.child.postMessage(message) }
      catch (error) { this.fail(kind, state, error) }
    }
  }

  beginQuit(): void {
    this.quitting = true
    for (const [kind, state] of this.children) {
      clearTimeout(state.startup)
      state.reject(new Error(`${kind} startup cancelled`))
    }
  }

  send(kind: ChildProcessKind, message: ProcessCallMessage): void {
    const state = this.children.get(kind)
    if (!state || state.exited || state.failed) throw new Error(`${kind} is not connected`)
    state.child.postMessage(message)
  }

  windowPort(windowId: string, epoch: string, port: MessagePortMain, accepting: boolean): void {
    const state = this.children.get('gateway')
    if (!state?.ready || state.exited || state.failed || this.quitting) throw new Error('Gateway is not ready for windows')
    state.child.postMessage({ type: 'window-port', windowId, epoch, accepting } satisfies ProcessMessage, [port])
  }

  orchestrationPort(port: MessagePortMain): void {
    const state = this.children.get('gateway')
    if (!state?.ready || state.exited || state.failed || this.quitting) throw new Error('Gateway is not ready for orchestration')
    state.child.postMessage({ type: 'orchestrator-port' } satisfies ProcessMessage, [port])
  }

  orchestratorWindow(caller: ServiceCaller, port: MessagePortMain, windowId: string): void {
    const state = this.children.get('orchestrator')
    if (!state?.ready || state.exited || state.failed || this.quitting) throw new Error('Orchestrator is not ready for windows')
    state.child.postMessage({ type: 'window-port', windowId, epoch: caller.id, accepting: true, caller } satisfies ProcessMessage, [port])
  }

  closeOrchestratorWindow(caller: ServiceCaller, reason: ServiceCallerGoneReason, windowId: string): void {
    const state = this.children.get('orchestrator')
    if (!state || state.exited || state.failed) return
    state.child.postMessage({ type: 'window-close', windowId, epoch: caller.id, reason } satisfies ProcessMessage)
  }

  setWindowAccepting(windowId: string, epoch: string, accepting: boolean): void {
    const state = this.children.get('gateway')
    if (!state || state.exited || state.failed) return
    state.child.postMessage({ type: 'window-accepting', windowId, epoch, accepting } satisfies ProcessMessage)
  }

  closeWindow(windowId: string, epoch: string): void {
    const state = this.children.get('gateway')
    if (!state || state.exited || state.failed) return
    state.child.postMessage({ type: 'window-close', windowId, epoch } satisfies ProcessMessage)
  }

  async stopAll(): Promise<void> {
    this.beginQuit()
    for (const kind of ['orchestrator', 'gateway'] as const) await this.stop(kind)
    await Promise.all([...this.children.values()].map(state => state.finished))
  }

  async stop(kind: ChildProcessKind): Promise<void> {
    const state = this.children.get(kind)
    if (!state || state.exited) return
    return state.stopping ??= (async () => {
      const kill = (): void => {
        if (state.exited) return
        try { state.child.kill() }
        catch (error) { this.report(`Cannot stop ${kind}: ${String(error)}`) }
      }
      state.stopRequested = true
      const milliseconds = kind === 'orchestrator' ? 15_000 : 3_000
      const timeout = setTimeout(() => {
        this.report(kind + ' did not exit within ' + milliseconds + ' ms; terminating')
        kill()
        state.finish()
      }, milliseconds)
      // An acknowledgement advances the drain, but cannot cancel this child's exit deadline.
      void state.finished.then(() => {
        clearTimeout(timeout)
        if (state.timer) clearInterval(state.timer)
        if (!state.receipt) this.report(kind + ' exited without a stopped receipt; settlement is unconfirmed')
      })
      try { state.child.postMessage({ type: 'stop' } satisfies ProcessMessage) }
      catch (error) { this.report(`Cannot send stop to ${kind}: ${String(error)}`); kill() }
      await Promise.race([state.stopped, state.finished])
    })()
  }

  private fail(kind: ChildProcessKind, state: ChildState, error: unknown): void {
    state.reject(error instanceof Error ? error : new Error(String(error)))
    if (state.failed) return
    state.failed = true
    this.onClosed(kind)
    if (state.timer) clearInterval(state.timer)
    if (state.ready && !this.quitting) this.onExit(kind)
  }
}
