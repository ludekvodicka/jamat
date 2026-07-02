import { registerHandler } from '../shared/typed-ipc'
import { getLayoutState, setLayoutState } from './app-state-store'

const VALID_WINDOW_ID = /^[a-zA-Z0-9_-]+$/

/**
 * Per-window dockview tab layout. Stored as the `layouts[<windowId>]` section of the unified
 * app-state.json — MAIN is the single writer (atomic + snapshotted), so the renderer can no longer
 * truncate a layout file by racing the process exit, and windows ↔ layouts stay in one consistent
 * document. The renderer still sends/receives the dockview state as a JSON string; main parses it
 * into the store on save and re-serializes on load.
 */
export function registerLayoutIpc(): void {
  registerHandler('layout:save', async (_event, windowId: string, json: string) => {
    if (typeof windowId !== 'string' || !VALID_WINDOW_ID.test(windowId)) return
    if (typeof json !== 'string' || json.length > 10_000_000) return
    try { setLayoutState(windowId, JSON.parse(json)) } catch { /* ignore malformed layout */ }
  })

  registerHandler('layout:load', async (_event, windowId: string) => {
    if (typeof windowId !== 'string' || !VALID_WINDOW_ID.test(windowId)) return null
    const layout = getLayoutState(windowId)
    return layout === undefined ? null : JSON.stringify(layout)
  })
}
