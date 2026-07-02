import { useEffect } from 'react'
import type { IDockviewPanel } from 'dockview'
import { useLayoutStore } from '../store/layout-store'
import type { RemoteTabInfo, TabStatus } from '../../../../core/types/remote-control'

/**
 * Pushes this window's dockview tab list to the main process (and thence to the
 * Remote App Control server) whenever it changes. Renderer→main `send` is the
 * only IPC direction available under sandbox+contextIsolation, so the tree is
 * mirrored to a main-side cache rather than pulled on demand.
 *
 * Terminal tabs (`terminal-*` panel ids) are `streamable`; their Claude status
 * is mirrored from the `terminal-status` CustomEvent the terminal hook dispatches
 * (same source `TabListPanel` reads). Non-terminal panels appear in the tree but
 * are not streamable.
 */
export function useTabTreePush(): void {
  const { dockviewApi } = useLayoutStore()

  useEffect(() => {
    if (!dockviewApi) return
    const statusMap: Record<string, TabStatus> = {}
    let timer: ReturnType<typeof setTimeout> | null = null

    const build = (): RemoteTabInfo[] =>
      dockviewApi.panels.map((p: IDockviewPanel) => {
        // `type`/`streamable` here are only hints — the main process stamps the
        // authoritative `streamable` via `hasBufferedTerminal` (terminal tabs get
        // ids like `claude-…`/`cmd-…`, not just `terminal-…`). Status is reported
        // for ANY panel that emitted a `terminal-status` event (real terminals
        // only ever do), so it's keyed by id, not by the id-prefix guess.
        const isTerminal = p.id.startsWith('terminal')
        return {
          terminalId: p.id,
          title: p.title ?? p.id,
          type: isTerminal ? 'terminal' : 'panel',
          status: statusMap[p.id],
          streamable: isTerminal,
          // Carry the tab's instance id (minted on "Copy instance id") so main can resolve it to
          // this live terminalId. Absent until the human copies it.
          instanceId: (p.params as Record<string, unknown> | undefined)?.instanceId as string | undefined,
        }
      })

    const push = () => { window.electronAPI?.pushTabs?.(build()) }
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(push, 150) }

    schedule()
    const d1 = dockviewApi.onDidAddPanel(schedule)
    const d2 = dockviewApi.onDidRemovePanel(schedule)
    const d3 = dockviewApi.onDidLayoutChange(schedule) // catches title/active changes

    const onStatus = (e: Event) => {
      const { id, status } = (e as CustomEvent).detail ?? {}
      if (!id || !status) return
      statusMap[id] = status as TabStatus
      schedule()
    }
    window.addEventListener('terminal-status', onStatus)

    return () => {
      if (timer) clearTimeout(timer)
      d1.dispose(); d2.dispose(); d3.dispose()
      window.removeEventListener('terminal-status', onStatus)
    }
  }, [dockviewApi])
}
