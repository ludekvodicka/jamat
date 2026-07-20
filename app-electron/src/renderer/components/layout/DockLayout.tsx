import { DockviewReact, DockviewReadyEvent, DockviewApi, IDockviewHeaderActionsProps, IWatermarkPanelProps } from 'dockview'
import React, { useCallback, useRef } from 'react'
import { useLayoutStore, addPanelToApi } from '../../store/layout-store'
import { TerminalSidebarPanel } from '../panels/TerminalSidebarPanel'
import { HelpPanel } from '../panels/HelpPanel'
import { BrowserPanel } from '../panels/BrowserPanel'
import { ErrorLogPanel } from '../panels/ErrorLogPanel'
import { FileViewerPanel } from '../panels/FileViewerPanel'
import { DirectoryViewerPanel } from '../panels/DirectoryViewerPanel'
import { SessionChangesPanel } from '../panels/SessionChangesPanel'
import { SessionSearchPanel } from '../panels/SessionSearchPanel'
import { SessionsSearchPanel } from '../panels/SessionsSearchPanel'
import { IdeasPanel } from '../panels/IdeasPanel'
import { RemoteConnectionsPanel } from '../panels/RemoteConnectionsPanel'
import { RemoteViewerPanel } from '../panels/RemoteViewerPanel'
import { RemoteNotesPanel } from '../panels/RemoteNotesPanel'
import { RemoteActivityLogPanel } from '../panels/RemoteActivityLogPanel'
import { SettingsPanel } from '../panels/SettingsPanel'
import { UsageStatsPanel } from '../panels/UsageStatsPanel'
import { AbilitiesPanel } from '../panels/AbilitiesPanel'
import { CustomTab } from './CustomTab'
import { getWindowId, isNewWindow, getInitialFile } from '../../utils/window-params'
import { fileViewerPanelId } from '../../utils/terminal-helpers'
import { LayoutMigration } from '../../utils/layoutMigration'

const components = {
  terminalPanel: TerminalSidebarPanel,
  helpPanel: HelpPanel,
  browserPanel: BrowserPanel,
  errorLogPanel: ErrorLogPanel,
  fileViewerPanel: FileViewerPanel,
  directoryViewerPanel: DirectoryViewerPanel,
  sessionChangesPanel: SessionChangesPanel,
  settingsPanel: SettingsPanel,
  usageStatsPanel: UsageStatsPanel,
  abilitiesPanel: AbilitiesPanel,
  sessionSearchPanel: SessionSearchPanel,
  sessionsSearchPanel: SessionsSearchPanel,
  ideasPanel: IdeasPanel,
  remoteConnectionsPanel: RemoteConnectionsPanel,
  // Opened only from RemoteConnectionsPanel (needs {peer, terminalId}); deliberately
  // NOT in TAB_TYPES, so it can't be opened from the tab picker.
  remoteViewerPanel: RemoteViewerPanel,
  // Peer-backed standalone notes view; opened only from RemoteConnectionsPanel ({peer, projectDir}).
  remoteNotesPanel: RemoteNotesPanel,
  // Auto-opened (inactive) on any remote-control activity; NOT in TAB_TYPES.
  remoteActivityLogPanel: RemoteActivityLogPanel,
}


const headerBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#888',
  cursor: 'pointer',
  fontSize: 14,
  padding: '0 6px',
  lineHeight: '24px'
}

function EmptyWatermark({ containerApi }: IWatermarkPanelProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: '#666',
      gap: 16
    }}>
      <div style={{ fontSize: 16 }}>No panels open</div>
      <button
        style={{
          background: '#0e639c',
          color: 'white',
          border: 'none',
          borderRadius: 4,
          padding: '8px 20px',
          cursor: 'pointer',
          fontSize: 14
        }}
        onClick={() => addPanelToApi(containerApi)}
      >
        + Add Panel
      </button>
      <div style={{ fontSize: 12, color: '#555' }}>or press Ctrl+T</div>
    </div>
  )
}

function RightHeaderActions({ containerApi, group }: IDockviewHeaderActionsProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <button
        style={{ ...headerBtnStyle, fontSize: 18 }}
        title="Add tab (Ctrl+T)"
        onMouseEnter={(e) => (e.currentTarget.style.color = '#ccc')}
        onMouseLeave={(e) => (e.currentTarget.style.color = '#888')}
        onClick={() => addPanelToApi(containerApi, group)}
      >
        +
      </button>
    </div>
  )
}

