import { AppIdentity } from '../../shared/appIdentity'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import type { WindowInfo } from '../../shared/windowInfo'

/** The identity and appearance of this renderer document. */
export class WindowInfoStore {
  private static info: WindowInfo | null = null
  private static readonly subscribers = new Set<() => void>()
  private static stopChanged: (() => void) | null = null

  static async start(): Promise<WindowInfo> {
    WindowInfoStore.stopChanged?.()
    WindowInfoStore.stopChanged = window.appClient.onWindowChanged(() => {
      void WindowInfoStore.refresh().catch((error: unknown) =>
        AppClientUiReport.error(`window information refresh failed: ${String(error)}`))
    })
    return WindowInfoStore.refresh()
  }

  private static async refresh(): Promise<WindowInfo> {
    const answer = await window.appClient.windows.info()
    if (!answer.ok)
      throw new Error(`Window information unavailable: ${answer.error}`)
    WindowInfoStore.info = answer.value
    WindowInfoStore.apply(answer.value)
    for (const subscriber of WindowInfoStore.subscribers) subscriber()
    return answer.value
  }

  static current(): WindowInfo {
    if (WindowInfoStore.info === null)
      throw new Error('WindowInfoStore has not started')
    return WindowInfoStore.info
  }

  static subscribe(subscriber: () => void): () => void {
    WindowInfoStore.subscribers.add(subscriber)
    return () => {
      WindowInfoStore.subscribers.delete(subscriber)
    }
  }

  static snapshot(): WindowInfo | null {
    return WindowInfoStore.info
  }

  static reset(): void {
    WindowInfoStore.stopChanged?.()
    WindowInfoStore.stopChanged = null
    WindowInfoStore.info = null
    WindowInfoStore.subscribers.clear()
  }

  private static apply(info: WindowInfo): void {
    if (info.color !== null)
      document.documentElement.style.setProperty('--window-color', info.color)
    else
      document.documentElement.style.removeProperty('--window-color')
    document.title = AppIdentity.titleOf(info.name)
  }
}
