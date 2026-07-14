import { IDockviewPanelHeaderProps } from 'dockview'
import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { TabContextMenu } from './TabContextMenu'
import { getRendererAgent } from '../../../../../core/agents/renderer'
import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '../../../../../core/types/contracts'
import { formatInstanceId } from '../../../../../core/instance-id'
import type { RemotePeer } from '../../../../../core/types/remote-control'
import { closePanelActivatingNeighbor } from '../../utils/terminal-helpers'
import { contextLevel } from '../../utils/context-level'
import { useLayoutStore } from '../../store/layout-store'

const TAB_COLORS_KEY = 'tab-colors'

function loadTabColors(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TAB_COLORS_KEY) ?? '{}')
  } catch { return {} }
}

function saveTabColor(projectDir: string, color: string) {
  const colors = loadTabColors()
  if (color) {
    colors[projectDir] = color
  } else {
    delete colors[projectDir]
  }
  localStorage.setItem(TAB_COLORS_KEY, JSON.stringify(colors))
}

function getColorKey(params: any): string {
  return params?.projectDir ?? params?.folderName ?? ''
}

// Tab titles render as "folderName - <name>" (main process composes them).
// The rename modal edits the bare <name>, so peel/re-apply that prefix here so
// the input shows just the name and the optimistic setTitle matches what the
// main-process title poller will send.
function folderPrefix(params: any): string {
  const folderName = (params?.folderName as string | undefined) ?? ''
  return folderName ? `${folderName} - ` : ''
}

