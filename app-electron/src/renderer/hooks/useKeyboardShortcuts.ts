import { useEffect } from 'react'
import { type DockviewApi } from 'dockview'
import { useLayoutStore } from '../store/layout-store'
import {
  openOrActivatePanel,
  getActiveProjectDir,
  openFileChangesPanel,
  openSessionHistoryPanel,
  openIdeasPanel,
  closePanelActivatingNeighbor,
} from '../utils/terminal-helpers'
import { movePanelInDirection, resetLayout, getDockviewAccessor } from '../utils/panel-layout'
import type { Direction } from '../utils/panel-layout'

export { movePanelInDirection, resetLayout }
export type { Direction }

function cleanSelectionPath(raw: string): string {
  let p = raw.replace(/["`']/g, '').trim()
  p = p.replace(/:\d+(?::\d+)?$/, '')
  p = p.replace(/[.,;:!?\s]+$/, '')
  return p.trim()
}

async function openFileFromSelection(api: DockviewApi): Promise<void> {
  const activePanel = api.activePanel
  if (!activePanel) return

  const selText = useLayoutStore.getState().terminalSelection
  if (!selText) return

  const projectDir = (activePanel.params as any)?.projectDir ?? (activePanel.params as any)?.cwd ?? null
  const cleaned = cleanSelectionPath(selText)
  if (!cleaned) return
  const normalized = cleaned.replace(/\//g, '\\')

  let filePath: string | null = null
  if (/^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith('\\')) {
    filePath = normalized
  } else if (projectDir) {
    filePath = projectDir + '\\' + normalized
  }
  if (!filePath) return

  const exists = await window.electronAPI.fileExists(filePath)
  if (!exists) return
  const id = `file-${Date.now()}`
  const fileName = filePath.replace(/^.*[/\\]/, '')
  api.addPanel({ id, component: 'fileViewerPanel', title: fileName, params: { filePath } })
}

export function useKeyboardShortcuts(
  addPanel: () => void,
  toggleSidebar: () => void,
  setShowTabPicker: (v: boolean) => void,
  setShowCommandPalette: (fn: (v: boolean) => boolean) => void,
  openNewWindow: () => void
) {
  useEffect(() => {
    const handler = () => resetLayout()
    window.addEventListener('command:reset-layout', handler)
    return () => window.removeEventListener('command:reset-layout', handler)
  }, [])

  useEffect(() => {
    let chordMode = false
    let chordTimer: ReturnType<typeof setTimeout> | null = null

    const exitChord = () => {
      chordMode = false
      if (chordTimer) { clearTimeout(chordTimer); chordTimer = null }
    }

    const handler = (e: KeyboardEvent) => {
      const api = useLayoutStore.getState().dockviewApi

      if (e.altKey && e.key === 't' && !chordMode) {
        e.preventDefault()
        chordMode = true
        chordTimer = setTimeout(exitChord, 1500)
        return
      }

      if (chordMode && e.altKey) {
        e.preventDefault()
        exitChord()
        if (e.key === 'n') movePanelInDirection('right')
        else if (e.key === 'p') movePanelInDirection('left')
        else if (e.key === 'u') movePanelInDirection('above')
        else if (e.key === 'd') movePanelInDirection('below')
        return
      }

      if (chordMode) { exitChord(); return }

      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        setShowTabPicker(true)
        return
      }
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault()
        setShowCommandPalette(v => !v)
        return
      }
      // Ctrl+P opens the same palette — file/tab/session-finder semantics
      // are merged into the existing command palette. Skip real form
      // inputs (the xterm helper-textarea is excluded; xterm bubbles
      // Ctrl+P out so the shortcut works from a focused terminal).
      if (e.ctrlKey && e.key === 'p' && !e.shiftKey) {
        const target = e.target as HTMLElement | null
        const isXtermHelper = target?.classList.contains('xterm-helper-textarea')
        const isInput = !isXtermHelper && target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        if (!isInput) {
          e.preventDefault()
          setShowCommandPalette(v => !v)
          return
        }
      }
      // Ctrl+I opens the Ideas panel. Skip when typing into a real form
      // input (the xterm helper-textarea is excluded because xterm's own
      // attachCustomKeyEventHandler already bubbles Ctrl+I out — we want
      // the shortcut to work from a focused terminal).
      if (e.ctrlKey && e.key === 'i' && !e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement | null
        const isXtermHelper = target?.classList.contains('xterm-helper-textarea')
        const isInput = !isXtermHelper && target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        if (!isInput) {
          e.preventDefault()
          const api = useLayoutStore.getState().dockviewApi
          if (api) openIdeasPanel(api)
          return
        }
      }
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault()
        addPanel()
      }
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault()
        openNewWindow()
      }
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault()
        if (api && api.activePanel) {
          closePanelActivatingNeighbor(api, api.activePanel)
        }
      }
      if (e.ctrlKey && e.key === 'h' && api) {
        e.preventDefault()
        const projectDir = getActiveProjectDir(api)
        if (projectDir) openSessionHistoryPanel(api, projectDir)
      }
      if (e.ctrlKey && e.key === 'j' && api) {
        e.preventDefault()
        const projectDir = getActiveProjectDir(api)
        if (projectDir) {
          const sessionId = (api.activePanel?.params as Record<string, unknown> | undefined)?.sessionId as string | undefined
          openFileChangesPanel(api, projectDir, { sessionId })
        }
      }
      if (e.ctrlKey && e.key === 'u' && api) {
        e.preventDefault()
        openOrActivatePanel(api, 'usage-stats-native', 'usageStatsNativePanel', '📊 Usage Stats')
      }
      if (e.ctrlKey && e.key === 'y' && api) {
        e.preventDefault()
        openOrActivatePanel(api, 'claude-abilities', 'abilitiesPanel', '🧰 Claude Abilities')
      }
      if (e.ctrlKey && e.key === 'g' && api?.activePanel) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('toggle-notes', { detail: api.activePanel.id }))
      }
      if (e.ctrlKey && e.key === 'o' && api?.activePanel) {
        e.preventDefault()
        openFileFromSelection(api)
      }
      if (e.key === 'Tab' && e.ctrlKey && api) {
        e.preventDefault()
        const panels = api.panels
        if (panels.length < 2) return
        const activeIdx = panels.findIndex(p => p === api.activePanel)
        const next = e.shiftKey
          ? (activeIdx - 1 + panels.length) % panels.length
          : (activeIdx + 1) % panels.length
        panels[next].api.setActive()
      }
      if (e.key === 'F11' && api) {
        e.preventDefault()
        if (api.hasMaximizedGroup()) {
          api.exitMaximizedGroup()
        } else if (api.activePanel) {
          api.maximizeGroup(api.activePanel)
        }
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown') && api?.activePanel) {
        e.preventDefault()
        const panel = api.activePanel
        const group = (panel as any).group
        if (!group) return
        const groupPanels = group.panels as any[]
        const idx = groupPanels.indexOf(panel)
        if (idx < 0) return
        const newIdx = e.key === 'PageUp' ? idx - 1 : idx + 1
        if (newIdx < 0 || newIdx >= groupPanels.length) return
        const component = getDockviewAccessor()
        if (!component?.moveGroupOrPanel) return
        component.moveGroupOrPanel({
          from: { groupId: group.id, panelId: panel.id },
          to: { group, position: 'center', index: newIdx }
        })
      }
      if (e.key === 'F1' && api) {
        e.preventDefault()
        openOrActivatePanel(api, 'help', 'helpPanel', 'Help')
      }
      // F2 renames the active session. The rename modal lives inside each tab's CustomTab
      // (local state the shortcut can't reach), so broadcast the active panel id and let
      // that tab open its own modal — same bridge as the toggle-notes event above.
      if (e.key === 'F2' && api?.activePanel) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('rename-session', { detail: api.activePanel.id }))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleSidebar, addPanel, setShowTabPicker, setShowCommandPalette, openNewWindow])
}
