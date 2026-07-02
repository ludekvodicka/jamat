import type { AgentId } from '../../../core/types/contracts'
import { isAgentId } from '../../../core/types/contracts'

export interface TabType {
  id: string
  label: string
  icon: string
  component: string
  /**
   * Param object given to the panel on mount. For terminal tabs that
   * launch an agent, set `agent: AgentId` here — the picker reads it
   * via `tabAgent(t)` to compute the disabled state.
   */
  defaultParams: Record<string, unknown>
  shortcut?: string
  /** Group heading shown in the tab picker. Keep same-section entries adjacent. */
  section?: string
}

/** Extract the `agent` field from a TabType's defaultParams, or undefined. */
export function tabAgent(t: TabType): AgentId | undefined {
  const a = t.defaultParams.agent
  return isAgentId(a) ? a : undefined
}

// Order = picker order. Grouped into sections (Claude Code first). The picker
// renders a heading whenever `section` changes, so keep same-section rows adjacent.
// Note: Session Search + File Viewer are intentionally absent — both only make
// sense opened from an active session (they need its context), so they're reachable
// from session affordances, not the standalone tab picker / command palette.
export const TAB_TYPES: TabType[] = [
  // Agents
  { id: 'claude', label: 'Claude Code', icon: '🤖', component: 'terminalPanel', defaultParams: { agent: 'claude' }, shortcut: 'Ctrl+T', section: 'Agents' },
  { id: 'codex', label: 'Codex', icon: '🟢', component: 'terminalPanel', defaultParams: { agent: 'codex' }, section: 'Agents' },
  // Shells
  { id: 'cmd', label: 'CMD', icon: '⬛', component: 'terminalPanel', defaultParams: { tabType: 'cmd', command: 'cmd.exe' }, section: 'Shells' },
  { id: 'powershell', label: 'PowerShell', icon: '🔷', component: 'terminalPanel', defaultParams: { tabType: 'powershell', command: 'powershell.exe' }, section: 'Shells' },
  // Tools
  { id: 'browser', label: 'Browser', icon: '🌐', component: 'browserPanel', defaultParams: { tabType: 'browser', url: 'https://www.google.com' }, section: 'Tools' },
  { id: 'usage-stats', label: 'Usage Stats', icon: '📊', component: 'usageStatsNativePanel', defaultParams: {}, shortcut: 'Ctrl+U', section: 'Tools' },
  { id: 'usage-stats-html', label: 'Usage Stats (HTML)', icon: '📊', component: 'usageStatsPanel', defaultParams: {}, section: 'Tools' },
  { id: 'ideas', label: 'Ideas', icon: '💡', component: 'ideasPanel', defaultParams: {}, shortcut: 'Ctrl+I', section: 'Tools' },
  { id: 'abilities', label: 'Claude Abilities', icon: '🧰', component: 'abilitiesPanel', defaultParams: {}, shortcut: 'Ctrl+Y', section: 'Tools' },
  { id: 'remote', label: 'Remote connections', icon: '🛰', component: 'remoteConnectionsPanel', defaultParams: {}, section: 'Tools' },
  // App
  { id: 'errorlog', label: 'Error Log', icon: '⚠', component: 'errorLogPanel', defaultParams: {}, section: 'App' },
  { id: 'help', label: 'Help', icon: '❓', component: 'helpPanel', defaultParams: {}, section: 'App' },
  { id: 'settings', label: 'Settings', icon: '⚙', component: 'settingsPanel', defaultParams: {}, section: 'App' },
]
