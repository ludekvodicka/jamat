import { useEffect } from 'react'
import { useLayoutStore } from '../store/layout-store'

/**
 * Controlled side: a remote peer asked to close one of THIS machine's tabs
 * (the panel id === terminalId, server-validated). We remove the dockview panel
 * exactly as the local close button would, which disposes the PTY. No-op if the
 * tab is already gone (the broadcast hits every window; only the holder acts).
 */
export function useControlCloseTab(): void {
  useEffect(() => {
    if (!window.electronAPI?.onControlCloseTab) return
    const off = window.electronAPI.onControlCloseTab(({ terminalId }) => {
      const dock = useLayoutStore.getState().dockviewApi
      const panel = dock?.getPanel(terminalId)
      if (panel) dock!.removePanel(panel)
    })
    return () => off()
  }, [])
}
