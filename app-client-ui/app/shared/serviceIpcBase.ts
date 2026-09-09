import type { IpcMainInvokeEvent, WebContents } from 'electron'

import type {
  AppClientUiInvokeArgs,
  AppClientUiInvokeResult,
  AppClientUiIpcInvokeMap,
} from '../../shared/appClientUiIpc'
import { registerAppClientUiHandler } from '../../shared/typedIpc'

export type IpcChannelSet = Partial<Record<keyof AppClientUiIpcInvokeMap, true>>

/**
 * The register-and-assert half every IPC service shares. Each service owns a subset of the contract
 * and proves at boot that it registered all of its own; AppHub is where the subsets are proved to
 * cover the whole contract between them, because no single service can know that any more.
 */
export abstract class ServiceIpcBase<TChannels extends IpcChannelSet> {
  private readonly registered = new Set<keyof AppClientUiIpcInvokeMap>()
  private readonly watched = new WeakSet<WebContents>()

  protected register<K extends keyof TChannels & keyof AppClientUiIpcInvokeMap>(
    channel: K,
    handler: (
      event: IpcMainInvokeEvent,
      ...args: AppClientUiInvokeArgs<K>
    ) => AppClientUiInvokeResult<K> | Promise<AppClientUiInvokeResult<K>>,
  ): void {
    if (this.registered.has(channel))
      throw new Error(`IPC channel is already registered: ${channel}`)
    registerAppClientUiHandler(channel, handler)
    this.registered.add(channel)
  }

  /**
   * Release whatever this service remembers for one window, once, when that window's renderer goes.
   *
   * Both ways out, because a window loses its renderer in two ways and only one of them is closing:
   * a reload navigates away from the document that asked and never says goodbye. Only the MAIN
   * frame, because `did-start-navigation` fires for a subframe and for a same-document navigation
   * too, and dropping a window's state on a fragment change is a bug, not a cleanup.
   *
   * Called once per sender, whatever asks: a second attach or a second request adds no second pair
   * of listeners. It lives here because two services beside each other held their own copy of it,
   * with the same WeakSet and almost the same comment, and a third would have copied one of them.
   */
  protected watchSender(sender: WebContents, release: () => void): void {
    if (this.watched.has(sender)) return
    this.watched.add(sender)
    sender.on('destroyed', () => release())
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isInPlace !== true && isMainFrame !== false) release()
    })
  }

  /** Called at boot: a channel this service owns but never handled must fail the start, not a user. */
  protected assertComplete(channels: TChannels): void {
    for (const channel of Object.keys(channels) as (keyof AppClientUiIpcInvokeMap)[])
      if (!this.registered.has(channel))
        throw new Error(`IPC channel is not registered: ${channel}`)
  }
}
