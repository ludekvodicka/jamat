import { useEffect, useMemo, useState } from 'react'
import { useLayoutStore } from '../../store/layout-store'
import { loadSettings } from './SettingsPanel'
import { openFileChangesPanel, fileViewerPanelId, openPeerFile } from '../../utils/terminal-helpers'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import { makeDataSource } from '../../datasource/panelDataSource'
import type { DiffMode } from '../../../../../core/types/file-diff'
import type { RemotePeer } from '../../../../../core/types/remote-control'

interface RecentFile {
  path: string
  name: string
  mtime: number
  relative: string
}

function timeAgo(mtime: number): string {
  const secs = Math.floor((Date.now() - mtime) / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function RecentFilesPanel({ projectDir, peer }: { projectDir: string; peer?: RemotePeer }) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const { recentFilesCount, recentFilesIntervalSeconds } = loadSettings()
  // Local IPC by default; a peer routes the listing (+ file opens) through the remote ops.
  const ds = useMemo(() => makeDataSource(peer), [peer?.id])

  const filesQuery = useIpcQuery<RecentFile[]>(
    () => projectDir ? ds.listRecentFiles(projectDir, recentFilesCount) : undefined,
    [projectDir, recentFilesCount, ds],
  )
  const files = filesQuery.data ?? []
  const loading = filesQuery.loading && filesQuery.data === null
  const { refetch } = filesQuery

  useEffect(() => {
    const interval = setInterval(() => { refetch() }, recentFilesIntervalSeconds * 1000)
    return () => clearInterval(interval)
  }, [refetch, recentFilesIntervalSeconds])

  // Close context menu on outside click / Escape / scroll.
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  // `preferDiffOnOpen` asks the FileViewer for the backend's smart-default diff baseline on open
  // (this panel is about recently *changed* files, so a plain click means "show me the changes").
  // The viewer's global default is otherwise formatted/non-diff.
  const openFile = (filePath: string, initialDiffMode?: DiffMode, preferDiffOnOpen = false) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) return
    // A peer file opens in the read-only peer FileViewer (path-scoped server-side), never locally.
    if (peer) { openPeerFile(api, peer, filePath, projectDir); return }
    const id = fileViewerPanelId(projectDir, filePath)
    const params: Record<string, unknown> = { filePath, projectDir }
    if (initialDiffMode) params.initialDiffMode = initialDiffMode
    if (preferDiffOnOpen) params.preferDiffOnOpen = true
    const existing = api.panels.find(p => p.id === id)
    if (existing) {
      existing.api.updateParameters(params)
      existing.api.setActive()
      return
    }
    api.addPanel({
      id,
      component: 'fileViewerPanel',
      title: filePath.replace(/^.*[/\\]/, ''),
      params,
    })
  }

  const openInFileChanges = (filePath: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) return
    openFileChangesPanel(api, projectDir, { filterFilePath: filePath })
  }

  const dirName = projectDir.replace(/^.*[/\\]/, '')

  if (loading) return <div className="recent-files-loading">Loading...</div>
  if (files.length === 0) return <div className="recent-files-loading">No files in {dirName}</div>

  return (
    <div className="recent-files">
      <div className="recent-files-header">
        <span>Recent Files</span>
        <button className="notes-btn" onClick={() => refetch()} title="Refresh">↻</button>
      </div>
      <div className="recent-files-list">
        {files.map((f) => {
          const age = Date.now() - f.mtime
          const bg = age < 60_000 ? 'rgba(78, 201, 78, 0.22)'
            : age < 120_000 ? 'rgba(78, 201, 78, 0.14)'
            : age < 300_000 ? 'rgba(78, 201, 78, 0.07)'
            : undefined
          return (
            <div
              key={f.path}
              className="recent-file-item"
              onClick={() => openFile(f.path, undefined, true)}
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu({ x: e.clientX, y: e.clientY, path: f.path })
              }}
              title={f.path}
              style={bg ? { background: bg } : undefined}
            >
              <span className="recent-file-name">{f.relative}</span>
              <span className="recent-file-time">{timeAgo(f.mtime)}</span>
            </div>
          )
        })}
      </div>
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="tab-context-item"
            onClick={() => {
              openFile(contextMenu.path, { kind: 'off' })
              setContextMenu(null)
            }}
          >
            Open file
          </div>
          <div
            className="tab-context-item"
            onClick={() => {
              openFile(contextMenu.path, undefined, true)
              setContextMenu(null)
            }}
          >
            Show changes
          </div>
          {/* Local-only actions — a peer's file changes/VS Code live on the remote machine. */}
          {!peer && (
            <div
              className="tab-context-item"
              onClick={() => {
                openInFileChanges(contextMenu.path)
                setContextMenu(null)
              }}
            >
              Show changes in prompts
            </div>
          )}
          {!peer && (
            <div
              className="tab-context-item"
              onClick={() => {
                void window.electronAPI?.openInVSCode?.(contextMenu.path)
                setContextMenu(null)
              }}
            >
              Open in VS Code
            </div>
          )}
          <div
            className="tab-context-item"
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.path)
              setContextMenu(null)
            }}
          >
            Copy file path
          </div>
        </div>
      )}
    </div>
  )
}
