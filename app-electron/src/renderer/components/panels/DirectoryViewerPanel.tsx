import { IDockviewPanelProps } from 'dockview'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLayoutStore } from '../../store/layout-store'
import { fileViewerPanelId, parentDir, pathCrumbs } from '../../utils/terminal-helpers'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import type { DirEntry } from '../../../../../core/types/ipc-contracts'

interface DirectoryViewerParams {
  /** Folder to list. The panel can navigate into subfolders without spawning new tabs. */
  dirPath: string
  /** Project root, forwarded to the FileViewer tabs opened from here (unlocks session diffs). */
  projectDir?: string
}

// How often we re-list the current folder. The whole point of this panel is watching an agent drop
// files into a folder, so a slow poll keeps it live without the shared-fs-watcher teardown footguns.
const POLL_MS = 4000

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

export function DirectoryViewerPanel({ params }: IDockviewPanelProps<DirectoryViewerParams>) {
  const root = params.dirPath
  const [currentDir, setCurrentDir] = useState(root)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null)

  // Re-root when the panel is re-activated for a different folder (openOrActivatePanel pushes params).
  useEffect(() => { setCurrentDir(params.dirPath) }, [params.dirPath])

  const query = useIpcQuery<DirEntry[]>(
    () => currentDir ? window.electronAPI!.listDir(currentDir) : undefined,
    [currentDir],
  )
  const entries = query.data ?? []
  const loading = query.loading && query.data === null
  const { refetch } = query

  useEffect(() => {
    const t = setInterval(() => { refetch() }, POLL_MS)
    return () => clearInterval(t)
  }, [refetch])

  // Close the row context menu on outside click / Escape / scroll.
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

  const openFileTab = (filePath: string) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) return
    const id = fileViewerPanelId(params.projectDir, filePath)
    const existing = api.panels.find(p => p.id === id)
    if (existing) { existing.api.setActive(); return }
    api.addPanel({
      id,
      component: 'fileViewerPanel',
      title: filePath.replace(/^.*[/\\]/, ''),
      // Land directly on the rendered/formatted view (not a diff) — the user is browsing a folder.
      params: { filePath, projectDir: params.projectDir, initialDiffMode: { kind: 'off' } },
    })
  }

  const onRowClick = (entry: DirEntry) => {
    if (entry.type === 'dir') setCurrentDir(entry.path)
    else openFileTab(entry.path)
  }

  // Full absolute path as clickable crumbs (drive root → each ancestor → current). Lets you jump up
  // many levels at once; the `..` row below steps up one level (incl. above the originally opened folder).
  const crumbs = useMemo(() => pathCrumbs(currentDir), [currentDir])
  const parent = parentDir(currentDir)

  // Keep the deepest crumb (current folder) visible when the path overflows the header width.
  const crumbsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = crumbsRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [currentDir])

  return (
    <div className="dir-viewer">
      <div className="dir-viewer-header">
        <div className="dir-viewer-crumbs" title={currentDir} ref={crumbsRef}>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={c.dir} style={{ display: 'contents' }}>
                {i > 0 && <span className="dir-viewer-crumb-sep">/</span>}
                <span
                  className={`dir-viewer-crumb${last ? ' current' : ''}`}
                  onClick={last ? undefined : () => setCurrentDir(c.dir)}
                >
                  {c.label}
                </span>
              </span>
            )
          })}
        </div>
        <button className="notes-btn" onClick={() => refetch()} title="Refresh">↻</button>
      </div>

      <div className="dir-viewer-list">
        {parent && (
          <div
            className="dir-viewer-item dir-viewer-up"
            onClick={() => setCurrentDir(parent)}
            title={parent}
          >
            <span className="dir-viewer-icon">📁</span>
            <span className="dir-viewer-name">..</span>
            <span className="dir-viewer-meta">up</span>
          </div>
        )}
        {loading ? (
          <div className="dir-viewer-loading">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="dir-viewer-empty">Empty folder</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              className="dir-viewer-item"
              onClick={() => onRowClick(entry)}
              onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, entry }) }}
              title={entry.path}
            >
              <span className="dir-viewer-icon">{entry.type === 'dir' ? '📁' : '📄'}</span>
              <span className="dir-viewer-name">{entry.name}</span>
              <span className="dir-viewer-meta">
                {entry.type === 'file' ? `${formatSize(entry.size)} · ` : ''}{timeAgo(entry.mtime)}
              </span>
            </div>
          ))
        )}
      </div>

      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="tab-context-item" onClick={() => { onRowClick(contextMenu.entry); setContextMenu(null) }}>
            {contextMenu.entry.type === 'dir' ? 'Open folder' : 'Open file'}
          </div>
          <div className="tab-context-item" onClick={() => { void window.electronAPI?.openInVSCode?.(contextMenu.entry.path); setContextMenu(null) }}>
            Open in VS Code
          </div>
          <div className="tab-context-item" onClick={() => { void window.electronAPI?.writeClipboard?.(contextMenu.entry.path); setContextMenu(null) }}>
            Copy path
          </div>
        </div>
      )}
    </div>
  )
}
