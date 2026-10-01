import type { AppClientUiBridge } from '../shared/appClientUiIpc'
import type { AutoUpdateApi } from '../shared/electron/autoUpdate/common/autoUpdateApi'

declare global {
  interface Window {
    /** Exposed by the preload; the only path from the renderer to the main process. */
    readonly appClient: AppClientUiBridge & { readonly autoUpdate: AutoUpdateApi }
  }
}
