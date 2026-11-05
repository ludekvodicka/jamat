import { contextBridge, ipcRenderer } from 'electron'

import type {
  AppClientUiBridge,
  AppClientUiBridgeCallTable,
  AppClientUiBridgeCalls,
  AppClientUiBridgeListeners,
  AppClientUiIpcEventMap,
  AppClientUiIpcInvokeMap,
} from '../shared/appClientUiIpc'
import {
  AppClientUiBridgeCallsConst,
  AppClientUiBridgeEventsConst,
  AppClientUiChannelOwnersConst,
} from '../shared/appClientUiIpc'
import type { AutoUpdateApi } from '../shared/electron/autoUpdate/common/autoUpdateApi'
import { AutoUpdateBridge } from '../shared/electron/autoUpdate/preload/autoUpdateBridge'
import { invokeAppClientUi, onAppClientUiEvent } from '../shared/typedIpc'
import { WindowGateway } from './windowGateway'
import { WindowOrchestrator } from './windowOrchestrator'

const gateway = new WindowGateway()
const orchestrator = new WindowOrchestrator()

/**
 * Every member of the bridge does the same two things - name a channel, and pass on exactly what it
 * was handed - so it is BUILT from the contract's table rather than written out. What stood here was
 * More than a hundred hand-written forwardings, each one a chance to reach a channel of the same signature by
 * mistake or to drop a trailing argument, and neither fault was visible to the compiler: a swap of
 * `sessions.reopen` onto `sessions:remove` and a preload that forgot the second argument of
 * `sessions:retry-setup` both passed the whole gate.
 *
 * Neither is expressible any more. A member has no code of its own, and the channel it names is
 * checked against `AppClientUiIpcInvokeMap` where the table is declared.
 */
/** The two wrappers as the walk can call them: a channel it holds as a plain string, and the rest. */
type AppClientUiInvokeLoose = (channel: string, ...args: readonly unknown[]) => Promise<unknown>
type AppClientUiSubscribeLoose =
  (channel: string, callback: (...args: readonly unknown[]) => void | Promise<void>) => () => void

class AppClientUiBridgeBuild {
  static calls<T extends AppClientUiBridgeCallTable>(table: T): AppClientUiBridgeCalls<T> {
    const built: Record<string, unknown> = {}
    for (const [member, entry] of Object.entries(table)) {
      if (typeof entry === 'string')
        // `Object.entries` loses which channel the string is, so the wrapper is called in the shape
        // the walk holds. Which channels exist is checked where the table is declared.
        built[member] = (...args: readonly unknown[]) =>
          AppClientUiBridgeBuild.invoke(entry as keyof AppClientUiIpcInvokeMap, args)
      else if (entry !== null && typeof entry === 'object')
        built[member] = AppClientUiBridgeBuild.calls(entry)
      else
        throw new Error(`Bridge table holds neither a channel nor a group at ${member}`)
    }
    // The walk cannot carry the table's shape through `Object.entries`, which is the one place this
    // file asserts anything; `preload/index.test.ts` calls every member and reads the channel back.
    return built as AppClientUiBridgeCalls<T>
  }

  static listeners<T extends Readonly<Record<string, keyof AppClientUiIpcEventMap>>>(
    table: T,
  ): AppClientUiBridgeListeners<T> {
    const built: Record<string, unknown> = {}
    for (const [member, channel] of Object.entries(table))
      built[member] = (callback: (...args: readonly unknown[]) => void | Promise<void>) => {
        const owner = AppClientUiChannelOwnersConst[channel] ?? 'main'
        switch (owner) {
          case 'main': return (onAppClientUiEvent as AppClientUiSubscribeLoose)(channel, callback)
          case 'gateway': return gateway.subscribe(channel, callback)
          case 'orchestrator': return orchestrator.subscribe(channel, callback)
          default: throw new Error(`Unknown channel owner: ${owner}`)
        }
      }
    return built as AppClientUiBridgeListeners<T>
  }

  private static invoke(channel: keyof AppClientUiIpcInvokeMap, args: readonly unknown[]): Promise<unknown> {
    const owner = AppClientUiChannelOwnersConst[channel] ?? 'main'
    switch (owner) {
      case 'main': return (invokeAppClientUi as AppClientUiInvokeLoose)(channel, ...args)
      case 'gateway': return gateway.invoke(channel, ...args)
      case 'orchestrator': return orchestrator.invoke(channel, ...args)
      default: throw new Error(`Unknown channel owner: ${owner}`)
    }
  }
}

/**
 * The shared updater's channels answer with raw values rather than an `IpcResult`, so they are nested
 * beside the table instead of in it, and `AppClientUiIpcInvokeMap` never names them.
 */
export const appClientUiBridge: AppClientUiBridge & { readonly autoUpdate: AutoUpdateApi } = {
  ...AppClientUiBridgeBuild.calls(AppClientUiBridgeCallsConst),
  ...AppClientUiBridgeBuild.listeners(AppClientUiBridgeEventsConst),
  autoUpdate: AutoUpdateBridge.create(ipcRenderer),
}

contextBridge.exposeInMainWorld('appClient', appClientUiBridge)
