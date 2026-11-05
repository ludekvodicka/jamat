import type { ServiceCaller, ServiceCallerGoneReason, ServiceTransport } from '../../../lib-orchestrator/clientApi/serviceTransport.types'
import { AppClientUiChannelOwnersConst } from '../../../lib-orchestrator/clientApi/appClientUiIpc'
import type { AppClientUiEventArgs, AppClientUiIpcEventMap, AppClientUiIpcInvokeMap, AppClientUiInvokeArgs, AppClientUiInvokeResult } from '../../../lib-orchestrator/clientApi/appClientUiIpc'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import type { ProcessPort, ProcessPowerMessage, ProcessMessage } from '../../../lib-orchestrator/shared/processWire.types'

type Handler = (caller: ServiceCaller, ...args: never[]) => unknown
interface WindowState { caller: ServiceCaller; port: ProcessPort; calls: ProcessCalls }

export class WindowServiceTransport implements ServiceTransport {
  private readonly handlers: Map<string, Handler>
  private readonly windows: Map<string, WindowState>
  private readonly loaded: Set<(caller: ServiceCaller) => void>
  private readonly gone: Set<(caller: ServiceCaller, reason: ServiceCallerGoneReason) => void>
  private readonly nativeEvent: (channel: keyof AppClientUiIpcEventMap, args: unknown[]) => void
  private readonly timer: ReturnType<typeof setInterval>
  private stopped: boolean

  constructor(nativeEvent: WindowServiceTransport['nativeEvent']) {
    this.handlers = new Map()
    this.windows = new Map()
    this.loaded = new Set()
    this.gone = new Set()
    this.nativeEvent = nativeEvent
    this.stopped = false
    this.timer = setInterval(() => {
      for (const state of [...this.windows.values()])
        try { state.port.postMessage({ type: 'alive' }) }
        catch (error) { console.error(error); this.close(state.caller, 'reload') }
    }, 1_000)
    this.timer.unref?.()
  }
  handle<K extends keyof AppClientUiIpcInvokeMap>(channel: K, handler: (caller: ServiceCaller, ...args: AppClientUiInvokeArgs<K>) => AppClientUiInvokeResult<K> | Promise<AppClientUiInvokeResult<K>>): void {
    if (AppClientUiChannelOwnersConst[channel] !== 'orchestrator' || this.handlers.has(channel)) throw new Error('Invalid orchestration channel registration: ' + channel)
    this.handlers.set(channel, handler as Handler)
  }
  open(caller: ServiceCaller, port: ProcessPort): void {
    if (this.stopped) { port.close(); return }
    if (this.windows.has(caller.id)) throw new Error('Duplicate window epoch')
    const calls = new ProcessCalls({ send: message => port.postMessage(message),
      invoke: async (target, channel, args, context) => {
        if (target !== 'service' || !this.isCurrent(caller)) throw new Error('The renderer is no longer available')
        const handler = this.handlers.get(channel)
        if (!handler) throw new Error('Unknown orchestration channel: ' + channel)
        context.pending()
        return handler(caller, ...args as never[])
      }, event: () => { throw new Error('Renderer events are not accepted') }, report: message => console.error(message) })
    this.windows.set(caller.id, { caller, port, calls })
    port.on('message', ({ data }: { data: ProcessMessage }) => {
      if (!this.isCurrent(caller)) return
      try {
        switch (data.type) {
          case 'call': case 'pending': case 'reply': case 'received': case 'cancel': case 'event': calls.receive(data); return
          default: throw new Error('Unexpected renderer message: ' + data.type)
        }
      } catch (error) { console.error(error); this.close(caller, 'reload') }
    })
    port.on('close', () => this.close(caller, 'reload'))
    port.start()
    for (const listener of this.loaded) listener(caller)
  }
  close(caller: ServiceCaller, reason: ServiceCallerGoneReason): void {
    const state = this.windows.get(caller.id)
    if (state) {
      this.windows.delete(caller.id)
      state.calls.close()
      state.port.close()
    }
    if (state || reason === 'closed') for (const listener of this.gone) listener(caller, reason)
  }
  publish<K extends keyof AppClientUiIpcEventMap>(channel: K, target: ServiceCaller | 'all', ...args: AppClientUiEventArgs<K>): void {
    if (AppClientUiChannelOwnersConst[channel] !== 'orchestrator') {
      if (target !== 'all') throw new Error('Native events cannot target an orchestration caller')
      this.nativeEvent(channel, args)
      return
    }
    if (target !== 'all' && !this.isCurrent(target)) return
    const windows = target === 'all' ? this.windows.values() : [this.windows.get(target.id)]
    for (const state of windows)
      if (state && this.isCurrent(state.caller)) state.calls.emit('window', channel, args)
  }
  isCurrent(caller: ServiceCaller): boolean {
    const held = this.windows.get(caller.id)?.caller
    return held?.windowId === caller.windowId && held.role === caller.role
  }
  onCaller(event: 'loaded', listener: (caller: ServiceCaller) => void): () => void
  onCaller(event: 'gone', listener: (caller: ServiceCaller, reason: ServiceCallerGoneReason) => void): () => void
  onCaller(event: 'loaded' | 'gone', listener: ((caller: ServiceCaller) => void) | ((caller: ServiceCaller, reason: ServiceCallerGoneReason) => void)): () => void {
    if (event === 'loaded') {
      const loaded = listener as (caller: ServiceCaller) => void
      this.loaded.add(loaded)
      return () => { this.loaded.delete(loaded) }
    } else if (event === 'gone') {
      this.gone.add(listener)
      return () => { this.gone.delete(listener) }
    } else throw new Error('Unknown caller event: ' + event)
  }
  power(message: ProcessPowerMessage): void {
    for (const state of this.windows.values()) { state.calls.power(message); state.port.postMessage(message) }
  }
  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    for (const state of this.windows.values()) this.close(state.caller, 'closed')
  }
}
