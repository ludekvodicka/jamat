import { IDockviewPanelHeaderProps } from 'dockview'
import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { TabContextMenu } from './TabContextMenu'
import { getRendererAgent } from '../../../../../core/agents/renderer'
import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '../../../../../core/types/contracts'
import type { SessionModelInfo } from '../../../../../core/types/session'
import { formatInstanceId } from '../../../../../core/instance-id'
import type { RemotePeer } from '../../../../../core/types/remote-control'
import { closePanelActivatingNeighbor } from '../../utils/terminal-helpers'
import { TerminalPromptSubmitter } from '../../utils/terminalPromptSubmitter'
import { contextLevel, contextUsedPercent } from '../../utils/context-level'
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

interface SessionDetailsPrompt {
  defaultName: string
  defaultDescription: string
  sessionId: string | null
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
  const terminalPhase = useLayoutStore(s => s.terminalPhases[api.id])
  const sessionRuntime = useLayoutStore(s => s.sessionRuntimeByPanel[api.id] ?? null)
  const ctxPct = contextUsedPercent(sessionRuntime)
  const [sessionDetailsPrompt, setSessionDetailsPrompt] = useState<SessionDetailsPrompt | null>(null)
  const [sessionDetailsName, setSessionDetailsName] = useState('')
  const [sessionDescription, setSessionDescription] = useState('')
  const [sessionDescriptionReady, setSessionDescriptionReady] = useState(false)
  const [sessionDetailsLoading, setSessionDetailsLoading] = useState(false)
  const [sessionDetailsSaving, setSessionDetailsSaving] = useState(false)
  const [sessionDetailsError, setSessionDetailsError] = useState<string | null>(null)
  const sessionDetailsInputRef = useRef<HTMLInputElement>(null)
  const sessionDetailsRequestRef = useRef(0)
  const colorKey = getColorKey(params)
  const savedColors = loadTabColors()
  const tabColor = colorKey ? (savedColors[colorKey] ?? '') : ''
  const [color, setColor] = useState(tabColor)
  // Jamat-opened tabs use `ai-claude-…`/`ai-codex-…` ids. Mark them so a human can see at a
  // glance this is the AI's tab and that it's ephemeral (the bridge auto-closes it when done).
  const isAi = api.id.startsWith('ai-')
  // Session-lifecycle actions (rename / compact / fork / …) only make sense on an actual agent
  // terminal tab. File-viewer / directory-viewer / other panels carry no `agent` param, so they
  // must not offer them.
  const isAgentTab = isAgentId(params?.agent)
  const remotePeer = params?.peer as RemotePeer | undefined
  const remoteTerminalId = params?.terminalId as string | undefined
  const isRemoteView = !!(remotePeer && remoteTerminalId)
  const tabAgentId = isAgentId(params?.agent) ? params.agent : DEFAULT_AGENT_ID
  let agentCanShowContext = false
  try { agentCanShowContext = getRendererAgent(tabAgentId).capabilities.contextPercent } catch { agentCanShowContext = false }

