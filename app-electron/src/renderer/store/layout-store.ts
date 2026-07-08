import { create } from 'zustand'
import { DockviewApi, DockviewGroupPanel } from 'dockview'
import type { AppConfig, UsageCache } from '../../shared/types'
import { DEFAULT_THEME, type ThemeId } from '../themes'

/** The xterm renderer a terminal ACTUALLY ended up on. 'dom' (default) loads no addon; 'webgl' is the
 *  opt-in accelerated renderer (also the value drops to 'dom' if its GPU context is lost).
 *  (Canvas was removed in xterm 6.) */
export type TerminalRenderer = 'webgl' | 'dom'

/** Canonical per-terminal turn status (what the agent is doing right now). Mirror of the union in
 *  useTerminal's classifier; kept here so it can be the single LEVEL-triggered source of truth. */
export type TerminalStatus = 'idle' | 'running' | 'tool-use' | 'blocked' | 'waiting' | 'done'

let terminalNum = 1

export function addPanelToApi(api: DockviewApi, group?: DockviewGroupPanel) {
  const num = terminalNum++
  const id = `terminal-${Date.now()}`
  const title = `Terminal ${num}`

  api.addPanel({
    id,
    component: 'terminalPanel',
    title,
    params: {},
    ...(group ? { position: { referenceGroup: group } } : {})
  })
}

interface LayoutStore {
  dockviewApi: DockviewApi | null
  setDockviewApi: (api: DockviewApi) => void

  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void

  panelCount: number
  setPanelCount: (count: number) => void

  /** The active dockview panel's UNIQUE id (not its title) — the change-key that re-arms every
   *  active-tab-dependent effect (status-bar model/context, SessionChangesPanel follow, renderer
   *  badge). MUST stay the id: titles are not unique (two sessions of the same project share one),
   *  so a title key wouldn't change when switching between same-titled tabs and the effects would
   *  read stale data. */
  activePanel: string | null
  setActivePanel: (id: string | null) => void

  /** Tabs that finished a turn (running/tool-use → idle) while NOT focused — the
   *  "completed work, unseen" state. Keyed by panel id. Maintained by useCompletedTabs;
   *  read by CustomTab / TabListPanel to show a green ✓ badge so a tab that just finished
   *  off-screen stands out from a plain idle/grey one. Cleared when the user activates the
   *  tab (sees it) or a new turn starts on it. Renderer-only — NOT part of the canonical
   *  terminal status or the bridge tab tree. */
  completedTabs: Record<string, boolean>
  markTabCompleted: (id: string) => void
  clearTabCompleted: (id: string) => void

  /** Canonical turn status per terminal, keyed by terminalId (= dockview panel id). Written by
   *  useTerminal's classifier on every change; read by CustomTab/TabListPanel to color the status dot.
   *  LEVEL-triggered (unlike the `terminal-status` CustomEvent, which fires only on change) so a tab
   *  header that mounts or REMOUNTS after the status settled — e.g. after a window resize, or during a
   *  long steady "running"/"thinking" turn with no further transitions — reads the CURRENT value
   *  instead of being stuck at its initial 'idle'/grey. Cleared on terminal destroy. */
  terminalStatus: Record<string, TerminalStatus>
  setTerminalStatus: (id: string, status: TerminalStatus) => void

  /** Tabs whose agent turn is idle but a BACKGROUND SHELL is still running (Claude's "N shell"
   *  footer count > 0). ORTHOGONAL to `terminalStatus` — a running shell is not the agent working,
   *  so it never flips the dot to 'running'; instead CustomTab/TabListPanel show a muted, slow-pulsing
   *  dot on an idle tab so "turn done, but something's still alive (and may hang)" is visible at a
   *  glance. Keyed by terminalId; written by useTerminal's classifier, cleared on terminal destroy. */
  bgShellTabs: Record<string, boolean>
  setBgShell: (id: string, on: boolean) => void

  /** Work-detection status-bar widget toggle. While true, useTerminal publishes each terminal's
   *  normalized output tail into `terminalDebug` (throttled) so the widget can show what the busy
   *  classifier sees live. Off by default → zero overhead; flipped on only while the widget is mounted. */
  detectionDebug: boolean
  setDetectionDebug: (on: boolean) => void

  /** Live work-detection inputs per terminal, for the status-bar widget: `tail` is the space-preserved
   *  RAW PTY tail; `screen` is the rendered xterm bottom rows (where Claude's status line always is —
   *  robust against differential redraws). Only written while `detectionDebug` is on. Keyed by
   *  terminalId; cleared on terminal destroy. */
  terminalDebug: Record<string, { tail: string; screen: string; ts: number }>
  setTerminalDebug: (id: string, tail: string, screen: string, ts: number) => void

