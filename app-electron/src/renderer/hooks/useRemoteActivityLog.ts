import { useEffect } from 'react'
import { useLayoutStore } from '../store/layout-store'
import { pushRemoteActivity } from '../components/panels/RemoteActivityLogPanel'

/**
 * Streams `remote:activity` events into the Remote Activity Log buffer and
 * auto-opens the log tab the first time ANY remote-control activity occurs
 * (human via the UI or AI via the bridge) — **inactive** (no focus steal), so it
 * appears for awareness/audit without ever interrupting the user. Mounted once
 * (App). Works on both ends and for both drivers.
 */
export function useRemoteActivityLog(): void {
  useEffect(() => {
    if (!window.electronAPI?.onRemoteActivity) return
    const off = window.electronAPI.onRemoteActivity((entry) => {
      pushRemoteActivity(entry)
      const dock = useLayoutStore.getState().dockviewApi
      if (dock && !dock.getPanel('remote-activity-log')) {
        dock.addPanel({ id: 'remote-activity-log', component: 'remoteActivityLogPanel', title: '📡 Remote Activity', inactive: true })
      }
    })
    return () => off()
  }, [])
}
