import type { WebContents } from 'electron'
import { registerAppClientUiHandler } from '../../shared/typedIpc'
import type { ServiceIpcBase, IpcChannelSet } from './serviceIpcBase'
import type { ServiceCaller, ServiceCallerGoneReason, ServiceTransport } from './serviceTransport.types'
import type { ElectronCallerAccess } from '../shell/electronServiceIpcBase'

const sources = new WeakMap<ServiceCaller, WebContents>()
export function callerSource(caller: ServiceCaller): WebContents { return sources.get(caller)! }

export function bindService<T extends ServiceIpcBase<IpcChannelSet> & { setCallerAccess?: (access: ElectronCallerAccess) => unknown }>(service: T): T {
  const callers = new WeakMap<WebContents, ServiceCaller>()
  const current = new Set<ServiceCaller>()
  const gone = new Set<(caller: ServiceCaller, reason: ServiceCallerGoneReason) => void>()
  let sequence = 0
  const transport: ServiceTransport = {
    handle: (channel, handler) => registerAppClientUiHandler(channel, (event, ...args) => {
      const source = event.sender ?? {} as WebContents
      let caller = callers.get(source)
      if (!caller) {
        caller = { id: `caller-${++sequence}`, windowId: `window-${sequence}`, role: 'workspace' }
        callers.set(source, caller)
        sources.set(caller, source)
        if (source.isDestroyed?.()) return handler(caller, ...args)
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
      return handler(caller, ...args)
    }),
    publish: () => { throw new Error('This service fixture does not publish') },
    isCurrent: caller => current.has(caller) && !callerSource(caller).isDestroyed?.(),
    onCaller: (event: 'loaded' | 'gone', listener: ((caller: ServiceCaller) => void) | ((caller: ServiceCaller, reason: ServiceCallerGoneReason) => void)) => {
      if (event === 'gone') { gone.add(listener); return () => { gone.delete(listener) } }
      else if (event === 'loaded') return () => undefined
      else throw new Error(`Unknown caller event: ${event}`)
    },
  }
  service.setTransport(transport)
  service.setCallerAccess?.({ sender: callerSource })
  return service
}
