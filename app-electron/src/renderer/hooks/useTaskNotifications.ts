import { useEffect, useRef } from 'react'
import { showToast } from '../components/Toast'
import { loadSettings } from '../components/panels/SettingsPanel'
import { useLayoutStore } from '../store/layout-store'
import { notificationIcon, type NotifKind } from '../utils/notificationIcon'
import type { AgentWorkStatus } from '../../../../core/agents/workDetection/agentWorkDetector.types'

/**
 * Desktop + in-app notifications driven by the work-detection classifier. Listens to the rich
 * `terminal-status` event (idle / running / tool-use / waiting / blocked / done) published by
 * useTerminal, and fires on the transitions the user actually wants to know about:
 *
 *  • COMPLETE — a turn that ran ≥ notifyAfterSeconds finishes (a work state → idle). Keeps the
 *    existing "Finished after …" surface (in-app toast unless the session-done popup covers it).
 *  • QUESTION — Claude pauses for the user: `waiting` (AskUserQuestion / plan approval) or
 *    `blocked` (a y/n permission prompt). Fires immediately (a question shouldn't wait out a
 *    duration threshold). Suppressed only when that tab is already active AND the window is
 *    focused — i.e. the user can already see it.
 *
 * Each notification carries a per-type icon and, on click, focuses the window and activates the
 * originating tab. A crashed PTY still surfaces its own notification (with a crash icon).
 */

interface TaskState {
  /** Start of the current turn's work (running/tool-use); spans through waiting/blocked pauses,
   *  cleared on idle/done. null when not working. */
  workStart: number | null
  /** Last status seen — so a question fires once on ENTRY, not on every same-status republish. */
  lastStatus: AgentWorkStatus
  title: string
}

const WORK_STATES = new Set<AgentWorkStatus>(['running', 'tool-use'])

export function useTaskNotifications() {
  const tasks = useRef<Map<string, TaskState>>(new Map())

  useEffect(() => {
    const getOrCreate = (id: string): TaskState => {
      let state = tasks.current.get(id)
      if (!state) {
        state = { workStart: null, lastStatus: 'idle', title: '' }
        tasks.current.set(id, state)
      }
      return state
    }

    const labelFor = (id: string, state: TaskState): string => {
      const panel = useLayoutStore.getState().dockviewApi?.panels.find((p) => p.id === id)
      return state.title || panel?.title || id
    }

    const agentLabelFor = (id: string): string => {
      const agent = useLayoutStore.getState().terminalAgents[id]
      if (agent === 'claude') return 'Claude'
      else if (agent === 'codex') return 'Codex'
      else if (agent === undefined) return 'Agent'
      else
        throw new Error(`Unknown agent: ${JSON.stringify(agent)}`)
    }

    // Click target: bring the window forward (main resolves the sender's window) and activate the
    // tab the notification came from. Both are best-effort — either may be gone by click time.
    const activate = (id: string) => {
      try { window.electronAPI?.focusWindow?.() } catch { /* ignore */ }
      try { useLayoutStore.getState().dockviewApi?.getPanel(id)?.api.setActive() } catch { /* ignore */ }
    }

    const notify = (kind: NotifKind, title: string, body: string, id: string) => {
      if (Notification.permission !== 'granted') return
      const icon = notificationIcon(kind)
      const n = new Notification(title, { body, icon: icon || undefined })
      n.onclick = () => activate(id)
    }

    const titleHandler = (e: Event) => {
      const { id, title } = (e as CustomEvent).detail ?? {}
      if (!id) return
      getOrCreate(id).title = title
    }

    const statusHandler = (e: Event) => {
      const { id, status, backgroundActivity } = (e as CustomEvent<{ id?: string; status?: AgentWorkStatus; backgroundActivity?: boolean }>).detail ?? {}
      if (!id || !status) return
      // Idle with a background shell/sub-agent still running → not truly finished; defer the COMPLETE
      // ping (keep `workStart`/`lastStatus` so the later idle-without-flag re-emit fires it, timing the
      // full run including the background task).
      if (status === 'idle' && backgroundActivity) return
      const state = getOrCreate(id)
      const prev = state.lastStatus
      const settings = loadSettings()

      // Begin the turn timer on the first work tick; it persists across waiting/blocked pauses.
      if (WORK_STATES.has(status) && state.workStart == null) {
        state.workStart = Date.now()
      }

      // QUESTION — the agent paused for the user. Fire on ENTRY only; skip if the user is already
      // looking at this exact tab (active tab + focused window).
      if ((status === 'waiting' || status === 'blocked') && prev !== status && settings.notifyOnQuestions) {
        const visibleHere = document.hasFocus() && useLayoutStore.getState().activePanel === id
        if (!visibleHere) {
          const kind: NotifKind = status === 'waiting' ? 'question' : 'permission'
          const body = status === 'waiting' ? 'Waiting for your answer' : 'Needs permission to run a tool'
          showToast(labelFor(id, state), body)
          notify(kind, labelFor(id, state), body, id)
        }
      }

      // COMPLETE — a real turn finished (work → idle) and ran long enough to be worth a ping.
      // `done` (process exit) just clears the timer; crashes surface via the crash listener below.
      if (status === 'idle' && state.workStart != null) {
        const duration = Date.now() - state.workStart
        state.workStart = null
        if (settings.notifyOnComplete && duration >= settings.notifyAfterSeconds * 1000) {
          const totalSec = Math.round(duration / 1000)
          const timeStr = totalSec >= 60 ? `${Math.floor(totalSec / 60)}m ${totalSec % 60}s` : `${totalSec}s`
          const label = labelFor(id, state)
          // The session-done popup covers the SAME active-tab finish with a richer surface — skip the
          // toast then to avoid two stacked bottom-right cards. Background finishes still toast.
          const popupWillShow = id === useLayoutStore.getState().activePanel && settings.sessionDonePopupEnabled
          if (!popupWillShow) showToast(label, `Finished after ${timeStr}`)
          notify('complete', label, `Finished after ${timeStr}`, id)
        }
      } else if (status === 'done') {
        state.workStart = null
      }

      state.lastStatus = status
    }

    if (Notification.permission === 'default') {
      Notification.requestPermission()
    }

    window.addEventListener('terminal-status', statusHandler)
    window.addEventListener('screen-title-change', titleHandler)

    // PTY crash signal — surface a toast + notification so the user notices the agent exited
    // unexpectedly instead of silently falling back to the menu.
    const removeCrashListener = window.electronAPI?.onTerminalCrash?.((id, code) => {
      const state = getOrCreate(id)
      state.workStart = null
      const label = labelFor(id, state)
      const agent = agentLabelFor(id)
      showToast(`${label} — ${agent} crashed`, `Exit code ${code} · returned to menu`)
      notify('crash', `${label} — ${agent} crashed`, `Exit code ${code}`, id)
    })

    return () => {
      window.removeEventListener('terminal-status', statusHandler)
      window.removeEventListener('screen-title-change', titleHandler)
      removeCrashListener?.()
    }
  }, [])
}
