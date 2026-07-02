import { useEffect } from 'react'
import { useLayoutStore } from '../store/layout-store'

/**
 * Tracks tabs that finished a turn while the user wasn't looking — the "completed work,
 * unseen" state. A tab whose run settles from running/tool-use back to idle while the user
 * wasn't watching it (a background tab, OR the active tab in a window that doesn't have OS
 * focus) is flagged (green ✓ badge in the tab header + sidebar) so it stands out from a plain
 * idle/grey tab. The flag clears the moment the user sees it — activating that tab, focusing
 * its window while it's active — or a new turn starts on it. Mounted once per window (next to
 * useTabTreePush in App).
 *
 * Renderer-only UI state — deliberately NOT a new value in the canonical terminal status
 * or the bridge tab tree (those drive remote/AI "find a free session" logic, which only
 * knows idle/running/tool-use/blocked/waiting/done).
 */
const WORK_STATUSES = new Set(['running', 'tool-use', 'blocked', 'waiting'])

export function useCompletedTabs(): void {
  useEffect(() => {
    // Last status seen per panel id — so we can detect the running/tool-use → idle EDGE
    // (terminal-status only fires on a real change, so each finish is exactly one idle event).
    const prev: Record<string, string> = {}

    const onStatus = (e: Event) => {
      const { id, status } = (e as CustomEvent).detail ?? {}
      if (!id || !status) return
      const store = useLayoutStore.getState()
      if (WORK_STATUSES.has(status)) {
        // A new turn is in flight → no longer "done".
        store.clearTabCompleted(id)
      } else if (status === 'idle' && (prev[id] === 'running' || prev[id] === 'tool-use')) {
        // Just settled. Flag it as "completed, unseen" UNLESS the user actually watched it finish —
        // i.e. it's the active tab AND this window has OS focus. The bare `id === activePanel` check
        // missed the common case: a tab that's active but in a BACKGROUND (unfocused) window finishes
        // while the user is elsewhere → the done-popup fires but the tab stayed grey. Gate on focus.
        if (id === store.activePanel && document.hasFocus()) store.clearTabCompleted(id)
        else store.markTabCompleted(id)
      }
      prev[id] = status
    }
    window.addEventListener('terminal-status', onStatus)

    // Seeing a flagged tab clears it: switching to it (activePanel change) OR focusing the window
    // while it's already the active tab (the user is now looking at the finished tab).
    const unsub = useLayoutStore.subscribe((s, p) => {
      if (s.activePanel && s.activePanel !== p.activePanel) s.clearTabCompleted(s.activePanel)
    })
    const onWindowFocus = () => {
      const s = useLayoutStore.getState()
      if (s.activePanel) s.clearTabCompleted(s.activePanel)
    }
    window.addEventListener('focus', onWindowFocus)

    return () => {
      window.removeEventListener('terminal-status', onStatus)
      window.removeEventListener('focus', onWindowFocus)
      unsub()
    }
  }, [])
}