export function CustomTab({ api, containerApi, params }: IDockviewPanelHeaderProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Turn status drives the dot color. Read LEVEL-triggered from the store (written by useTerminal's
  // classifier) — NOT from the one-shot `terminal-status` event, which fires only on change: a tab
  // header that mounts/remounts after the status settled (window resize, or a long steady running/
  // thinking turn) would miss it and stick on grey/idle. The store always holds the current value.
  const status = useLayoutStore(s => s.terminalStatus[api.id] ?? 'idle')
  // "Finished off-screen, not yet seen" — tracked centrally by useCompletedTabs; shows a green
  // ✓ badge while the tab is idle so a just-completed background run stands out from plain grey.
  const completed = useLayoutStore(s => !!s.completedTabs[api.id])
  // "Turn done, but a background shell is still running" — orthogonal to `status` (see the store).
  // On an idle tab this shows a muted, slow-pulsing dot so a finished turn that left a shell alive
  // (or hung) stands out from both a plain idle tab and a just-completed ✓ one.
  const bgShell = useLayoutStore(s => !!s.bgShellTabs[api.id])
  const contextLevels = useLayoutStore(s => s.appConfig?.contextLevels)
  // Inline rename prompt — Electron 35+ silently returns the default value
  // from `window.prompt`, so we render our own modal instead.
  const [renamePrompt, setRenamePrompt] = useState<{ defaultName: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [ctxPct, setCtxPct] = useState<number | null>(null)

  const colorKey = getColorKey(params)
  const savedColors = loadTabColors()
  const tabColor = colorKey ? (savedColors[colorKey] ?? '') : ''
  const [color, setColor] = useState(tabColor)
  // Jamat-opened tabs use `ai-claude-…`/`ai-codex-…` ids. Mark them so a human can see at a
  // glance this is the AI's tab and that it's ephemeral (the bridge auto-closes it when done).
  const isAi = api.id.startsWith('ai-')
  // Session-lifecycle actions (rename / compact / fork / …) only make sense on an actual agent
  // terminal tab. File-viewer / directory-viewer / other panels carry no `agent` param, so they
  // must not offer them (compact especially, since forkAgentId defaults to 'claude' when absent).
  const isAgentTab = isAgentId(params?.agent)

  // Per-tab Claude context-usage %: read the session transcript tail (cheap) and surface a small
  // indicator on the tab. Poll fast until a value lands, then slowly (context grows a turn at a time).
  useEffect(() => {
    const agentRaw = params?.agent
    const agentId = isAgentId(agentRaw) ? agentRaw : DEFAULT_AGENT_ID
    const dir = (params?.projectDir ?? params?.cwd) as string | undefined
    const getSessionModel = window.electronAPI?.getSessionModel
    if (agentId !== 'claude' || !dir || !getSessionModel) { setCtxPct(null); return }
    const sessionId = params?.sessionId as string | undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      let pct: number | null = null
      try {
        const info = await getSessionModel(dir, sessionId)
        if (info && info.contextWindow > 0) pct = Math.round((info.contextTokens / info.contextWindow) * 100)
      } catch { pct = null }
      if (cancelled) return
      setCtxPct(pct)
      // Re-broadcast so the in-terminal ContextWarningOverlay rides this poll (no extra transcript read).
      window.dispatchEvent(new CustomEvent('context-pct', { detail: { id: api.id, pct } }))
      timer = setTimeout(tick, pct === null ? 8_000 : 20_000)
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [params?.agent, params?.projectDir, params?.cwd, params?.sessionId])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleSelectColor = useCallback((newColor: string) => {
    setColor(newColor)
    if (colorKey) saveTabColor(colorKey, newColor)
  }, [colorKey])

  const handleDetach = useCallback(() => {
    const panel = containerApi.getPanel(api.id)
    if (!panel) return
    const panelParams = { ...(panel.params ?? {}) }
    const panelTitle = panel.title ?? 'Terminal'
    containerApi.removePanel(panel)
    window.electronAPI?.detachTab({ title: panelTitle, params: panelParams })
  }, [api.id, containerApi])

  const handleRenameSession = useCallback(() => {
    const projectDir = (params?.projectDir as string | undefined) ?? (params?.cwd as string | undefined) ?? ''
    if (!projectDir || !window.electronAPI?.renameSession) return
    const prefix = folderPrefix(params)
    const full = (api.title ?? '').trim()
    const current = prefix && full.startsWith(prefix) ? full.slice(prefix.length).trim() : full
    setRenameValue(current)
    setRenameError(null)
    setRenamePrompt({ defaultName: current })
    setTimeout(() => {
      const el = renameInputRef.current
      if (el) { el.focus(); el.select() }
    }, 50)
  }, [api.title, params])

  const submitRename = useCallback(async () => {
    if (!renamePrompt) return
    const projectDir = (params?.projectDir as string | undefined) ?? (params?.cwd as string | undefined) ?? ''
    const sessionId = params?.sessionId as string | undefined
    if (!window.electronAPI?.renameSession) {
      setRenameError('renameSession API not available — preload outdated?')
      return
    }
    if (!projectDir) {
      const keys = Object.keys(params ?? {}).join(', ') || '<empty>'
      setRenameError(`projectDir missing from tab params (keys: ${keys})`)
      return
    }
    const name = renameValue.trim()
    if (!name) {
      setRenameError('Name is empty')
      return
    }
    if (name === renamePrompt.defaultName) {
      // No-op — just close.
      setRenamePrompt(null)
      return
    }
    // The agent's own rename command. Piping it updates the live TUI and lets the agent synchronize
    // its own metadata; the backend write below gives a known session an immediate durable name.
    // No-op when the terminal is gone or the agent is mid-response (the byte just buffers in stdin).
    const rawAgent = params?.agent
    const agentId = isAgentId(rawAgent) ? rawAgent : DEFAULT_AGENT_ID
    let slash: string | null = null
    try { slash = getRendererAgent(agentId).renameSlashCommand(name) } catch { slash = null }
    const pipeRenameSlash = () => {
      if (!slash) return
      try { window.electronAPI?.writeTerminal?.(api.id, slash) } catch { /* fire-and-forget */ }
    }
    // Match the main-process format ("folderName - name") so the optimistic title doesn't briefly
    // differ from what the title poller re-sends.
    const applyOptimisticTitle = () => api.setTitle(`${folderPrefix(params)}${name}`)

    if (sessionId) {
      // Resolved session: persist to the adapter's exact title store, then sync the live TUI.
      const result = await window.electronAPI.renameSession(projectDir, sessionId, name)
      if (result?.ok) { applyOptimisticTitle(); pipeRenameSlash(); setRenamePrompt(null) }
      else setRenameError(result?.error ?? 'Rename failed')
    } else if (slash) {
      // Brand-new session: its transcript doesn't exist yet, so the backend can't write it — and its
      // empty-id fallback (resolveActiveSessionFile = "most recent") could target a PREVIOUS session.
      // Name it through the live agent's own /rename instead: unambiguously THIS tab's session, same
      // record. This is what makes F2 work the instant a session is created (no transcript needed).
      pipeRenameSlash(); applyOptimisticTitle(); setRenamePrompt(null)
    } else {
      // No id yet and no rename command: let the backend's resolver try so its real
      // error surfaces rather than a silent no-op.
      const result = await window.electronAPI.renameSession(projectDir, '', name)
      if (result?.ok) { applyOptimisticTitle(); setRenamePrompt(null) }
      else setRenameError(result?.error ?? 'Rename failed')
    }
  }, [renamePrompt, renameValue, api, params])

  const cancelRename = useCallback(() => {
    setRenamePrompt(null)
    setRenameError(null)
  }, [])

  // F2 (global shortcut) opens THIS tab's rename modal when it's the active tab. The shortcut
  // handler broadcasts the active panel id; only the matching agent tab reacts. Same gate as the
  // context-menu "Rename session…" item (agent tabs only).
  useEffect(() => {
    const handler = (e: Event) => {
      if (isAgentTab && (e as CustomEvent).detail === api.id) handleRenameSession()
    }
    window.addEventListener('rename-session', handler)
    return () => window.removeEventListener('rename-session', handler)
  }, [api.id, isAgentTab, handleRenameSession])

  // Fork: open a fork branch of THIS tab's session in a new tab — history preserved
  // under a fresh session id, the original session untouched. Offered per the agent's
  // `capabilities.fork` (Claude `--fork-session`, Codex `codex fork <id>`) and only once
  // the sessionId is known (a fresh continue/new tab before id resolution has none yet →
  // no fork item until it resolves).
  const forkAgentId = isAgentId(params?.agent) ? params.agent : DEFAULT_AGENT_ID
  const forkSessionId = params?.sessionId as string | undefined
  const forkProjectDir = (params?.projectDir as string | undefined) ?? (params?.cwd as string | undefined) ?? ''
  const agentCanFork = (() => { try { return getRendererAgent(forkAgentId).capabilities.fork } catch { return false } })()
  const canFork = agentCanFork && !!forkSessionId && !!forkProjectDir
  const handleForkSession = useCallback(() => {
    if (!forkSessionId || !forkProjectDir || !window.electronAPI?.openSessionInTab) return
    void window.electronAPI.openSessionInTab(forkProjectDir, forkSessionId, true)
  }, [forkSessionId, forkProjectDir])

  // Restart: reopen the SAME session id in a fresh process (history kept, but skills/CLAUDE.md/MCP
  // are re-read on boot — the whole point), then close THIS tab so its old process exits and releases
  // the session. openSessionInTab → main → onOpenTab adds the new panel a tick later (IPC round-trip),
  // while removePanel is synchronous — so the old PTY dies first and the resume mounts right after, a
  // clean handoff. Same gate as fork (Claude tab with a known session id).
  const [restartConfirm, setRestartConfirm] = useState(false)
  const doRestartSession = useCallback(() => {
    if (!forkSessionId || !forkProjectDir || !window.electronAPI?.openSessionInTab) return
    const panel = containerApi.getPanel(api.id)
    void window.electronAPI.openSessionInTab(forkProjectDir, forkSessionId, false)
    if (panel) closePanelActivatingNeighbor(containerApi, panel)
  }, [forkSessionId, forkProjectDir, api.id, containerApi])
  const handleRestartSession = useCallback(() => {
    // Restarting kills the running process. If the session is mid-response, confirm first so an
    // in-flight answer isn't dropped silently; an idle session restarts immediately.
    if (status === 'running' || status === 'tool-use') setRestartConfirm(true)
    else doRestartSession()
  }, [status, doRestartSession])

  // Compact: type "/compact" into this tab's session and run it (the \r submits). Local tab →
  // write to its PTY; remote-viewer tab (params carry peer + terminalId) → inject into the PEER's
  // terminal over the bridge (control:write-keys). Same action as the status-bar model-item menu.
  const handleCompactSession = useCallback(() => {
    const peer = params?.peer as RemotePeer | undefined
    const tid = params?.terminalId as string | undefined
    if (peer && tid) {
      void window.electronAPI?.remoteOp?.(peer, 'control:write-keys', [{ terminalId: tid, data: '/compact\r' }])
    } else {
      window.electronAPI?.writeTerminal?.(api.id, '/compact\r')
    }
  }, [api.id, params])

  // New blank session: open a fresh, empty session in THIS tab's directory — no resume,
  // no history. Mirrors the restoreMeta 'cc' launch the menu/sidebar use for a brand-new
  // session (executor rewrites the persisted cmd to 'resume'+id once the new id resolves,
  // so a restart reopens THIS session). Offered for agent tabs with a known project dir.
  const canNewSession = isAgentId(params?.agent) && !!forkProjectDir
  // Open a fresh, empty 'cc' session in THIS tab's folder with the given agent. Shared by "New blank
  // session" (same agent) and "New session in <other agent>" (the cross-agent quick-launch below).
  const openNewSessionWith = useCallback((agentId: AgentId) => {
    if (!forkProjectDir) return
    const agentLabel = agentId === 'codex' ? 'Codex' : 'Claude'
    const folderName = (params?.folderName as string | undefined) ?? forkProjectDir.replace(/.*[/\\]/, '')
    const id = `screen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    containerApi.addPanel({
      id,
      component: 'terminalPanel',
      title: `${folderName} - ${agentLabel}`,
      params: { projectDir: forkProjectDir, cmd: 'cc', folderName, agent: agentId },
    })
    try { containerApi.getPanel(id)?.api.setActive() } catch { /* ignore */ }
  }, [forkProjectDir, params?.folderName, containerApi])
  const handleNewSession = useCallback(() => openNewSessionWith(forkAgentId), [openNewSessionWith, forkAgentId])

  // Cross-agent quick-launch: a fresh session in the SAME folder with the OTHER agent — so you can run
  // Claude↔Codex side by side in one folder. Offered only when BOTH agents are installed (on PATH,
  // from the store's `agentsMeta`); the current tab's agent is obviously usable, so this effectively
  // gates on the other agent being available, but we check both to be explicit ("má oba").
  const agentsMeta = useLayoutStore(s => s.agentsMeta)
  const otherAgentId: AgentId = forkAgentId === 'claude' ? 'codex' : 'claude'
  const otherAgentLabel = otherAgentId === 'codex' ? 'Codex' : 'Claude'
  const availableAgentIds = new Set((agentsMeta ?? []).filter(a => a.available).map(a => a.id))
  const canNewSessionOtherAgent = canNewSession && availableAgentIds.has('claude') && availableAgentIds.has('codex')
  const handleNewSessionOtherAgent = useCallback(() => openNewSessionWith(otherAgentId), [openNewSessionWith, otherAgentId])

  // Copy instance id: a stable, copyable handle for THIS tab (`<machine>:<folder>-<rand>`) so a
  // second LLM can address it via `jamat ask <id> "…"`. Minted lazily on first copy and
  // persisted into the tab params (survives restart via layout persistence); offered for local
  // agent tabs (not remote-viewer tabs, whose instance lives on the peer).
  const canCopyInstanceId = isAgentId(params?.agent) && !!forkProjectDir
  const handleCopyInstanceId = useCallback(async () => {
    const panel = containerApi.getPanel(api.id)
    if (!panel) return
    let id = (panel.params as Record<string, unknown> | undefined)?.instanceId as string | undefined
    if (!id) {
      const machine = (await window.electronAPI?.getSelfName?.()) || 'local'
      const folder = (params?.folderName as string | undefined) ?? forkProjectDir.replace(/.*[/\\]/, '')
      const rand = Math.random().toString(36).slice(2, 6)
      id = formatInstanceId(machine, folder, rand)
      panel.api.updateParameters({ ...(panel.params ?? {}), instanceId: id })
    }
    try { await navigator.clipboard.writeText(id) } catch { /* clipboard denied — ignore */ }
  }, [api.id, containerApi, params?.folderName, forkProjectDir])

  // Info: surface this tab's session details (mainly the session id — so a duplicate /
  // "session not found" after restore is visible at a glance). Reads what the renderer knows:
  // params.sessionId is the resolved id the main process pushed via screen:update-params.
  const [infoOpen, setInfoOpen] = useState(false)
  const handleShowInfo = useCallback(() => setInfoOpen(true), [])
  const infoRows: Array<[string, string]> = [
    ['Session ID', (params?.sessionId as string | undefined) || '— (not resolved yet)'],
    ['Tab id', api.id],
    ['Project', (params?.projectDir as string | undefined) ?? (params?.cwd as string | undefined) ?? '—'],
    ['Folder', (params?.folderName as string | undefined) ?? '—'],
    ['Agent', (isAgentId(params?.agent) ? params.agent : DEFAULT_AGENT_ID)],
    ['Launch', (params?.cmd as string | undefined) ?? '—'],
    ['Context', ctxPct === null ? '—' : `${ctxPct}%`],
  ]

  // Remote-viewer tabs carry {peer, terminalId} in params — only those can close
  // the tab on the peer. On success we also close the local viewer (nothing left
  // to stream); on failure we leave it so the user notices it didn't close.
  const remotePeer = params?.peer as RemotePeer | undefined
  const remoteTerminalId = params?.terminalId as string | undefined
  const isRemoteView = !!(remotePeer && remoteTerminalId)
  const handleCloseRemote = useCallback(async () => {
    if (!remotePeer || !remoteTerminalId) return
    const r = await window.electronAPI?.remoteCloseTab?.(remotePeer, remoteTerminalId)
    if (r?.ok) {
      const panel = containerApi.getPanel(api.id)
      if (panel) containerApi.removePanel(panel)
    }
  }, [remotePeer, remoteTerminalId, api.id, containerApi])

  return (
    <>
      <div
        className={`custom-tab${isAi ? ' custom-tab-ai' : ''}`}
        style={isAi ? undefined : (color ? { background: color } : undefined)}
        title={isAi ? 'AI-managed tab — opened by the Jamat, auto-closed when done' : (params?.projectDir ?? params?.cwd ?? '')}
        onContextMenu={handleContextMenu}
        onMouseDown={(e) => {
          if (e.button === 0) api.setActive()
        }}
      >
        {isAi && <span className="custom-tab-ai-badge" aria-hidden="true">🤖</span>}
        {status === 'waiting'
          ? <span className="status-question-badge" title="Waiting for your answer — needs interaction">?</span>
          : (status === 'idle' && bgShell)
            ? <span className="tab-status-dot status-bgshell" title="Turn finished, but a background shell is still running (may be hung) — Ctrl+T in the terminal to manage it" />
            : (status === 'idle' && completed)
              ? <span className="status-completed-badge" title="Finished while you were away — switch to this tab to clear">✓</span>
              : <span className={`tab-status-dot status-${status}`} />}
        <span className="custom-tab-title">{api.title ?? 'Terminal'}</span>
        {(() => {
          const c = contextLevel(ctxPct, contextLevels)
          return c ? <span className="custom-tab-ctx" style={{ color: c.color, fontWeight: c.fontWeight, fontSize: c.fontSize }} title={`Context ${ctxPct}% used`}>{c.glyph}</span> : null
        })()}
        <button
          className="custom-tab-close"
          onClick={(e) => {
            e.stopPropagation()
            const panel = containerApi.getPanel(api.id)
            if (panel) closePanelActivatingNeighbor(containerApi, panel)
          }}
        >
          ×
        </button>
      </div>
      {menu && createPortal(
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          panelId={api.id}
          projectDir={params?.projectDir ?? params?.cwd ?? ''}
          sessionId={params?.sessionId as string | undefined}
          currentColor={color}
          onSelectColor={handleSelectColor}
          onDetach={handleDetach}
          onRenameSession={isAgentTab ? handleRenameSession : undefined}
          onNewSession={canNewSession && !isRemoteView ? handleNewSession : undefined}
          onNewSessionOtherAgent={canNewSessionOtherAgent && !isRemoteView ? handleNewSessionOtherAgent : undefined}
          newSessionOtherAgentLabel={otherAgentLabel}
          onForkSession={canFork ? handleForkSession : undefined}
          onRestartSession={canFork ? handleRestartSession : undefined}
          onCompactSession={isRemoteView || (isAgentTab && forkAgentId === 'claude') ? handleCompactSession : undefined}
          onCopyInstanceId={canCopyInstanceId && !isRemoteView ? handleCopyInstanceId : undefined}
          onShowInfo={handleShowInfo}
          onCloseRemote={isRemoteView ? handleCloseRemote : undefined}
          onClose={() => setMenu(null)}
        />,
        document.body
      )}
      {restartConfirm && createPortal(
        <div
          className="rename-modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setRestartConfirm(false) }}
        >
          <div className="rename-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="rename-modal-title">Restart session?</div>
            <div style={{ margin: '6px 0 10px', fontSize: 12, color: '#ccc', lineHeight: 1.5 }}>
              This session is still <b>{status === 'tool-use' ? 'using a tool' : 'running'}</b>. Restarting
              kills the current process and drops the in-progress response. The same session id reopens
              with full history, reloading skills, CLAUDE.md and MCP.
            </div>
            <div className="rename-modal-actions">
              <button
                className="notes-btn notes-btn-primary"
                onClick={() => { setRestartConfirm(false); doRestartSession() }}
              >
                Restart anyway
              </button>
              <button className="notes-btn" onClick={() => setRestartConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {infoOpen && createPortal(
        <div
          className="rename-modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setInfoOpen(false) }}
        >
          <div className="rename-modal" onMouseDown={(e) => e.stopPropagation()} style={{ minWidth: 420 }}>
            <div className="rename-modal-title">Session info</div>
            <div style={{ margin: '6px 0 10px' }}>
              {infoRows.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 10, fontSize: 12, padding: '2px 0', alignItems: 'baseline' }}>
                  <span style={{ color: '#888', minWidth: 84, flexShrink: 0 }}>{k}</span>
                  <span style={{ userSelect: 'text', wordBreak: 'break-all', fontFamily: 'monospace', color: '#ddd' }}>{v}</span>
                </div>
              ))}
            </div>
            <div className="rename-modal-actions">
              <button
                className="notes-btn notes-btn-primary"
                onClick={() => navigator.clipboard.writeText((params?.sessionId as string | undefined) ?? '')}
                disabled={!params?.sessionId}
              >
                Copy session id
              </button>
              <button className="notes-btn" onClick={() => setInfoOpen(false)}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {renamePrompt && createPortal(
        <div
          className="rename-modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) cancelRename() }}
        >
          <div className="rename-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="rename-modal-title">Rename session</div>
            <input
              ref={renameInputRef}
              className="rename-modal-input"
              value={renameValue}
              onChange={(e) => { setRenameValue(e.target.value); setRenameError(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submitRename() }
                else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
              }}
              placeholder="Session name…"
              spellCheck={false}
            />
            {renameError && <div className="rename-modal-error">{renameError}</div>}
            <div className="rename-modal-actions">
              <button className="notes-btn notes-btn-primary" onClick={submitRename}>Rename</button>
              <button className="notes-btn" onClick={cancelRename}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
