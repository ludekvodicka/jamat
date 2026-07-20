import { useEffect, useState, useCallback, type CSSProperties } from 'react'
import { loadSettings } from './panels/SettingsPanel'
import { useLayoutStore } from '../store/layout-store'
import type { SessionDonePrompt } from '../../shared/types'
import type { AgentWorkStatus } from '../../../../core/agents/workDetection/agentWorkDetector.types'
import { TerminalPromptSubmitter } from '../utils/terminalPromptSubmitter'

/**
 * Bottom-right quick-prompt affordance for an idle agent session on the active tab. Each button
 * types its prompt into that session and submits it (Enter), so a finished turn can be followed up
 * in one click ("Continue", "Summarize", …). Buttons come from config (`sessionDonePrompts`, edited
 * in Settings → Quick prompts), falling back to a built-in default; toggled in Settings → Notifications.
 *
 * Shown whenever the ACTIVE tab is a local terminal session that is currently idle — including a
 * session that was idle from app start (a restored/resumed session crosses no status edge, so the
 * status events never fire; a short grace after the tab becomes active assumes idle, mirroring
 * ContextWarningOverlay's open-into-idle handling). Two visual states:
 *  - full DIALOG — auto-opens the moment the active tab FINISHES a non-trivial turn (work→idle with
 *    work ≥ the notifyAfterSeconds threshold). ✕ collapses it to the bubble.
 *  - BUBBLE (💬) — the resting state for any idle active session: a small icon that opens the dialog.
 *
 * Only ever rendered for the active tab (a fixed-position node from a hidden panel would overlap),
 * and only for local `terminalPanel` tabs that aren't plain shells — never Settings/Help/etc.
 */

const ACTIVE_STATUSES: AgentWorkStatus[] = ['running', 'tool-use', 'blocked', 'waiting']
// A session that opens straight into idle emits no status transition; if nothing arrives this soon
// after the tab becomes active, assume idle (a working tab would already have emitted 'running').
const OPEN_INTO_IDLE_GRACE_MS = 1500
// Once the full dialog is open (auto-popped on finish, or opened from the bubble), collapse it back
// to the bubble after this long — no need to keep it covering the terminal; the bubble reopens it.
const AUTO_COLLAPSE_MS = 30_000

const DEFAULT_PROMPTS: SessionDonePrompt[] = [
  { label: 'Continue', prompt: 'What should we do next?' },
  { label: 'Summarize', prompt: 'Summarize what you just did.' },
]

