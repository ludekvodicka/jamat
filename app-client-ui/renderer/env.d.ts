import type { AppClientUiBridge } from '../shared/appClientUiIpc'

declare global {
  interface Window {
    /** Exposed by the preload; the only path from the renderer to the main process. */
    readonly appClient: AppClientUiBridge
  }
}
