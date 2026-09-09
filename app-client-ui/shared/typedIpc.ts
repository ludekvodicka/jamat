import {
  ipcMain,
  ipcRenderer,
  type IpcMainInvokeEvent,
  type IpcRendererEvent,
} from 'electron'

import type {
  AppClientUiEventArgs,
  AppClientUiIpcEventMap,
  AppClientUiIpcInvokeMap,
  AppClientUiInvokeArgs,
  AppClientUiInvokeResult,
  IpcResult,
} from './appClientUiIpc'
import { ErrorText } from './errorText'

export function invokeAppClientUi<K extends keyof AppClientUiIpcInvokeMap>(
  channel: K,
  ...args: AppClientUiInvokeArgs<K>
): Promise<IpcResult<AppClientUiInvokeResult<K>>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<AppClientUiInvokeResult<K>>>
}

export function onAppClientUiEvent<K extends keyof AppClientUiIpcEventMap>(
  channel: K,
  callback: (...args: AppClientUiEventArgs<K>) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void =>
    callback(...(args as AppClientUiEventArgs<K>))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * Every result is wrapped: a throwing handler reaches the renderer as data, never as a rejection.
 * Nothing is handed back to unregister with: a handler of this contract lives as long as the main
 * process does.
 */
export function registerAppClientUiHandler<K extends keyof AppClientUiIpcInvokeMap>(
  channel: K,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: AppClientUiInvokeArgs<K>
  ) => AppClientUiInvokeResult<K> | Promise<AppClientUiInvokeResult<K>>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      const value = await handler(event, ...(args as AppClientUiInvokeArgs<K>))
      return { ok: true, value } satisfies IpcResult<AppClientUiInvokeResult<K>>
    } catch (error) {
      return {
        ok: false,
        error: ErrorText.of(error),
      } satisfies IpcResult<AppClientUiInvokeResult<K>>
    }
  })
}
