import { useEffect, useState, useCallback, useRef } from 'react'
import { DEFAULT_AGENT_ID } from '../../../core/types/contracts'
import type { SessionModelInfo } from '../../../core/types/session'
import type { RemotePeer } from '../../../core/types/remote-control'
import { DockLayout } from './components/layout/DockLayout'
import { TabListPanel } from './components/layout/TabListPanel'
import { useLayoutStore, type TerminalRenderer } from './store/layout-store'
import { ToastContainer } from './components/Toast'
import { SessionDonePromptPopup } from './components/SessionDonePromptPopup'
import { TabTypePicker } from './components/TabTypePicker'
import { useTaskNotifications } from './hooks/useTaskNotifications'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMenuActions } from './hooks/useMenuActions'
import { useTabTreePush } from './hooks/useTabTreePush'
import { useCompletedTabs } from './hooks/useCompletedTabs'
import { useControlOpenTab } from './hooks/useControlOpenTab'
import { useControlCloseTab } from './hooks/useControlCloseTab'
import { useRemoteActivityLog } from './hooks/useRemoteActivityLog'
import type { TabType } from './tab-types'
import { addError } from './components/panels/ErrorLogPanel'
import { TerminalContextMenu } from './components/TerminalContextMenu'
import { CommandPalette } from './components/CommandPalette'
import { SelectionIndicator } from './components/SelectionIndicator'
import { ClipboardDebug } from './components/ClipboardDebug'
import { WorkDetectionStatus } from './components/WorkDetectionStatus'
import { loadSettings, SETTINGS_CHANGED_EVENT, STORAGE_KEY as SETTINGS_STORAGE_KEY } from './components/panels/SettingsPanel'
import { openOrActivatePanel } from './utils/terminal-helpers'
import { contextLevel, compactSuggestPct } from './utils/context-level'

import { getGroupName, getGroupColor } from './utils/window-params'

