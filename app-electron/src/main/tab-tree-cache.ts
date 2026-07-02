/**
 * Tab-tree cache for Remote App Control.
 *
 * The dockview tab list (titles, types, Claude status) lives only in each
 * renderer. The control-server needs it synchronously when serving
 * `/control/windows`, but the dynamic `ipcMain.once(reqId)` reply pattern the
 * legacy dialogs use does NOT work for the app windows (sandbox +
 * contextIsolation — the renderer can't reply on an arbitrary channel). So we
 * invert it: each renderer PUSHES its tab list on change (the always-allowed
 * renderer→main `send` direction), and main caches it per `webContents.id`.
 * Reads are then a synchronous cache lookup.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { registerSend } from '../shared/typed-ipc'
import { hasBufferedTerminal, getTerminalCwd } from './pty-manager'
import { getTerminalSessionId } from './screen-executor'
import type { RemoteTabInfo, RemoteWindowInfo, TabStatus } from '../../../core/types/remote-control.js'

const cache = new Map<number, { title: string; tabs: RemoteTabInfo[] }>()

// Subscribers notified whenever a renderer pushes a fresh tab list (i.e. a tab's
// Claude status changed). Lets the update-checker react to "everything went idle"
// without polling. Best-effort: a throwing subscriber must not break the push.
const tabsChangedSubscribers = new Set<() => void>()
export function onTabsChanged(cb: () => void): () => void {
  tabsChangedSubscribers.add(cb)
  return () => tabsChangedSubscribers.delete(cb)
}

function isValidTab(x: unknown): x is RemoteTabInfo {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.terminalId === 'string'
    && typeof o.title === 'string'
    && typeof o.type === 'string'
    && typeof o.streamable === 'boolean'
}

export function registerTabTreeCache(): void {
  registerSend('tabs:push', (event, tabs: unknown) => {
    const wcId = event.sender.id
    const win = BrowserWindow.fromWebContents(event.sender)
    const title = win?.getTitle() ?? `Window ${wcId}`
    const safe = Array.isArray(tabs) ? tabs.filter(isValidTab) : []
    cache.set(wcId, { title, tabs: safe })
    for (const cb of tabsChangedSubscribers) { try { cb() } catch { /* ignore */ } }
  })
}

/** Current Claude turn-status for one terminal, from the renderer-pushed cache (the
 *  SAME source `getWindowsTabs` uses). Undefined when the tab or its status is unknown
 *  (fresh tab / non-Claude cmd-powershell tab). Lets the control-server fold status
 *  into the `scrollback` response so the Jamat's await loop reads it without a
 *  separate `windows` round-trip. */
export function getTabStatus(terminalId: string): TabStatus | undefined {
  for (const { tabs } of cache.values()) {
    const t = tabs.find((x) => x.terminalId === terminalId)
    // A streamable terminal that never reported a status is idle: the renderer emits
    // `terminal-status` only on CHANGE, so a tab sitting at its initial idle (e.g. a
    // freshly bridge-opened scratch Claude that hasn't started a turn yet) emits nothing.
    // `hasBufferedTerminal` is the authoritative main-side "is a live PTY" fact, so default
    // its missing status to idle — the Jamat then sees a concrete state, not `unknown`.
    if (t) return t.status ?? (hasBufferedTerminal(terminalId) ? 'idle' : undefined)
  }
  return undefined
}

/** Current windows→tabs, pruning any windows that have since closed. */
export function getWindowsTabs(): RemoteWindowInfo[] {
  const alive = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
  for (const id of [...cache.keys()]) if (!alive.has(id)) cache.delete(id)
  return [...cache.entries()].map(([windowId, v]) => ({
    windowId,
    title: v.title,
    // `streamable` is an authoritative MAIN-side fact (does a PTY ring buffer
    // exist for this id?), NOT the renderer's id-prefix guess — terminal tabs
    // created via the picker get ids like `claude-…`/`cmd-…`, not `terminal-…`.
    tabs: v.tabs.map((t) => {
      const streamable = hasBufferedTerminal(t.terminalId)
      // `cwd` (like `streamable`) is an authoritative MAIN-side fact from the pty
      // manager's spawn record — not from the renderer push. Absent for non-terminals.
      const cwd = streamable ? getTerminalCwd(t.terminalId) : undefined
      // sessionId (authoritative MAIN-side fact from the screen executor) — present only for a
      // running Claude terminal. A UI hint so a controller shows "fork" on Claude tabs but not
      // shell tabs; the fork re-resolves it server-side from the terminalId (control-ops forkOf).
      const sessionId = streamable ? getTerminalSessionId(t.terminalId) : undefined
      // Default a streamable tab with no renderer-reported status to idle (the renderer
      // emits terminal-status only on CHANGE; a tab at its initial idle emits nothing) so
      // `find`/await report a concrete state instead of `unknown`. See getTabStatus.
      const status = t.status ?? (streamable ? 'idle' : undefined)
      return { ...t, streamable, cwd, sessionId, status, type: streamable ? 'terminal' : t.type }
    }),
  }))
}

/** Every streamable tab is quiet — no Claude turn running / using a tool / blocked / waiting
 *  on the user. Shared by both update channels (VCS self-pull + GitHub auto-update) so an
 *  inevitable restart never interrupts a live agent turn. */
export function allTabsIdle(): boolean {
  for (const w of getWindowsTabs()) {
    for (const t of w.tabs) {
      if (!t.streamable) continue
      if (t.status === 'running' || t.status === 'tool-use' || t.status === 'blocked' || t.status === 'waiting') return false
    }
  }
  return true
}
