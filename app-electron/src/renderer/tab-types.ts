export interface TabType {
  id: string
  label: string
  icon: string
  component: string
  /** Param object given to the panel on mount. */
  defaultParams: Record<string, unknown>
  /** Command-palette entry; defaults to `New <label> Tab`. Set it when that would stutter. */
  commandLabel?: string
  shortcut?: string
  /** Group heading shown in the tab picker. Keep same-section entries adjacent. */
  section?: string
}

// Windows offers CMD + PowerShell; POSIX offers a single "Terminal" tab with NO command, so the
// main process spawns the platform default shell ($SHELL / zsh / bash — see pty-manager). The
// renderer is sandboxed (no `process`), so the platform comes from the preload bridge.
const SHELL_TABS: TabType[] = window.electronAPI?.platform === 'win32'
  ? [
      { id: 'cmd', label: 'CMD', icon: '⬛', component: 'terminalPanel', defaultParams: { tabType: 'cmd', command: 'cmd.exe' }, section: 'Shells' },
      { id: 'powershell', label: 'PowerShell', icon: '🔷', component: 'terminalPanel', defaultParams: { tabType: 'powershell', command: 'powershell.exe' }, section: 'Shells' },
    ]
  : [
      { id: 'terminal', label: 'Terminal', icon: '⬛', component: 'terminalPanel', defaultParams: { tabType: 'terminal' }, section: 'Shells' },
    ]

// Order = picker order. Grouped into sections (Claude Code first). The picker
// renders a heading whenever `section` changes, so keep same-section rows adjacent.
// Note: Session Search + File Viewer are intentionally absent — both only make
// sense opened from an active session (they need its context), so they're reachable
// from session affordances, not the standalone tab picker / command palette.
export const TAB_TYPES: TabType[] = [
  // Agents — ONE row: the tab always opens the Jamat menu, and the menu's session picker is
  // where the agent is chosen (a `＋ New <Agent> session` row per installed agent, the config's
  // defaultAgent first + preselected). A per-agent picker row would be a lie: `screen:create`
  // starts the menu regardless, so the tab's `agent` is only set once the menu launches one.
  { id: 'agent', label: 'New Agent Session', icon: '🤖', component: 'terminalPanel', defaultParams: {}, commandLabel: 'New Agent Session', shortcut: 'Ctrl+T', section: 'Agents' },
  // Shells
  ...SHELL_TABS,
  // Tools
  { id: 'browser', label: 'Browser', icon: '🌐', component: 'browserPanel', defaultParams: { tabType: 'browser', url: 'https://www.google.com' }, section: 'Tools' },
  { id: 'usage-stats', label: 'Usage Stats', icon: '📊', component: 'usageStatsPanel', defaultParams: {}, shortcut: 'Ctrl+U', section: 'Tools' },
  { id: 'ideas', label: 'Ideas', icon: '💡', component: 'ideasPanel', defaultParams: {}, shortcut: 'Ctrl+I', section: 'Tools' },
  { id: 'abilities', label: 'Claude Abilities', icon: '🧰', component: 'abilitiesPanel', defaultParams: {}, shortcut: 'Ctrl+Y', section: 'Tools' },
  { id: 'remote', label: 'Remote connections', icon: '🛰', component: 'remoteConnectionsPanel', defaultParams: {}, section: 'Tools' },
  // App
  { id: 'errorlog', label: 'Error Log', icon: '⚠', component: 'errorLogPanel', defaultParams: {}, section: 'App' },
  { id: 'help', label: 'Help', icon: '❓', component: 'helpPanel', defaultParams: {}, section: 'App' },
  { id: 'settings', label: 'Settings', icon: '⚙', component: 'settingsPanel', defaultParams: {}, section: 'App' },
]