function createDefaultLayout(api: DockviewApi) {
  api.addPanel({
    id: 'terminal-default',
    component: 'terminalPanel',
    title: 'Terminal 1',
    params: {}
  })
}

export function DockLayout() {
  const { setDockviewApi, setPanelCount, setActivePanel } = useLayoutStore()
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Crash-safety latch: if restoring this window's saved layout THREW (corrupt/incompatible JSON),
  // we must NOT let the fallback default layout get persisted over the good saved layout — that was
  // the 2026-06-11 data-loss bug. While set, every save is suppressed, so this window's
  // `layouts[windowId]` section in app-state.json keeps its good content (recoverable; other windows
  // still save normally). Cleared only by a clean restore.
  const restoreFailed = useRef(false)
  const windowId = getWindowId()

  const saveLayoutNow = useCallback((api: DockviewApi) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current)
    saveTimeout.current = null
    if (restoreFailed.current) return // never overwrite a layout we failed to restore
    try {
      const json = JSON.stringify(api.toJSON())
      window.electronAPI.saveLayout(windowId, json)
    } catch {}
  }, [windowId])

  const saveLayout = useCallback((api: DockviewApi) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current)
    saveTimeout.current = setTimeout(() => saveLayoutNow(api), 500)
  }, [saveLayoutNow])

  const onReady = useCallback(async (event: DockviewReadyEvent) => {
    const api = event.api
    setDockviewApi(api)

    let saved: string | null = null
    try {
      saved = await window.electronAPI.loadLayout(windowId)
    } catch { /* ignore load errors */ }

    if (saved) {
      try {
        const layout = JSON.parse(saved)
        const migrated = LayoutMigration.migrateUsageStatsPanel(layout)
        api.fromJSON(layout)
        // Transient panels that shouldn't survive a restart: the Error Log
        // (its errorLog array is in-memory, so it'd restore empty) and remote
        // viewers (their {peer, terminalId} is from a dead session, so the
        // stream would just fail). Strip them and persist the cleanup.
        const stale = api.panels.filter((p) => p.id === 'error-log' || p.id === 'remote-activity-log' || p.id.startsWith('remote-view:'))
        for (const p of stale) api.removePanel(p)
        if (stale.length || migrated) saveLayoutNow(api)
      } catch (e) {
        // Restore failed → keep the saved layout intact (do NOT persist the fallback over it) so it
        // stays recoverable. The window still gets a usable default; saves stay suppressed this session.
        restoreFailed.current = true
        console.error('[layout] restore failed — preserving saved layout for recovery, not overwriting:', e)
        if (!isNewWindow()) createDefaultLayout(api)
      }
    } else if (getInitialFile()) {
      // A window opened to view a specific file (e.g. "Open in new window" on an instruction).
      const f = getInitialFile() as string
      api.addPanel({ id: fileViewerPanelId(undefined, f), component: 'fileViewerPanel', title: f.replace(/^.*[/\\]/, ''), params: { filePath: f } })
    } else if (!isNewWindow()) {
      createDefaultLayout(api)
    }

    setPanelCount(api.panels.length)
    setActivePanel(api.activePanel?.id ?? null)

    const beforeUnload = () => saveLayoutNow(api)
    window.addEventListener('beforeunload', beforeUnload)

    const d1 = api.onDidAddPanel(() => setPanelCount(api.panels.length))
    const d2 = api.onDidRemovePanel(() => {
      setPanelCount(api.panels.length)
      saveLayoutNow(api)
    })
    const d3 = api.onDidActivePanelChange((e) => setActivePanel(e?.id ?? null))
    const d4 = api.onDidLayoutChange(() => saveLayout(api))
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      d1.dispose(); d2.dispose(); d3.dispose(); d4.dispose()
    }
  }, [windowId, setDockviewApi, setPanelCount, setActivePanel, saveLayout, saveLayoutNow])

  return (
    <DockviewReact
      className="dockview-theme-dark"
      components={components}
      defaultTabComponent={CustomTab}
      watermarkComponent={EmptyWatermark}
      rightHeaderActionsComponent={RightHeaderActions}
      defaultRenderer="always"
      onReady={onReady}
    />
  )
}