export function SessionDonePromptPopup() {
  // Latest known status per terminal id (only terminal tabs ever emit `terminal-status`).
  const [statusById, setStatusById] = useState<Record<string, AgentWorkStatus>>({})
  // The tab whose FULL dialog is open (vs. the resting bubble). null = collapsed.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const activePanel = useLayoutStore(s => s.activePanel)
  const dockviewApi = useLayoutStore(s => s.dockviewApi)
  const terminalAgents = useLayoutStore(s => s.terminalAgents)
  const appConfig = useLayoutStore(s => s.appConfig)
  const prompts = appConfig?.sessionDonePrompts?.length ? appConfig.sessionDonePrompts : DEFAULT_PROMPTS

  useEffect(() => {
    // When each tab's current turn started (set when it goes active, read on the idle edge) — gates
    // the AUTO-DIALOG on work duration. The bubble itself doesn't need it (any idle session shows it).
    const starts = new Map<string, number>()

    const onStatus = (e: Event) => {
      const { id, status, backgroundActivity } = (e as CustomEvent<{ id?: string; status?: AgentWorkStatus; backgroundActivity?: boolean }>).detail ?? {}
      if (!id || !status) return
      // Idle with a background shell/sub-agent still running → the turn isn't truly finished; defer
      // (keep `starts`, don't flip to idle). When the task clears, useTerminal re-emits idle without the
      // flag and this fires normally.
      if (status === 'idle' && backgroundActivity) return
      setStatusById(prev => (prev[id] === status ? prev : { ...prev, [id]: status }))

      if (ACTIVE_STATUSES.includes(status)) {
        if (!starts.has(id)) starts.set(id, Date.now())
        // Working again → close this tab's dialog if it was open.
        setExpandedId(prev => (prev === id ? null : prev))
        return
      }
      // Idle or done.
      const start = starts.get(id)
      starts.delete(id)
      if (status === 'idle' && start != null) {
        const settings = loadSettings()
        const longEnough = Date.now() - start >= settings.notifyAfterSeconds * 1000
        // Auto-open the full dialog only on a real finish on the tab being viewed; otherwise the
        // resting bubble (below) already offers the prompts.
        if (settings.sessionDonePopupEnabled && longEnough && id === useLayoutStore.getState().activePanel) {
          setExpandedId(id)
        }
      }
    }
    window.addEventListener('terminal-status', onStatus)
    return () => window.removeEventListener('terminal-status', onStatus)
  }, [])

  // Open-into-idle: a session that's idle from the start emits no status, so assume idle after a
  // grace — but only for local terminal tabs (so Settings/Help never get a bubble).
  useEffect(() => {
    const id = activePanel
    if (!id || statusById[id] !== undefined) return
    const panel = dockviewApi?.panels.find(p => p.id === id)
    if (panel?.api?.component !== 'terminalPanel') return
    const t = setTimeout(() => {
      setStatusById(prev => (prev[id] !== undefined ? prev : { ...prev, [id]: 'idle' }))
    }, OPEN_INTO_IDLE_GRACE_MS)
    return () => clearTimeout(t)
  }, [activePanel, statusById, dockviewApi])

  // Switching tabs collapses any open dialog → a revisited idle tab shows the bubble, not a dialog.
  useEffect(() => {
    setExpandedId(prev => (prev && prev !== activePanel ? null : prev))
  }, [activePanel])

  // Auto-collapse the open dialog back to the bubble after AUTO_COLLAPSE_MS. Re-armed each time it
  // (re)opens; cleared if it's collapsed/sent/tab-switched first. Keeps an auto-popped dialog from
  // sitting over the terminal indefinitely — the bubble still offers the prompts on demand.
  useEffect(() => {
    if (expandedId !== activePanel) return
    const t = setTimeout(() => setExpandedId(null), AUTO_COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [expandedId, activePanel])

  // Anchor to the ACTIVE tab's terminal area (its bottom-right), not the whole window. The popup is a
  // single fixed-position node at the app root; without this it sits in the WINDOW corner even when the
  // active terminal is just one pane of a split. We keep position:fixed and override right/bottom with
  // viewport-relative offsets derived from the terminal area's rect. Recompute on tab switch, window
  // resize, and when the terminal area itself resizes (split-drag / sidebar toggle).
  const [anchorStyle, setAnchorStyle] = useState<CSSProperties | undefined>(undefined)
  useEffect(() => {
    if (!activePanel) { setAnchorStyle(undefined); return }
    const findWrapper = () =>
      (document.querySelector(`[data-terminal-id="${activePanel}"]`)?.closest('.terminal-area-wrapper') ?? null) as HTMLElement | null
    const compute = () => {
      const el = findWrapper()
      if (!el) { setAnchorStyle(undefined); return } // no terminal area → fall back to the CSS window corner
      const r = el.getBoundingClientRect()
      setAnchorStyle({
        right: Math.max(8, Math.round(window.innerWidth - r.right + 16)),
        bottom: Math.max(8, Math.round(window.innerHeight - r.bottom + 32)),
      })
    }
    compute()
    const el = findWrapper()
    const ro = el ? new ResizeObserver(compute) : null
    if (el && ro) ro.observe(el)
    window.addEventListener('resize', compute)
    return () => { window.removeEventListener('resize', compute); ro?.disconnect() }
  }, [activePanel])

  // Type + submit a prompt into the active tab's local PTY, then collapse (the new turn flips the
  // tab to running, which hides the affordance).
  const send = useCallback((text: string) => {
    const id = useLayoutStore.getState().activePanel
    setExpandedId(null)
    if (!id) return
    TerminalPromptSubmitter.submit(id, text)
  }, [])

  if (!activePanel) return null
  // The Settings → Notifications toggle gates the whole affordance (bubble + dialog).
  if (!loadSettings().sessionDonePopupEnabled) return null

  // Gate: only a local terminal session that's idle, and not a plain shell.
  const panel = dockviewApi?.panels.find(p => p.id === activePanel)
  const tabType = (panel?.params as Record<string, unknown> | undefined)?.tabType
  const isShell = tabType === 'cmd' || tabType === 'powershell' || tabType === 'browser'
  const isSession = panel?.api?.component === 'terminalPanel' && !isShell
  if (!isSession || statusById[activePanel] !== 'idle') return null
  const agent = terminalAgents[activePanel]
  let agentLabel: string
  if (agent === 'claude') agentLabel = 'Claude'
  else if (agent === 'codex') agentLabel = 'Codex'
  else if (agent === undefined) agentLabel = 'Agent'
  else
    throw new Error(`Unknown agent: ${JSON.stringify(agent)}`)

  // Resting bubble — click to open the dialog.
  if (expandedId !== activePanel) {
    return (
      <button
        className="session-done-bubble"
        style={anchorStyle}
        title={`${agentLabel} je idle — zobrazit akce`}
        aria-label={`${agentLabel} je idle — zobrazit akce`}
        onClick={() => setExpandedId(activePanel)}
      >
        💬
      </button>
    )
  }

  return (
    <div className="session-done-popup" style={anchorStyle} role="dialog" aria-label="Session finished — quick prompts">
      <button className="session-done-close" onClick={() => setExpandedId(null)} title="Collapse to bubble">✕</button>
      <div className="session-done-title">✓ {agentLabel} finished</div>
      <div className="session-done-actions">
        {prompts.map((p, i) => (
          <button
            key={i}
            className="session-done-btn"
            onClick={() => send(p.prompt)}
            title={`Insert and send: ${p.prompt}`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}