  // One runtime poll per tab feeds the tab glyph, terminal overlay, and active status-bar item.
  useEffect(() => {
    const dir = (params?.projectDir ?? params?.cwd) as string | undefined
    const getSessionModel = window.electronAPI?.getSessionModel
    const sessionId = params?.sessionId as string | undefined
    const peer = params?.peer as RemotePeer | undefined
    const terminalId = params?.terminalId as string | undefined
    const isRemote = !!(peer && terminalId && window.electronAPI?.remoteOp)
    const canReadLocal = agentCanShowContext && terminalPhase === 'running' && !!dir && !!getSessionModel
    const setRuntime = (info: SessionModelInfo | null) => useLayoutStore.getState().setSessionRuntime(api.id, info)
    const publishPct = (info: SessionModelInfo | null) => {
      window.dispatchEvent(new CustomEvent('context-pct', { detail: { id: api.id, pct: contextUsedPercent(info) } }))
    }
    if (!isRemote && !canReadLocal) {
      setRuntime(null)
      publishPct(null)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      let info: SessionModelInfo | null = null
      try {
        if (isRemote) {
          const result = await window.electronAPI.remoteOp(peer!, 'control:session-model', [terminalId!])
          info = result.ok ? ((result.data as SessionModelInfo | null | undefined) ?? null) : null
        } else
          info = await getSessionModel!(dir!, sessionId)
      } catch { info = null }
      if (cancelled) return
      setRuntime(info)
      publishPct(info)
      timer = setTimeout(tick, info ? 20_000 : 8_000)
    }
    setRuntime(null)
    publishPct(null)
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      setRuntime(null)
      publishPct(null)
    }
  }, [api.id, agentCanShowContext, params?.projectDir, params?.cwd, params?.sessionId, params?.peer, params?.terminalId, terminalPhase])

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

  const closeSessionDetails = useCallback(() => {
    sessionDetailsRequestRef.current++
    setSessionDetailsPrompt(null)
    setSessionDetailsLoading(false)
    setSessionDetailsSaving(false)
    setSessionDescriptionReady(false)
    setSessionDetailsError(null)
  }, [])

  const loadSessionDescription = useCallback(async (sessionId: string, requestId: number) => {
    try {
      if (!window.electronAPI?.loadSessionDescription)
        throw new Error('loadSessionDescription API not available — preload outdated?')
      const result = await window.electronAPI.loadSessionDescription(sessionId)
      if (sessionDetailsRequestRef.current !== requestId) return
      if (result.ok === true) {
        setSessionDescription(result.description)
        setSessionDescriptionReady(true)
        setSessionDetailsPrompt(current => {
          if (!current || current.sessionId !== sessionId) return current
          return { ...current, defaultDescription: result.description }
        })
      } else if (result.ok === false)
        setSessionDetailsError(result.error)
      else
        throw new Error(`Unknown session description result: ${JSON.stringify(result)}`)
    } catch (error) {
      if (sessionDetailsRequestRef.current === requestId)
        setSessionDetailsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (sessionDetailsRequestRef.current === requestId) setSessionDetailsLoading(false)
    }
  }, [])

  const startSessionDescriptionLoad = useCallback((sessionId: string) => {
    const requestId = ++sessionDetailsRequestRef.current
    setSessionDescription('')
    setSessionDescriptionReady(false)
    setSessionDetailsLoading(true)
    setSessionDetailsError(null)
    void loadSessionDescription(sessionId, requestId)
  }, [loadSessionDescription])

  const handleEditSessionDetails = useCallback(() => {
    const prefix = folderPrefix(params)
    const full = (api.title ?? '').trim()
    const current = prefix && full.startsWith(prefix) ? full.slice(prefix.length).trim() : full
    const sessionId = (params?.sessionId as string | undefined) ?? null
    sessionDetailsRequestRef.current++
    setSessionDetailsName(current)
    setSessionDescription('')
    setSessionDescriptionReady(false)
    setSessionDetailsLoading(false)
    setSessionDetailsSaving(false)
    setSessionDetailsError(null)
    setSessionDetailsPrompt({ defaultName: current, defaultDescription: '', sessionId })
    if (sessionId) startSessionDescriptionLoad(sessionId)
    setTimeout(() => {
      const el = sessionDetailsInputRef.current
      if (el) { el.focus(); el.select() }
    }, 50)
  }, [api.title, params, startSessionDescriptionLoad])

  const submitSessionDetails = useCallback(async () => {
    if (!sessionDetailsPrompt || sessionDetailsLoading || sessionDetailsSaving) return
    const name = sessionDetailsName.trim()
    const description = sessionDescription.trim()
    const nameChanged = name !== sessionDetailsPrompt.defaultName
    const descriptionChanged = sessionDescriptionReady && description !== sessionDetailsPrompt.defaultDescription
    if (!nameChanged && !descriptionChanged) { closeSessionDetails(); return }
    if (nameChanged && !name) { setSessionDetailsError('Name is empty'); return }

    const projectDir = (params?.projectDir as string | undefined) ?? (params?.cwd as string | undefined) ?? ''
    const sessionId = params?.sessionId as string | undefined
    const requestId = sessionDetailsRequestRef.current
    setSessionDetailsSaving(true)
    setSessionDetailsError(null)
    try {
      if (nameChanged) {
        if (!window.electronAPI?.renameSession)
          throw new Error('renameSession API not available — preload outdated?')
        if (!projectDir) {
          const keys = Object.keys(params ?? {}).join(', ') || '<empty>'
          throw new Error(`projectDir missing from tab params (keys: ${keys})`)
        }
        let slash: string | null = null
        try { slash = getRendererAgent(tabAgentId).renameSlashCommand(name) } catch { slash = null }
        const pipeRenameSlash = () => {
          if (slash) TerminalPromptSubmitter.submit(api.id, slash)
        }
        const applyOptimisticTitle = () => api.setTitle(`${folderPrefix(params)}${name}`)

        if (sessionId) {
          const result = await window.electronAPI.renameSession(projectDir, sessionId, name)
          // A just-resolved session whose transcript hasn't been flushed to disk
          // yet can't take the durable append ('session transcript not found').
          // The live TUI slash renames the running session durably on its own, so
          // fall back to it rather than failing. Only surface the error when there
          // is no live-rename path (an agent without a rename slash command).
          if (!result?.ok && !slash) { setSessionDetailsError(result?.error ?? 'Rename failed'); return }
          applyOptimisticTitle()
          pipeRenameSlash()
        } else if (slash) {
          pipeRenameSlash()
          applyOptimisticTitle()
        } else {
          const result = await window.electronAPI.renameSession(projectDir, '', name)
          if (!result?.ok) { setSessionDetailsError(result?.error ?? 'Rename failed'); return }
          applyOptimisticTitle()
        }
        if (sessionDetailsRequestRef.current !== requestId) return
        setSessionDetailsPrompt(current => current ? { ...current, defaultName: name } : current)
      }

      if (descriptionChanged) {
        const descriptionSessionId = sessionDetailsPrompt.sessionId
        if (!descriptionSessionId) throw new Error('Session id is not resolved yet')
        if (!window.electronAPI?.saveSessionDescription)
          throw new Error('saveSessionDescription API not available — preload outdated?')
        const result = await window.electronAPI.saveSessionDescription(descriptionSessionId, description)
        if (sessionDetailsRequestRef.current !== requestId) return
        if (result.ok === true)
          setSessionDescription(result.description)
        else if (result.ok === false) {
          setSessionDetailsError(result.error)
          return
        } else
          throw new Error(`Unknown session description result: ${JSON.stringify(result)}`)
      }

      if (sessionDetailsRequestRef.current === requestId) closeSessionDetails()
    } catch (error) {
      if (sessionDetailsRequestRef.current === requestId)
        setSessionDetailsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (sessionDetailsRequestRef.current === requestId) setSessionDetailsSaving(false)
    }
  }, [sessionDetailsPrompt, sessionDetailsLoading, sessionDetailsSaving, sessionDetailsName, sessionDescription, sessionDescriptionReady, closeSessionDetails, params, tabAgentId, api])

  const resolvedDetailsSessionId = params?.sessionId as string | undefined
  useEffect(() => {
    if (!sessionDetailsPrompt) return
    if (!sessionDetailsPrompt.sessionId && resolvedDetailsSessionId) {
      setSessionDetailsPrompt(current => current ? { ...current, sessionId: resolvedDetailsSessionId } : current)
      startSessionDescriptionLoad(resolvedDetailsSessionId)
    } else if (sessionDetailsPrompt.sessionId && sessionDetailsPrompt.sessionId !== resolvedDetailsSessionId)
      closeSessionDetails()
  }, [sessionDetailsPrompt, resolvedDetailsSessionId, startSessionDescriptionLoad, closeSessionDetails])

  useEffect(() => {
    const handler = (e: Event) => {
      if (isAgentTab && !isRemoteView && (e as CustomEvent).detail === api.id) handleEditSessionDetails()
    }
    window.addEventListener('edit-session-details', handler)
    return () => window.removeEventListener('edit-session-details', handler)
  }, [api.id, isAgentTab, isRemoteView, handleEditSessionDetails])

  // Fork: open a fork branch of THIS tab's session in a new tab — history preserved
  // under a fresh session id, the original session untouched. Offered per the agent's
  // `capabilities.fork` (Claude `--fork-session`, Codex `codex fork <id>`) and only once
  // the sessionId is known (a fresh continue/new tab before id resolution has none yet →
  // no fork item until it resolves).
  const forkAgentId = tabAgentId
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
  // clean handoff. Same gate as fork (an agent tab with a known session id).
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

  // Compact: type "/compact" into this tab's session and run it. The live local/viewer xterm owns
  // the negotiated Enter encoding and transport. Same action as the status-bar model-item menu.
  const handleCompactSession = useCallback(() => {
    TerminalPromptSubmitter.submit(api.id, '/compact')
  }, [api.id])

  // New blank session: open a fresh, empty session in THIS tab's directory — no resume,
  // no history. Mirrors the restoreMeta 'cc' launch the menu/sidebar use for a brand-new
  // session (executor rewrites the persisted cmd to 'resume'+id once the new id resolves,
  // so a restart reopens THIS session). Offered for agent tabs with a known project dir.
  const canNewSession = isAgentId(params?.agent) && !!forkProjectDir
  // Open a fresh, empty 'cc' session in THIS tab's folder with the given agent. Shared by "New blank
  // session" (same agent) and "New session in <other agent>" (the cross-agent quick-launch below).
  const openNewSessionWith = useCallback((agentId: AgentId) => {
    if (!forkProjectDir) return
    const agentLabel = getRendererAgent(agentId).displayName
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
  let otherAgentId: AgentId
  if (forkAgentId === 'claude') otherAgentId = 'codex'
  else if (forkAgentId === 'codex') otherAgentId = 'claude'
  else
    throw new Error(`Unknown agent id: ${JSON.stringify(forkAgentId)}`)
  const otherAgentLabel = getRendererAgent(otherAgentId).displayName
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
            ? <span className="tab-status-dot status-bgshell" title="Turn finished, but a background shell or sub-agent is still running (may be hung) — Ctrl+T in the terminal to manage it" />
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
          onEditSessionDetails={isAgentTab && !isRemoteView ? handleEditSessionDetails : undefined}
          onNewSession={canNewSession && !isRemoteView ? handleNewSession : undefined}
          onNewSessionOtherAgent={canNewSessionOtherAgent && !isRemoteView ? handleNewSessionOtherAgent : undefined}
          newSessionOtherAgentLabel={otherAgentLabel}
          onForkSession={canFork ? handleForkSession : undefined}
          onRestartSession={canFork ? handleRestartSession : undefined}
          onCompactSession={isRemoteView || (isAgentTab && agentCanShowContext) ? handleCompactSession : undefined}
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
      {sessionDetailsPrompt && createPortal(
        <div
          className="rename-modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !sessionDetailsSaving) closeSessionDetails() }}
        >
          <div className="rename-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="rename-modal-title">Session details</div>
            <label className="session-details-field">
              <span className="session-details-label">Name</span>
              <input
                ref={sessionDetailsInputRef}
                className="rename-modal-input"
                value={sessionDetailsName}
                disabled={sessionDetailsSaving}
                onChange={(e) => { setSessionDetailsName(e.target.value); setSessionDetailsError(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void submitSessionDetails() }
                  else if (e.key === 'Escape' && !sessionDetailsSaving) { e.preventDefault(); closeSessionDetails() }
                }}
                placeholder="Session name…"
                spellCheck={false}
              />
            </label>
            <label className="session-details-field">
              <span className="session-details-label">Description <span>(AppJamat only)</span></span>
              <textarea
                className="rename-modal-input session-details-description"
                value={sessionDescription}
                disabled={!sessionDescriptionReady || sessionDetailsSaving}
                maxLength={4000}
                onChange={(e) => { setSessionDescription(e.target.value); setSessionDetailsError(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void submitSessionDetails() }
                  else if (e.key === 'Escape' && !sessionDetailsSaving) { e.preventDefault(); closeSessionDetails() }
                }}
                placeholder="What is this session about?"
                spellCheck={false}
              />
            </label>
            <div className="session-details-hint">
              {sessionDetailsLoading
                ? 'Loading the saved description…'
                : sessionDetailsPrompt.sessionId
                  ? 'Stored in AppJamat. It is never sent to Claude Code or Codex. Ctrl+Enter saves from the description.'
                  : 'Description becomes available when this new session receives its session id.'}
            </div>
            {sessionDetailsError && <div className="rename-modal-error">{sessionDetailsError}</div>}
            <div className="rename-modal-actions">
              <button
                className="notes-btn notes-btn-primary"
                onClick={() => { void submitSessionDetails() }}
                disabled={sessionDetailsLoading || sessionDetailsSaving}
              >
                {sessionDetailsSaving ? 'Saving…' : 'Save'}
              </button>
              <button className="notes-btn" onClick={closeSessionDetails} disabled={sessionDetailsSaving}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
