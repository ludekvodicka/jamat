import { useState, useEffect, useRef, useMemo } from 'react'
import { useLayoutStore } from '../store/layout-store'
import { TAB_TYPES } from '../tab-types'
import { themes } from '../themes'
import { loadSettings } from './panels/SettingsPanel'
import { fileViewerPanelId, closePanelActivatingNeighbor } from '../utils/terminal-helpers'

interface Command {
  id: string
  label: string
  category: string
  action: () => void
}

interface DynamicSources {
  files: { path: string; name: string; relative: string }[]
  sessions: { sessionId: string; slug: string | null; projectDir: string }[]
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dynamic, setDynamic] = useState<DynamicSources>({ files: [], sessions: [] })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Pull recent files + recent sessions for the active project once on open.
  // Cheap enough (already-cached IPCs); no debounce needed at open-time.
  useEffect(() => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) return
    const activeParams = api.activePanel?.params as Record<string, unknown> | undefined
    const projectDir = (activeParams?.projectDir ?? activeParams?.cwd) as string | undefined
    if (!projectDir) return
    const { recentFilesCount } = loadSettings()
    let cancelled = false
    Promise.all([
      window.electronAPI?.listRecentFiles?.(projectDir, recentFilesCount) ?? Promise.resolve([]),
      window.electronAPI?.listSessions?.(projectDir) ?? Promise.resolve([]),
    ]).then(([files, sessions]) => {
      if (cancelled) return
      setDynamic({
        files: (files ?? []).map((f) => ({ path: f.path, name: f.name, relative: f.relative })),
        sessions: (sessions ?? []).slice(0, 15).map((s) => ({
          sessionId: s.sessionId,
          slug: s.slug,
          projectDir,
        })),
      })
    }).catch(() => { /* silent — palette still works for commands */ })
    return () => { cancelled = true }
  }, [])

  const commands = useMemo(() => {
    const api = useLayoutStore.getState().dockviewApi
    const cmds: Command[] = []

    for (const t of TAB_TYPES) {
      cmds.push({
        id: `new-${t.id}`,
        label: `New ${t.label} Tab`,
        category: 'Tabs',
        action: () => {
          if (!api) return
          const id = `${t.id}-${Date.now()}`
          api.addPanel({ id, component: t.component, title: t.label, params: { ...t.defaultParams } })
        }
      })
    }

    cmds.push({
      id: 'close-tab', label: 'Close Active Tab', category: 'Tabs',
      action: () => { if (api?.activePanel) closePanelActivatingNeighbor(api, api.activePanel) }
    })

    cmds.push({
      id: 'toggle-sidebar', label: 'Toggle Sidebar', category: 'View',
      action: () => useLayoutStore.getState().toggleSidebar()
    })

    cmds.push({
      id: 'toggle-notes', label: 'Toggle Notes Panel', category: 'View',
      action: () => {
        if (api?.activePanel) window.dispatchEvent(new CustomEvent('toggle-notes', { detail: api.activePanel.id }))
      }
    })

    cmds.push({
      id: 'maximize', label: 'Maximize / Restore Panel', category: 'View',
      action: () => {
        if (!api) return
        if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
        else if (api.activePanel) api.maximizeGroup(api.activePanel)
      }
    })

    cmds.push({
      id: 'new-window', label: 'New Window', category: 'Window',
      action: () => window.electronAPI?.newWindow()
    })

    for (const [id, t] of Object.entries(themes)) {
      cmds.push({
        id: `theme-${id}`, label: `Theme: ${t.name}`, category: 'Appearance',
        action: () => {
          useLayoutStore.getState().setTheme(id)
          window.location.reload()
        }
      })
    }

    cmds.push({
      id: 'reset-layout', label: 'Reset Layout (merge all tabs)', category: 'View',
      action: () => window.dispatchEvent(new CustomEvent('command:reset-layout'))
    })

    cmds.push({
      id: 'dev-tools', label: 'Toggle Developer Tools', category: 'Dev',
      action: () => window.electronAPI?.runAction?.('dev-tools')
    })

    // Dockview tabs — jump to any open panel by title.
    for (const panel of api?.panels ?? []) {
      cmds.push({
        id: `tab-${panel.id}`,
        label: panel.title ?? panel.id,
        category: 'Tab',
        action: () => panel.api.setActive(),
      })
    }

    // Recent files for the active project — open in FileViewer.
    for (const f of dynamic.files) {
      cmds.push({
        id: `file-${f.path}`,
        label: f.relative || f.name,
        category: 'File',
        action: () => {
          if (!api) return
          const projectDir = (api.activePanel?.params as Record<string, unknown> | undefined)?.projectDir as string | undefined
          const id = fileViewerPanelId(projectDir, f.path)
          const existing = api.panels.find((p) => p.id === id)
          if (existing) { existing.api.setActive(); return }
          api.addPanel({
            id,
            component: 'fileViewerPanel',
            title: f.name,
            params: { filePath: f.path, projectDir },
          })
        },
      })
    }

    // Recent sessions for the active project — open as a tab.
    for (const s of dynamic.sessions) {
      cmds.push({
        id: `session-${s.sessionId}`,
        label: s.slug ?? s.sessionId.slice(0, 8),
        category: 'Session',
        action: () => { void window.electronAPI?.openSessionInTab?.(s.projectDir, s.sessionId) },
      })
    }

    return cmds
  }, [dynamic])

  const filtered = useMemo(() => {
    if (!query) return commands
    const q = query.toLowerCase()
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
    )
  }, [query, commands])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Reset selection when the command list itself changes (async dynamic
  // data lands). Without this the user's down-arrow position can point to
  // a different command after files/sessions arrive and reshuffle filtered.
  useEffect(() => {
    setSelectedIndex(0)
  }, [commands])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const execute = (cmd: Command) => {
    onClose()
    cmd.action()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    }
    if (e.key === 'Enter' && filtered[selectedIndex]) {
      e.preventDefault()
      execute(filtered[selectedIndex])
    }
  }

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          placeholder="Type a command..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-list" ref={listRef}>
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${i === selectedIndex ? 'selected' : ''}`}
              onClick={() => execute(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="command-palette-category">{cmd.category}</span>
              <span className="command-palette-label">{cmd.label}</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="command-palette-empty">No matching commands</div>
          )}
        </div>
      </div>
    </div>
  )
}
