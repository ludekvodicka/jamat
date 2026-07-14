import { useState, useEffect, useRef, Fragment } from 'react'
import { openDirectoryViewer } from '../../utils/terminal-helpers'
import { useLayoutStore } from '../../store/layout-store'

const PASTEL_COLORS = [
  { name: 'None', value: '' },
  { name: 'Red', value: '#4a2020' },
  { name: 'Orange', value: '#4a3520' },
  { name: 'Yellow', value: '#4a4520' },
  { name: 'Green', value: '#204a20' },
  { name: 'Teal', value: '#204a3a' },
  { name: 'Blue', value: '#202a4a' },
  { name: 'Purple', value: '#35204a' },
  { name: 'Pink', value: '#4a2035' },
  { name: 'Cyan', value: '#204a4a' },
  { name: 'Brown', value: '#3a3020' },
]

interface TabContextMenuProps {
  x: number
  y: number
  panelId: string
  projectDir: string
  /** Set for terminal tabs that have a resolved Claude session. */
  sessionId?: string
  currentColor: string
  onSelectColor: (color: string) => void
  onDetach: () => void
  onRenameSession?: () => void
  /** Set for agent tabs with a known project dir — opens a fresh, empty session in the same folder. */
  onNewSession?: () => void
  /** Set only when BOTH agents are installed — opens a fresh session in the same folder with the
   *  OTHER agent (Claude tab → Codex, and vice versa). Needs `newSessionOtherAgentLabel` to render. */
  onNewSessionOtherAgent?: () => void
  /** The other agent's display name (e.g. "Codex") for the cross-agent item's label. */
  newSessionOtherAgentLabel?: string
  /** Set only for Claude tabs with a known session — forks it into a new tab. */
  onForkSession?: () => void
  /** Set only for Claude tabs with a known session — closes & reopens the SAME session in a fresh process (reloads skills/CLAUDE.md/MCP). */
  onRestartSession?: () => void
  /** Set only for Claude tabs — types /compact into the session and runs it. */
  onCompactSession?: () => void
  /** Copy this tab's stable instance id so a second LLM can address it. Agent tabs only. */
  onCopyInstanceId?: () => void
  /** Show session details (session id, project, launch cmd, …) for this tab. */
  onShowInfo?: () => void
  /** Set only for remote-viewer tabs — closes the tab on the peer too. */
  onCloseRemote?: () => void
  onClose: () => void
}

