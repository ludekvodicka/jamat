import type { ServiceIpcBase, IpcChannelSet } from '../../lib-orchestrator/clientApi/serviceIpcBase'
import type { ServiceCaller, ServiceCallerGoneReason, ServiceTransport } from '../../lib-orchestrator/clientApi/serviceTransport.types'
import { ErrorText } from '../../lib-orchestrator/shared/errorText'

type CallerSource = {
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  isDestroyed?(): boolean
}

const sources = new WeakMap<ServiceCaller, object>()
export const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
export function callerSource(caller: ServiceCaller): object { return sources.get(caller)! }

export function bindService<T extends ServiceIpcBase<IpcChannelSet>>(service: T): T {
  const callers = new WeakMap<object, ServiceCaller>()
  const current = new Set<ServiceCaller>()
  const gone = new Set<(caller: ServiceCaller, reason: ServiceCallerGoneReason) => void>()
  let sequence = 0
  const transport: ServiceTransport = {
    handle: (channel, handler) => {
      handlers.set(channel, async (event, ...args) => {
        try {
          const source = (event as { sender?: CallerSource }).sender ?? {}
          let caller = callers.get(source)
          if (!caller) {
            caller = { id: `caller-${++sequence}`, windowId: `window-${sequence}`, role: 'workspace' }
            callers.set(source, caller)
            sources.set(caller, source)
            if (!source.isDestroyed?.()) {
              current.add(caller)
              const identity = caller
              source.on?.('destroyed', () => {
                current.delete(identity)
                for (const listener of gone) listener(identity, 'closed')
              })
              source.on?.('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
                if (isInPlace !== true && isMainFrame !== false) {
                  current.delete(identity)
                  callers.delete(source)
                  for (const listener of gone) listener(identity, 'reload')
                }
              })
            }
          }
          return { ok: true, value: await Reflect.apply(handler, undefined, [caller, ...args]) }
        } catch (error) { return { ok: false, error: ErrorText.of(error) } }
      })
    },
    publish: () => { throw new Error('This service fixture does not publish') },
    isCurrent: caller => current.has(caller) && !(callerSource(caller) as CallerSource).isDestroyed?.(),
    onCaller: (event: 'loaded' | 'gone', listener: ((caller: ServiceCaller) => void) | ((caller: ServiceCaller, reason: ServiceCallerGoneReason) => void)) => {
      if (event === 'gone') { gone.add(listener); return () => { gone.delete(listener) } }
      else if (event === 'loaded') return () => undefined
      else throw new Error(`Unknown caller event: ${event}`)
    },
  }
  service.setTransport(transport)
  return service
}
