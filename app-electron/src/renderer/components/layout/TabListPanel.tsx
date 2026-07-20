import { useLayoutStore } from '../../store/layout-store'
import { useEffect, useState } from 'react'
import { IDockviewPanel } from 'dockview'
import type { AgentWorkStatus } from '../../../../../core/agents/workDetection/agentWorkDetector.types'

export function TabListPanel() {
  const { dockviewApi, sidebarOpen, setSidebarOpen, addPanel: storeAddPanel, completedTabs, bgShellTabs } = useLayoutStore()
  const [panels, setPanels] = useState<{ id: string; title: string; type: string }[]>([])
  const [statusMap, setStatusMap] = useState<Record<string, AgentWorkStatus>>({})

  useEffect(() => {
    if (!dockviewApi) return

    const refresh = () => {
      const list = dockviewApi.panels.map((p: IDockviewPanel) => ({
        id: p.id,
        title: p.title ?? p.id,
        type: p.id.startsWith('terminal') ? 'terminal' : 'panel'
      }))
      setPanels(list)
    }

    refresh()
    const d1 = dockviewApi.onDidAddPanel(refresh)
    const d2 = dockviewApi.onDidRemovePanel(refresh)
    return () => { d1.dispose(); d2.dispose() }
  }, [dockviewApi])

  useEffect(() => {
    const handler = (e: Event) => {
      const { id, status } = (e as CustomEvent<{ id?: string; status?: AgentWorkStatus }>).detail ?? {}
      if (!id || !status) return
      setStatusMap(prev => ({ ...prev, [id]: status }))
    }
    window.addEventListener('terminal-status', handler)
    return () => window.removeEventListener('terminal-status', handler)
  }, [])

  const handleAddPanel = () => {
    storeAddPanel()
    setSidebarOpen(false)
  }

  const activatePanel = (id: string) => {
    if (!dockviewApi) return
    const panel = dockviewApi.getPanel(id)
    if (panel) {
      panel.api.setActive()
      setSidebarOpen(false)
    }
  }

  if (!sidebarOpen) return null

  return (
    <>
      <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      <div className="sidebar open">
        <div className="sidebar-header">
          <span>Panels ({panels.length})</span>
          <button onClick={() => setSidebarOpen(false)}>✕</button>
        </div>
        <div className="sidebar-list">
          {panels.map((p) => {
            const st = p.type === 'terminal' ? (statusMap[p.id] ?? 'idle') : null
            return (
              <div
                key={p.id}
                className="sidebar-item"
                onClick={() => activatePanel(p.id)}
              >
                <span style={{ color: '#569cd6', fontSize: 12, marginRight: 4 }}>
                  {p.type === 'terminal' ? '>' : '#'}
                </span>
                <span className="panel-name">{p.title}</span>
                {st === 'waiting'
                  ? <span className="status-question-badge sidebar-status-question" title="Waiting for your answer — needs interaction">?</span>
                  : (st === 'idle' && bgShellTabs[p.id])
                    ? <span className="sidebar-status-dot status-bgshell" title="Turn finished, but a background shell or sub-agent is still running (may be hung) — Ctrl+T in the terminal to manage it" />
                    : (st === 'idle' && completedTabs[p.id])
                      ? <span className="status-completed-badge sidebar-status-question" title="Finished while you were away — switch to this tab to clear">✓</span>
                      : (st && st !== 'idle')
                        ? <span className={`sidebar-status-dot status-${st}`} title={st} />
                        : null}
              </div>
            )
          })}
          {panels.length === 0 && (
            <div style={{ padding: '16px', color: '#666', fontSize: 13 }}>
              No panels. Add one below.
            </div>
          )}
        </div>
        <div className="sidebar-actions">
          <button onClick={handleAddPanel}>+ Add Terminal</button>
        </div>
      </div>
    </>
  )
}