export function TabContextMenu({ x, y, panelId, projectDir, sessionId, currentColor, onSelectColor, onDetach, onRenameSession, onNewSession, onNewSessionOtherAgent, newSessionOtherAgentLabel, onForkSession, onRestartSession, onCompactSession, onCopyInstanceId, onShowInfo, onCloseRemote, onClose }: TabContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [showColors, setShowColors] = useState(false)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Items are bucketed into logical groups; a separator is drawn between every two
  // non-empty groups (groups that collapse to nothing on a given tab draw no separator).
  //   0. Compact  — quick "/compact" action, its own section at the top
  //   1. Session  — rename / new / fork (the session-lifecycle actions)
  //   2. Tab      — detach, appearance
  //   3. Info     — copy folder, session info
  //   4. Remote   — destructive peer action, kept apart and last

  const compactGroup = [
    onCompactSession && (
      <div
        key="compact-session"
        className="tab-context-item"
        title="Type /compact into this session and run it — frees context by summarizing the conversation so far"
        onClick={() => { onCompactSession(); onClose() }}
      >
        Compact session
      </div>
    ),
  ].filter(Boolean)

  const sessionGroup = [
    projectDir && onRenameSession && (
      <div
        key="rename"
        className="tab-context-item"
        title="Rename this session — also bound to F2"
        onClick={() => { onRenameSession(); onClose() }}
      >
        Rename session…
        <span className="tab-context-shortcut">F2</span>
      </div>
    ),
    onNewSession && (
      <div
        key="new-session"
        className="tab-context-item"
        title="Open a fresh, empty session in the same folder — no history, the current session stays untouched"
        onClick={() => { onNewSession(); onClose() }}
      >
        New blank session
      </div>
    ),
    onNewSessionOtherAgent && newSessionOtherAgentLabel && (
      <div
        key="new-session-other"
        className="tab-context-item"
        title={`Open a fresh session in the same folder using ${newSessionOtherAgentLabel} instead — run the other agent side by side`}
        onClick={() => { onNewSessionOtherAgent(); onClose() }}
      >
        New session in {newSessionOtherAgentLabel}
      </div>
    ),
    onForkSession && (
      <div
        key="fork-session"
        className="tab-context-item"
        title="Open a fork of this session in a new tab — keeps the full history under a new session id, the original stays untouched"
        onClick={() => { onForkSession(); onClose() }}
      >
        Fork session ⎇
      </div>
    ),
    onRestartSession && (
      <div
        key="restart-session"
        className="tab-context-item"
        title="Restart this session — close it and reopen the SAME session id in a fresh process (reloads skills, CLAUDE.md and MCP; full history kept)"
        onClick={() => { onRestartSession(); onClose() }}
      >
        Restart session ⟳
      </div>
    ),
  ].filter(Boolean)

  const tabGroup = [
    <div
      key="detach"
      className="tab-context-item"
      onClick={() => { onDetach(); onClose() }}
    >
      Detach to new window
    </div>,
    <div
      key="appearance"
      className="tab-context-item"
      onMouseEnter={() => setShowColors(true)}
    >
      Appearance ›
      {showColors && (
        <div className="tab-context-submenu">
          {PASTEL_COLORS.map((c) => (
            <div
              key={c.name}
              className={`tab-context-item ${currentColor === c.value ? 'active' : ''}`}
              onClick={() => { onSelectColor(c.value); onClose() }}
            >
              {c.value ? (
                <span className="color-swatch" style={{ background: c.value }} />
              ) : (
                <span className="color-swatch none" />
              )}
              {c.name}
            </div>
          ))}
        </div>
      )}
    </div>,
  ].filter(Boolean)

  const infoGroup = [
    projectDir && (
      <div
        key="open-folder"
        className="tab-context-item"
        title="Browse this project's folder in a directory viewer tab"
        onClick={() => {
          const api = useLayoutStore.getState().dockviewApi
          if (api) openDirectoryViewer(api, projectDir, projectDir)
          onClose()
        }}
      >
        Open project folder
      </div>
    ),
    projectDir && (
      <div
        key="copy-folder"
        className="tab-context-item"
        onClick={() => { navigator.clipboard.writeText(projectDir); onClose() }}
      >
        Copy project folder
      </div>
    ),
    onCopyInstanceId && (
      <div
        key="copy-instance-id"
        className="tab-context-item"
        title="Copy this tab's stable instance id — paste it to another LLM so it can ask THIS session via `jamat ask <id>`"
        onClick={() => { onCopyInstanceId(); onClose() }}
      >
        Copy instance id
      </div>
    ),
    onShowInfo && (
      <div
        key="info"
        className="tab-context-item"
        title="Show this tab's session details — session id, project, launch command"
        onClick={() => { onShowInfo(); onClose() }}
      >
        Info…
      </div>
    ),
  ].filter(Boolean)

  const remoteGroup = [
    onCloseRemote && (
      <div
        key="close-remote"
        className="tab-context-item"
        style={{ color: '#e0707a' }}
        onClick={() => { onCloseRemote(); onClose() }}
      >
        Close tab on remote
      </div>
    ),
  ].filter(Boolean)

  const groups = [compactGroup, sessionGroup, tabGroup, infoGroup, remoteGroup].filter(g => g.length > 0)

  return (
    <div ref={ref} className="tab-context-menu" style={{ left: x, top: y }}>
      {groups.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <div className="tab-context-separator" />}
          {group}
        </Fragment>
      ))}
    </div>
  )
}
