/**
 * The restart-prompt gate, shared by both channel drivers (the whole point of this module is that the
 * update logic exists ONCE — two copies of a gate would drift, and the source driver's copy already
 * lacked the manual bypass).
 *
 * Rules it enforces — all deliberate, do not "fix" them back:
 *  - A BACKGROUND offer waits until every tab is idle (`blocked` = busy: a restart must never drop an
 *    in-progress turn) and until any snooze has elapsed.
 *  - A MANUAL offer bypasses both — the user asked, and the dialog lists the terminals it would kill
 *    instead of silently doing nothing.
 *  - Snooze is the dialog's `defaultId`/`cancelId`: the dialog can pop while the user is typing and a
 *    stray Enter must never restart the app.
 *  - Every suppression is LOGGED with its reason (which tabs were busy / snoozed until when) — this is
 *    the line that answers "I clicked it and nothing happened".
 */
import { dialog } from 'electron'

import { allTabsIdle } from '../tab-tree-cache'
import { buildSessionList } from '../relaunch'
import { logUpdate } from './update-log'
import { getSnoozedUntil, setSnoozedUntil } from './update-state'

const SNOOZE_HOURS = [1, 2, 4, 12] // maps to the four "Snooze" buttons

export interface PromptSpec {
  channel: 'github' | 'source'
  /** The version a restart would land on — logged, and used to dedupe suppression lines. */
  version: string
  title: string
  message: string
  /** Detail shown when every tab is idle (the calm case). */
  idleDetail: string
  /** First button — the one that acts (`Restart & install` / `Restart now`). */
  actionLabel: string
  /** Runs when the user picks the action button. */
  onAction: () => void | Promise<void>
}

interface GateState {
  prompting: boolean
  lastSuppression: string
  snoozeTimer: ReturnType<typeof setTimeout> | null
}

/** Per-driver state (a driver owns exactly one gate). */
export function createPromptGate() {
  const state: GateState = { prompting: false, lastSuppression: '', snoozeTimer: null }

  /** Offer the restart. `manual` bypasses the idle gate + snooze. Returns nothing — the log has the trail. */
  function offer(spec: PromptSpec, manual: boolean): void {
    if (state.prompting) return
    if (!manual) {
      const snoozedUntil = getSnoozedUntil()
      if (Date.now() < snoozedUntil) { suppress(spec, `snoozed until ${new Date(snoozedUntil).toISOString()}`); return }
      if (!allTabsIdle()) { suppress(spec, `idle-gate — busy terminals:\n${buildSessionList()}`); return }
    }
    state.lastSuppression = ''
    void show(spec, manual)
  }

  function suppress(spec: PromptSpec, reason: string): void {
    const key = `${spec.version}|${reason}`
    if (key === state.lastSuppression) return   // the same state re-evaluated (onTabsChanged fires often)
    state.lastSuppression = key
    logUpdate({ event: 'prompt-suppressed', channel: spec.channel, found: spec.version, reason })
  }

  async function show(spec: PromptSpec, manual: boolean): Promise<void> {
    state.prompting = true
    try {
      logUpdate({ event: 'prompt-shown', channel: spec.channel, trigger: manual ? 'manual' : 'background', found: spec.version })
      const busy = !allTabsIdle()
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: spec.title,
        message: spec.message,
        detail: busy
          ? `${spec.idleDetail.split('\n\n')[0]}\n\nRestarting now closes these terminals — some are still working:\n${buildSessionList()}`
          : spec.idleDetail,
        buttons: [spec.actionLabel, 'Snooze 1h', 'Snooze 2h', 'Snooze 4h', 'Snooze 12h'],
        // Default/cancel = Snooze 1h, NOT the action: the dialog can pop while the user is typing and a
        // stray Enter/Space would activate the default — wiping a live session mid-keystroke.
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      if (response === 0) {
        logUpdate({ event: 'user-choice', channel: spec.channel, trigger: manual ? 'manual' : 'background', found: spec.version, detail: spec.actionLabel })
        await spec.onAction()
      } else {
        const hours = SNOOZE_HOURS[response - 1] ?? 1
        setSnoozedUntil(Date.now() + hours * 60 * 60 * 1000)
        logUpdate({ event: 'user-choice', channel: spec.channel, found: spec.version, detail: `snoozed ${hours}h` })
        // Re-offer the moment the snooze elapses (if idle by then).
        if (state.snoozeTimer) clearTimeout(state.snoozeTimer)
        state.snoozeTimer = setTimeout(() => { state.snoozeTimer = null; offer(spec, false) }, hours * 60 * 60 * 1000 + 1000)
      }
    } finally {
      state.prompting = false
    }
  }

  return { offer }
}