const BAR_LEN = 10
function usageBar(pct: number): { filled: string; empty: string } {
  const n = Math.round((pct / 100) * BAR_LEN)
  return { filled: '█'.repeat(n), empty: '░'.repeat(BAR_LEN - n) }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// Status-bar badge: which renderer the ACTIVE terminal tab actually runs on. DOM = the accelerated
// addon failed to load or the GPU context was lost (a silent fallback — the title spells it out).
const RENDERER_BADGE: Record<TerminalRenderer, { label: string; title: string }> = {
  webgl: { label: 'OGL', title: 'Renderer: WebGL (GPU atlas — fast, can mis-paint / garble on context loss)' },
  dom:   { label: 'DOM', title: 'Renderer: DOM (default — no GPU atlas, no mis-paint corruption)' },
}

function RendererBadge() {
  const renderers = useLayoutStore(s => s.terminalRenderers)
  const dims = useLayoutStore(s => s.terminalDims)
  const activeKey = useLayoutStore(s => s.activePanel) // active panel id — subscribe so the badge re-reads on tab switch
  const api = useLayoutStore(s => s.dockviewApi)
  void activeKey
  const activeId = api?.activePanel?.id
  const r = activeId ? renderers[activeId] : undefined
  if (!r) return null
  const b = RENDERER_BADGE[r]
  const d = activeId ? dims[activeId] : undefined
  return (
    <span
      className="status-item"
      title={`${b.title}${d ? `\nGeometry: ${d.cols}×${d.rows} (cols×rows)` : ''}`}
      style={{ opacity: 0.7, fontFamily: 'monospace', fontSize: '11px' }}
    >
      {b.label}{d ? ` ${d.cols}×${d.rows}` : ''}
    </span>
  )
}

export function App() {
  const { toggleSidebar, addPanel, activePanel, setAppConfig, setAgentsMeta, usageData, setUsageData, setTheme } = useLayoutStore()
  // User-configurable context-fullness warning levels (Settings → Context warnings); undefined → defaults.
  const contextLevels = useLayoutStore(s => s.appConfig?.contextLevels)
  // Active config profile name — the Demo/screenshot profile ("Demo") swaps the dev title suffix for " - Demo".
  const configName = useLayoutStore(s => s.appConfig?.name)
  useTaskNotifications()
  useTabTreePush()
  useCompletedTabs()
  useControlOpenTab()
  useControlCloseTab()
  useRemoteActivityLog()
  const [showTabPicker, setShowTabPicker] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [sessionModel, setSessionModel] = useState<SessionModelInfo | null>(null)
  // True when the shown sessionModel belongs to a PEER (a remote-viewer tab) — adds a 🛰 marker.
  const [sessionModelRemote, setSessionModelRemote] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [groupName, setGroupName] = useState<string | null>(getGroupName())
  const [groupColor, setGroupColor] = useState<string | null>(getGroupColor())
  const [remoteSession, setRemoteSession] = useState<{ peerLabel: string } | null>(null)
  // Status-bar clipboard-debug widget (Settings → Debug). Off by default; re-read live on Save.
  const [showClipDebug, setShowClipDebug] = useState(() => loadSettings().showClipboardDebug)
  // Status-bar work-detection widget (Settings → Debug). Off by default; re-read live on Save.
  const [showWorkDebug, setShowWorkDebug] = useState(() => loadSettings().showWorkDetectionDebug)
  // Status-bar renderer/geometry badge ("DOM 135×68"). On by default (Settings → Debug).
  const [showRendererBadge, setShowRendererBadge] = useState(() => loadSettings().showRendererBadge)
  const remoteIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Compact the ACTIVE tab's session: type "/compact" + Enter into it so Claude runs /compact.
  // Local tab → write straight to its PTY; remote-viewer tab (params carry peer + terminalId) →
  // inject into the PEER's terminal over the bridge (control:write-keys, same op the AI send uses).
  const compactActiveSession = useCallback(() => {
    const panel = useLayoutStore.getState().dockviewApi?.activePanel
    if (!panel) return
    const params = panel.params as Record<string, unknown> | undefined
    const peer = params?.peer as RemotePeer | undefined
    const terminalId = params?.terminalId as string | undefined
    if (peer && terminalId) {
      void window.electronAPI?.remoteOp?.(peer, 'control:write-keys', [{ terminalId, data: '/compact\r' }])
    } else {
      window.electronAPI?.writeTerminal?.(panel.id, '/compact\r')
    }
  }, [])

  useEffect(() => {
    const suffix = configName === 'Demo' ? ' - Demo' : import.meta.env.DEV ? ' - Debug' : ''
    document.title = (groupName ? `${groupName} — Jamat` : 'Jamat') + suffix
  }, [groupName, configName])

  useEffect(() => {
    if (!window.electronAPI?.onGroupColorChanged) return
    return window.electronAPI.onGroupColorChanged((color: string) => setGroupColor(color || null))
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onGroupNameChanged) return
    return window.electronAPI.onGroupNameChanged((name: string) => setGroupName(name || null))
  }, [])

  useEffect(() => {
    window.electronAPI?.getAppVersion?.().then(setAppVersion)
  }, [])

  // Which agents are installed (binary on PATH) — computed main-side. Cached once in the store so
  // the Agents settings tab and every tab's context menu (cross-agent "New session in …") read it
  // without each re-probing. Availability doesn't change within a session, so a single fetch is enough.
  useEffect(() => {
    window.electronAPI?.listAgents?.().then(setAgentsMeta).catch(() => setAgentsMeta([]))
  }, [setAgentsMeta])

  // Re-read the status-bar debug toggles without a reload. Two triggers:
  //  • SETTINGS_CHANGED_EVENT — same window (the one that toggled): a plain window event, fires here.
  //  • 'storage' — OTHER windows: the browser fires it in every same-origin document EXCEPT the one
  //    that wrote localStorage, so this is what cross-window-syncs the change to the other windows.
  useEffect(() => {
    const apply = () => {
      const s = loadSettings()
      setShowClipDebug(s.showClipboardDebug)
      setShowWorkDebug(s.showWorkDetectionDebug)
      setShowRendererBadge(s.showRendererBadge)
    }
    const onStorage = (e: StorageEvent) => { if (e.key === SETTINGS_STORAGE_KEY || e.key === null) apply() }
    window.addEventListener(SETTINGS_CHANGED_EVENT, apply)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, apply)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // Passive indicator: a remote peer is connected/controlling this app. Clears
  // after 30s idle (no further authenticated activity). Clicking opens the
  // Remote connections panel where the "Allow remote control" toggle is the
  // kill switch (disabling it stops the listener + drops sockets).
  useEffect(() => {
    if (!window.electronAPI?.onRemoteSessionActive) return
    const off = window.electronAPI.onRemoteSessionActive((info) => {
      if (!info.active) { setRemoteSession(null); return }
      setRemoteSession({ peerLabel: info.peerLabel })
      if (remoteIdleRef.current) clearTimeout(remoteIdleRef.current)
      remoteIdleRef.current = setTimeout(() => setRemoteSession(null), 30000)
    })
    return () => { off(); if (remoteIdleRef.current) clearTimeout(remoteIdleRef.current) }
  }, [])

  // Model + context for the active tab's session. Re-arms on tab switch:
  // polls fast until the transcript yields a value (layout still restoring,
  // or a new session that hasn't produced its first assistant turn), then
  // settles to once per minute (the transcript only grows a turn at a time).
  useEffect(() => {
    const FAST_MS = 2_000
    const SLOW_MS = 60_000
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      const api = useLayoutStore.getState().dockviewApi
      const params = api?.activePanel?.params as Record<string, unknown> | undefined
      let info: SessionModelInfo | null = null
      let isRemote = false
      try {
        const peer = params?.peer as RemotePeer | undefined
        const terminalId = params?.terminalId as string | undefined
        if (peer && terminalId && window.electronAPI?.remoteOp) {
          // Remote-viewer tab: read the PEER session's model + context over the bridge.
          // control:session-model resolves the terminal's cwd + sessionId on the peer.
          isRemote = true
          const r = await window.electronAPI.remoteOp(peer, 'control:session-model', [terminalId])
          info = r.ok ? ((r.data as SessionModelInfo | null) ?? null) : null
        } else {
          const dir = (params?.projectDir ?? params?.cwd) as string | undefined
          const getSessionModel = window.electronAPI?.getSessionModel
          if (dir && getSessionModel) {
            info = (await getSessionModel(dir, params?.sessionId as string | undefined)) ?? null
          }
        }
      } catch {
        info = null
      }
      if (cancelled) return
      setSessionModel(info)
      setSessionModelRemote(isRemote && !!info)
      timer = setTimeout(tick, info ? SLOW_MS : FAST_MS)
    }

    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [activePanel])

  const [configLoaded, setConfigLoaded] = useState(false)

  useEffect(() => {
    if (window.electronAPI?.getConfig) {
      window.electronAPI.getConfig().then((config) => {
        if (config) setAppConfig(config)
        setConfigLoaded(true)
      })
    } else {
      setConfigLoaded(true)
    }
  }, [setAppConfig])

  // Keep this window's config fresh when any window saves a config edit (config:update broadcasts
  // config:changed with the reloaded AppConfig) — categories/agent/menus/prompts apply live.
  useEffect(() => {
    return window.electronAPI?.onConfigChanged?.((config) => setAppConfig(config))
  }, [setAppConfig])

  // First-run onboarding: once config + the dockview API are ready, ask main whether this is a fresh
  // install and, if so, open Settings in guided mode (the in-app replacement for the old welcome
  // dialog). Runs once per window load.
  const [onboardingChecked, setOnboardingChecked] = useState(false)
  const dockviewApi = useLayoutStore(s => s.dockviewApi)
  useEffect(() => {
    if (onboardingChecked || !configLoaded || !dockviewApi) return
    setOnboardingChecked(true)
    window.electronAPI?.getOnboardingState?.().then(({ firstRun }) => {
      if (firstRun) openOrActivatePanel(dockviewApi, 'settings', 'settingsPanel', 'Settings', { guided: true })
    }).catch(() => {})
  }, [configLoaded, dockviewApi, onboardingChecked])

  useEffect(() => {
    window.electronAPI?.getUsage?.().then((data) => {
      if (data) setUsageData(data)
    })
    if (!window.electronAPI?.onUsageUpdate) return
    return window.electronAPI.onUsageUpdate((cache) => setUsageData(cache))
  }, [setUsageData])

  useEffect(() => {
    if (!window.electronAPI?.onOpenTab) return
    return window.electronAPI.onOpenTab((id, meta) => {
      const api = useLayoutStore.getState().dockviewApi
      if (!api) return
      const agentId = meta.agent ?? DEFAULT_AGENT_ID
      // Hardcoded label mirrors RendererAgent — kept inline because the
      // registry is async to bootstrap and we want the title eagerly.
      const agentLabel = agentId === 'codex' ? 'Codex' : 'Claude'
      api.addPanel({
        id,
        component: 'terminalPanel',
        title: `${meta.folderName} - ${agentLabel}`,
        params: {
          projectDir: meta.projectDir,
          cmd: meta.cmd,
          folderName: meta.folderName,
          sessionId: meta.sessionId,
          forkParentId: meta.forkParentId,
          agent: agentId,
        }
      })
    })
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onError) return
    const removeError = window.electronAPI.onError((source, message) => {
      addError(source, message)
    })
    const openErrorTab = () => {
      const api = useLayoutStore.getState().dockviewApi
      if (api) openOrActivatePanel(api, 'error-log', 'errorLogPanel', 'Error Log')
    }
    window.addEventListener('open-error-log', openErrorTab)
    return () => { removeError(); window.removeEventListener('open-error-log', openErrorTab) }
  }, [])

  const openNewWindow = useCallback(() => window.electronAPI?.newWindow(), [])

  useKeyboardShortcuts(addPanel, toggleSidebar, setShowTabPicker, setShowCommandPalette, openNewWindow)
  useMenuActions(addPanel, toggleSidebar, setShowTabPicker, setTheme)

  const createTabFromType = (type: TabType) => {
    const api = useLayoutStore.getState().dockviewApi
    if (!api) return
    // Singleton panels: reuse the existing tab instead of stacking duplicates.
    if (type.id === 'remote') { openOrActivatePanel(api, 'remote-connections', 'remoteConnectionsPanel', 'Remote connections'); return }
    // randomUUID (not Date.now()) so two opens in the same millisecond can't collide on
    // the panel id → dockview addPanel no-op/throw.
    const id = `${type.id}-${crypto.randomUUID()}`
    const extraParams: Record<string, unknown> = {}
    if (type.id === 'session-search') {
      const activePanel = api.activePanel
      const projectDir = (activePanel?.params as any)?.projectDir ?? (activePanel?.params as any)?.cwd ?? ''
      const sessionId = (activePanel?.params as any)?.sessionId
      if (projectDir) extraParams.projectDir = projectDir
      if (sessionId) extraParams.sessionId = sessionId
    }
    api.addPanel({
      id,
      component: type.component,
      title: type.label,
      params: { ...type.defaultParams, ...extraParams }
    })
  }

  return (
    <div className="app-container">
      <div className="layout-area">
        {configLoaded ? <DockLayout /> : null}
        <TabListPanel />
      </div>
      <div className="status-bar" style={groupColor ? { background: groupColor } : undefined}>
        <span className="status-item" title="App version" style={{ opacity: 0.7, fontFamily: 'monospace', fontSize: '11px' }}>{appVersion ? `v${appVersion}` : ''}</span>
        {showRendererBadge && <RendererBadge />}
        <span className="status-item">{groupName ?? 'Unnamed window'}</span>
        <SelectionIndicator />
        {showClipDebug && <ClipboardDebug />}
        {showWorkDebug && <WorkDetectionStatus />}
        {remoteSession && (
          <span
            className="status-item"
            title={`Remote control active from ${remoteSession.peerLabel} — click to manage / disable`}
            style={{
              cursor: 'pointer',
              color: '#ffd866',
              fontWeight: 600,
              background: 'rgba(0, 0, 0, 0.55)',
              padding: '2px 8px',
              borderRadius: 4,
            }}
            onClick={() => {
              const api = useLayoutStore.getState().dockviewApi
              if (api) openOrActivatePanel(api, 'remote-connections', 'remoteConnectionsPanel', 'Remote connections')
            }}
          >
            🛰 remote: {remoteSession.peerLabel}
          </span>
        )}
        {/* Spacer — pushes the model/context block to the right edge (replaces the old
            "+ New Tab / + New Window" buttons; those actions live in the tab picker + shortcuts). */}
        <span style={{ marginLeft: 'auto' }} />
        {sessionModel ? (() => {
          const pct = sessionModel.contextWindow > 0
            ? Math.round((sessionModel.contextTokens / sessionModel.contextWindow) * 100)
            : 0
          // Flag a non-opus model in red — opus is the expected default, so anything else
          // (sonnet/haiku/…) should stand out at a glance in the status bar.
          const isOpus = /opus/i.test(sessionModel.model || sessionModel.modelLabel)
          // Context-fill warning on the "xk / 1M · pct%" part — SAME configured thresholds + colors
          // as the per-tab indicator (shared contextLevel + contextLevels config): a level colours
          // this only when its `statusBar` is on. Below the first such level it stays the default
          // text color (a popup-only level still surfaces the Compact button below, but no colour).
          const ctxLevel = contextLevel(pct, contextLevels)
          const ctxStyle = ctxLevel ? { color: ctxLevel.color, fontWeight: ctxLevel.fontWeight } : undefined
          return (
            <span
              className="status-item"
              title={`${sessionModelRemote ? '🛰 remote session\n' : ''}Model: ${sessionModel.model}\nContext: ${sessionModel.contextTokens.toLocaleString()} / ${sessionModel.contextWindow.toLocaleString()} tokens (${pct}%)${sessionModel.effortLevel ? `\nEffort: ${sessionModel.effortLevel}` : ''}`}
              style={{ fontFamily: 'monospace', fontSize: '11px', letterSpacing: '-0.5px' }}
            >
              {sessionModelRemote ? '🛰 ' : ''}<span style={isOpus ? undefined : { color: '#e0707a', fontWeight: 600 }}>{sessionModel.modelLabel}</span>{sessionModel.effortLevel ? ` · ${sessionModel.effortLevel}` : ''} · <span style={ctxStyle}>{fmtTokens(sessionModel.contextTokens)} / {fmtTokens(sessionModel.contextWindow)} · {pct}%</span>
              {pct > compactSuggestPct(contextLevels) && (
                <button
                  className="status-btn status-compact-btn"
                  title="Compact this session — types /compact into it and runs it"
                  style={ctxLevel ? { background: ctxLevel.color, borderColor: ctxLevel.color, color: '#1a1a1a' } : undefined}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); compactActiveSession() }}
                >
                  Compact
                </button>
              )}
            </span>
          )
        })() : null}
        {usageData?.data ? (() => {
          const s = usageBar(usageData.data.five_hour.utilization)
          const w = usageBar(usageData.data.seven_day.utilization)
          return (
            <span
              className="status-item"
              title={`Session: ${usageData.data.five_hour.utilization}% (resets ${new Date(usageData.data.five_hour.resets_at).toLocaleTimeString()})\nWeekly: ${usageData.data.seven_day.utilization}% (resets ${new Date(usageData.data.seven_day.resets_at).toLocaleDateString()})`}
              style={{ cursor: 'default', fontFamily: 'monospace', fontSize: '11px', letterSpacing: '-0.5px' }}
            >
              S: {String(usageData.data.five_hour.utilization).padStart(2)}% [<span style={{ color: 'rgba(255,255,255,0.7)' }}>{s.filled}</span>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>{s.empty}</span>],
              {' '}W: {String(usageData.data.seven_day.utilization).padStart(2)}% [<span style={{ color: 'rgba(255,255,255,0.7)' }}>{w.filled}</span>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>{w.empty}</span>]
              <span
                style={{ cursor: 'pointer', marginLeft: 6, fontSize: 12, opacity: 0.6 }}
                title="Open usage on claude.ai"
                onClick={() => (window as any).electronAPI.runAction('open-url', 'https://claude.ai/settings/usage')}
              >↗</span>
            </span>
          )
        })() : usageData ? (
          <span className="status-item" style={{ color: '#888' }} title={usageData.error ?? 'No usage data'}>S:? W:?</span>
        ) : null}
      </div>
      {showTabPicker && (
        <TabTypePicker
          onSelect={createTabFromType}
          onClose={() => setShowTabPicker(false)}
        />
      )}
      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} />
      )}
      <TerminalContextMenu />
      <ToastContainer />
      <SessionDonePromptPopup />
    </div>
  )
}
