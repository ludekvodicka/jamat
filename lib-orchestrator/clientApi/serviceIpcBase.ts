import type {
  AppClientUiInvokeArgs,
  AppClientUiInvokeResult,
  AppClientUiIpcInvokeMap,
} from './appClientUiIpc'
import type { PerfSpans } from '../perfMonitor/perfSpans'
import type { ServiceCaller, ServiceTransport } from './serviceTransport.types'

export type IpcChannelSet = Partial<Record<keyof AppClientUiIpcInvokeMap, true>>

/**
 * The register-and-assert half every IPC service shares. Each service owns a subset of the contract
 * and proves at boot that it registered all of its own; MainHub is where the subsets are proved to
 * cover the whole contract between them, because no single service can know that any more.
 */
export abstract class ServiceIpcBase<TChannels extends IpcChannelSet> {
  private perf: PerfSpans | undefined
  private serviceTransport: ServiceTransport | undefined
  private readonly registered: Set<keyof AppClientUiIpcInvokeMap>

  constructor() {
    this.perf = undefined
    this.serviceTransport = undefined
    this.registered = new Set()
  }

  setPerfSpans(perf: PerfSpans): void { this.perf = perf }
  setTransport(transport: ServiceTransport): this {
    if (this.registered.size > 0) throw new Error('Service transport cannot change after registration')
    this.serviceTransport = transport
    return this
  }

  protected get transport(): ServiceTransport {
    if (!this.serviceTransport) throw new Error('Service transport is not configured')
    return this.serviceTransport
  }

  protected register<K extends keyof TChannels & keyof AppClientUiIpcInvokeMap>(
    channel: K,
    handler: (
      caller: ServiceCaller,
      ...args: AppClientUiInvokeArgs<K>
    ) => AppClientUiInvokeResult<K> | Promise<AppClientUiInvokeResult<K>>,
  ): void {
    if (this.registered.has(channel))
      throw new Error(`IPC channel is already registered: ${channel}`)
    this.transport.handle(channel, (caller, ...args) => this.perf
      ? this.perf.span(`ipc:${channel}`, () => handler(caller, ...args)) : handler(caller, ...args))
    this.registered.add(channel)
  }

  /** Called at boot: a channel this service owns but never handled must fail the start, not a user. */
  protected assertComplete(channels: TChannels): void {
    for (const channel of Object.keys(channels) as (keyof AppClientUiIpcInvokeMap)[])
      if (!this.registered.has(channel))
        throw new Error(`IPC channel is not registered: ${channel}`)
  }
}
