import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type {
  AppClientUiEventArgs, AppClientUiIpcEventMap, AppClientUiIpcInvokeMap,
  AppClientUiInvokeArgs, AppClientUiInvokeResult,
} from '../../shared/appClientUiIpc'
import { registerAppClientUiHandler } from '../../shared/typedIpc'
import type { ServiceCaller, ServiceCallerGoneReason, ServiceTransport } from './serviceTransport.types'

interface CallerWindow {
  sender: WebContents
  identity: Pick<ServiceCaller, 'windowId' | 'role'>
  caller: ServiceCaller | null
  lastCaller: ServiceCaller
}

export class IpcServiceTransport implements ServiceTransport {
  private readonly windows: Map<WebContents, CallerWindow>
  private readonly callers: Map<string, CallerWindow>
  private readonly loaded: Set<(caller: ServiceCaller) => void>
  private readonly gone: Set<(caller: ServiceCaller, reason: ServiceCallerGoneReason) => void>

  constructor() {
    this.windows = new Map()
    this.callers = new Map()
    this.loaded = new Set()
    this.gone = new Set()
  }

  watch(sender: WebContents, identity: Pick<ServiceCaller, 'windowId' | 'role'>): void {
    if (this.windows.has(sender)) return
    const caller = { ...identity, id: randomUUID() }
    const state: CallerWindow = { sender, identity, caller, lastCaller: caller }
    this.windows.set(sender, state)
    this.callers.set(caller.id, state)
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isInPlace !== true && isMainFrame !== false) this.retire(state, 'reload')
    })
    sender.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
      if (isMainFrame) this.activate(state)
    })
    sender.on('did-finish-load', () => {
      if (state.caller) for (const listener of this.loaded) listener(state.caller)
    })
    sender.on('render-process-gone', () => this.retire(state, 'reload'))
    sender.on('destroyed', () => {
      this.retire(state, 'closed')
      this.windows.delete(sender)
    })
  }

  handle<K extends keyof AppClientUiIpcInvokeMap>(channel: K, handler: (
    caller: ServiceCaller, ...args: AppClientUiInvokeArgs<K>
  ) => AppClientUiInvokeResult<K> | Promise<AppClientUiInvokeResult<K>>): void {
    registerAppClientUiHandler(channel, (event, ...args) => handler(this.callerOf(event), ...args))
  }

  publish<K extends keyof AppClientUiIpcEventMap>(channel: K, target: ServiceCaller | 'all', ...args: AppClientUiEventArgs<K>): void {
    const states = target === 'all' ? this.windows.values() : [this.callers.get(target.id)]
    for (const state of states)
      if (state?.caller && (target === 'all' || this.isCurrent(target))) {
        try { state.sender.send(channel, ...args) }
        catch { /* A frame can disappear between validation and native delivery. */ }
      }
  }

  isCurrent(caller: ServiceCaller): boolean {
    const state = this.callers.get(caller.id)
    return state?.caller?.windowId === caller.windowId && state.caller.role === caller.role && !state.sender.isDestroyed()
  }

  sender(caller: ServiceCaller): WebContents {
    const state = this.callers.get(caller.id)
    if (!state || !this.isCurrent(caller)) throw new Error('The renderer is no longer available')
    return state.sender
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
    } else throw new Error(`Unknown caller event: ${event}`)
  }

  private callerOf(event: IpcMainInvokeEvent): ServiceCaller {
    const state = this.windows.get(event.sender)
    if (!state?.caller || event.sender.isDestroyed()) throw new Error('Unknown or departed renderer')
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('Service requests require the main renderer frame')
    return state.caller
  }

  private activate(state: CallerWindow): void {
    if (state.caller || !this.windows.has(state.sender)) return
    state.caller = { ...state.identity, id: randomUUID() }
    state.lastCaller = state.caller
    this.callers.set(state.caller.id, state)
  }

  private retire(state: CallerWindow, reason: ServiceCallerGoneReason): void {
    const caller = state.caller
    if (caller) this.callers.delete(caller.id)
    state.caller = null
    if (caller || reason === 'closed')
      for (const listener of this.gone) listener(caller ?? state.lastCaller, reason)
  }
}
