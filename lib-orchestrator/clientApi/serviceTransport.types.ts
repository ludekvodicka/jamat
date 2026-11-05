import type {
  AppClientUiEventArgs, AppClientUiIpcEventMap, AppClientUiIpcInvokeMap,
  AppClientUiInvokeArgs, AppClientUiInvokeResult,
} from './appClientUiIpc'

export interface ServiceCaller {
  readonly id: string
  readonly windowId: string
  readonly role: 'main' | 'workspace'
}

export type ServiceCallerGoneReason = 'reload' | 'closed'

export interface ServiceTransport {
  handle<K extends keyof AppClientUiIpcInvokeMap>(channel: K, handler: (
    caller: ServiceCaller, ...args: AppClientUiInvokeArgs<K>
  ) => AppClientUiInvokeResult<K> | Promise<AppClientUiInvokeResult<K>>): void
  publish<K extends keyof AppClientUiIpcEventMap>(channel: K, target: ServiceCaller | 'all', ...args: AppClientUiEventArgs<K>): void
  isCurrent(caller: ServiceCaller): boolean
  onCaller(event: 'loaded', listener: (caller: ServiceCaller) => void): () => void
  onCaller(event: 'gone', listener: (caller: ServiceCaller, reason: ServiceCallerGoneReason) => void): () => void
}
