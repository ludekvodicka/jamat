import { contextBridge } from 'electron'

import type {
  AppClientUiBridge,
  AppClientUiBridgeCallTable,
  AppClientUiBridgeCalls,
  AppClientUiBridgeListeners,
  AppClientUiIpcEventMap,
} from '../shared/appClientUiIpc'
import {
  AppClientUiBridgeCallsConst,
  AppClientUiBridgeEventsConst,
} from '../shared/appClientUiIpc'
import { invokeAppClientUi, onAppClientUiEvent } from '../shared/typedIpc'

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
  (channel: string, callback: (...args: readonly unknown[]) => void) => () => void

class AppClientUiBridgeBuild {
  static calls<T extends AppClientUiBridgeCallTable>(table: T): AppClientUiBridgeCalls<T> {
    const built: Record<string, unknown> = {}
    for (const [member, entry] of Object.entries(table)) {
      if (typeof entry === 'string')
        // `Object.entries` loses which channel the string is, so the wrapper is called in the shape
        // the walk holds. Which channels exist is checked where the table is declared.
        built[member] = (...args: readonly unknown[]) =>
          (invokeAppClientUi as AppClientUiInvokeLoose)(entry, ...args)
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
      built[member] = (callback: (...args: readonly unknown[]) => void) =>
        (onAppClientUiEvent as AppClientUiSubscribeLoose)(channel, callback)
    return built as AppClientUiBridgeListeners<T>
  }
}

export const appClientUiBridge: AppClientUiBridge = {
  ...AppClientUiBridgeBuild.calls(AppClientUiBridgeCallsConst),
  ...AppClientUiBridgeBuild.listeners(AppClientUiBridgeEventsConst),
}

contextBridge.exposeInMainWorld('appClient', appClientUiBridge)
