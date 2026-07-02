import { useEffect } from 'react'
import { useLayoutStore } from '../store/layout-store'
import {
  openOrActivatePanel,
  getActiveProjectDir,
  openFileChangesPanel,
  openSessionHistoryPanel,
  openSessionsSearchPanel,
  openIdeasPanel,
  closePanelActivatingNeighbor,
} from '../utils/terminal-helpers'
import { movePanelInDirection, resetLayout } from '../utils/panel-layout'
import type { Direction } from '../utils/panel-layout'

export function useMenuActions(
  addPanel: () => void,
  toggleSidebar: () => void,
  setShowTabPicker: (v: boolean) => void,
  setTheme: (id: string) => void
) {
  useEffect(() => {
    if (!window.electronAPI?.onMenuAction) return
    return window.electronAPI.onMenuAction((action, ...args) => {
      const api = useLayoutStore.getState().dockviewApi

      if (action === 'menu:new-tab') addPanel()
      if (action === 'menu:new-tab-picker') setShowTabPicker(true)
      if (action === 'menu:close-tab') {
        if (api && api.activePanel && api.panels.length > 1) closePanelActivatingNeighbor(api, api.activePanel)
      }
      if (action === 'menu:toggle-sidebar') toggleSidebar()
      if (action === 'menu:toggle-notes') {
        if (api?.activePanel) window.dispatchEvent(new CustomEvent('toggle-notes', { detail: api.activePanel.id }))
      }
      if (action === 'menu:toggle-maximize') {
        if (api) {
          if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
          else if (api.activePanel) api.maximizeGroup(api.activePanel)
        }
      }
      if (action === 'menu:move-tab') movePanelInDirection(args[0] as Direction)
      if (action === 'menu:reset-layout') resetLayout()
      if (action === 'menu:help' && api) openOrActivatePanel(api, 'help', 'helpPanel', 'Help')
      if (action === 'menu:settings' && api) openOrActivatePanel(api, 'settings', 'settingsPanel', 'Settings')
      if (action === 'menu:open-session-history' && api) {
        const projectDir = getActiveProjectDir(api)
        if (projectDir) openSessionHistoryPanel(api, projectDir)
      }
      if (action === 'menu:open-file-changes' && api) {
        const projectDir = getActiveProjectDir(api)
        if (projectDir) {
          const sessionId = (api.activePanel?.params as Record<string, unknown> | undefined)?.sessionId as string | undefined
          openFileChangesPanel(api, projectDir, { sessionId })
        }
      }
      if (action === 'menu:open-sessions-search' && api) {
        openSessionsSearchPanel(api)
      }
      if (action === 'menu:open-ideas' && api) {
        openIdeasPanel(api)
      }
      if (action === 'menu:new-tab-type' && api) {
        const tabType = args[0] as string
        const TAB_MAP: Record<string, [string, string, string]> = {
          'usage-stats': ['usage-stats', 'usageStatsPanel', '📊 Usage Stats'],
          'help': ['help', 'helpPanel', 'Help'],
          'settings': ['settings', 'settingsPanel', 'Settings'],
          'errorlog': ['error-log', 'errorLogPanel', 'Error Log'],
          'session-search': ['session-search', 'sessionSearchPanel', '🔍 Session Search'],
        }
        const entry = TAB_MAP[tabType]
        if (entry) openOrActivatePanel(api, entry[0], entry[1], entry[2])
        else addPanel()
      }
      if (action === 'menu:set-theme') {
        setTheme(args[0] as string)
        window.location.reload()
      }
    })
  }, [addPanel, toggleSidebar, setShowTabPicker, setTheme])
}