  /** Actual renderer each live terminal is on, keyed by terminalId (= dockview panel id). Written by
   *  useTerminal on create / WebGL context-loss; read by the status-bar C/OGL/DOM badge so a silent
   *  fallback (e.g. "Canvas" that didn't load → DOM) is visible per active tab. */
  terminalRenderers: Record<string, TerminalRenderer>
  setTerminalRenderer: (id: string, renderer: TerminalRenderer) => void
  clearTerminalRenderer: (id: string) => void

  /** Live geometry of each terminal, keyed by terminalId. Diagnostic: shown next to the renderer
   *  badge so a resize/reflow on tab switch is visible — cols/rows changing (reflow) vs holding
   *  steady while the view still corrupts (stale buffer). Updated on fit/refit/repaint. */
  terminalDims: Record<string, { cols: number; rows: number }>
  setTerminalDims: (id: string, cols: number, rows: number) => void

  terminalSelection: string
  setTerminalSelection: (text: string) => void

  appConfig: AppConfig | null
  setAppConfig: (config: AppConfig | null) => void

  usageData: UsageCache | null
  setUsageData: (data: UsageCache | null) => void

  currentTheme: ThemeId
  setTheme: (id: ThemeId) => void

  addPanel: (group?: DockviewGroupPanel) => void
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  dockviewApi: null,
  setDockviewApi: (api) => set({ dockviewApi: api }),

  sidebarOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  panelCount: 0,
  setPanelCount: (count) => set({ panelCount: count }),

  activePanel: null,
  setActivePanel: (id) => set({ activePanel: id }),

  completedTabs: {},
  markTabCompleted: (id) =>
    set((s) => (s.completedTabs[id] ? s : { completedTabs: { ...s.completedTabs, [id]: true } })),
  clearTabCompleted: (id) =>
    set((s) => {
      if (!s.completedTabs[id]) return s
      const next = { ...s.completedTabs }; delete next[id]
      return { completedTabs: next }
    }),

  terminalStatus: {},
  setTerminalStatus: (id, status) =>
    set((s) => (s.terminalStatus[id] === status ? s : { terminalStatus: { ...s.terminalStatus, [id]: status } })),

  bgShellTabs: {},
  setBgShell: (id, on) =>
    set((s) => {
      if (!!s.bgShellTabs[id] === on) return s
      if (on) return { bgShellTabs: { ...s.bgShellTabs, [id]: true } }
      const next = { ...s.bgShellTabs }; delete next[id]
      return { bgShellTabs: next }
    }),

  detectionDebug: false,
  setDetectionDebug: (on) => set((s) => (s.detectionDebug === on ? s : { detectionDebug: on })),

  terminalDebug: {},
  setTerminalDebug: (id, tail, screen, ts) =>
    set((s) => ({ terminalDebug: { ...s.terminalDebug, [id]: { tail, screen, ts } } })),

  terminalRenderers: {},
  setTerminalRenderer: (id, renderer) =>
    set((s) => ({ terminalRenderers: { ...s.terminalRenderers, [id]: renderer } })),
  clearTerminalRenderer: (id) =>
    set((s) => {
      const renderers = { ...s.terminalRenderers }; delete renderers[id]
      const dims = { ...s.terminalDims }; delete dims[id]
      const status = { ...s.terminalStatus }; delete status[id]
      const debug = { ...s.terminalDebug }; delete debug[id]
      const bgShell = { ...s.bgShellTabs }; delete bgShell[id]
      return { terminalRenderers: renderers, terminalDims: dims, terminalStatus: status, terminalDebug: debug, bgShellTabs: bgShell }
    }),

  terminalDims: {},
  setTerminalDims: (id, cols, rows) =>
    set((s) => {
      const cur = s.terminalDims[id]
      if (cur && cur.cols === cols && cur.rows === rows) return s
      return { terminalDims: { ...s.terminalDims, [id]: { cols, rows } } }
    }),

  terminalSelection: '',
  setTerminalSelection: (text) => set({ terminalSelection: text }),

  appConfig: null,
  setAppConfig: (config) => set({ appConfig: config }),

  usageData: null,
  setUsageData: (data) => set({ usageData: data }),

  currentTheme: (localStorage.getItem('terminal-theme') as ThemeId) || DEFAULT_THEME,
  setTheme: (id) => {
    localStorage.setItem('terminal-theme', id)
    set({ currentTheme: id })
  },

  addPanel: (group?) => {
    const api = get().dockviewApi
    if (api) addPanelToApi(api, group)
  }
}))
