/**
 * The restart-prompt gate, shared by both channel drivers (the whole point of this module is that the
 * update logic exists ONCE — two copies of a gate would drift, and the source driver's copy already
 * lacked the manual bypass).
 *
 * The offer is rendered by the RENDERER (`UpdateDialog`), not by `dialog.showMessageBox`: a native
 * message box cannot show the download's progress, and it cannot stay on screen through the 10–20 s
 * between the user's click and the installer's own window (app teardown + installer hand-off) — that
 * silence is what made a working update look broken. The native box remains only as the fallback for
 * a window-less app (no renderer to ask).
 *
 * Rules it enforces — all deliberate, do not "fix" these back:
 *  - A BACKGROUND offer waits until every tab is idle (`blocked` = busy: a restart must never drop an
 *    in-progress turn) and until any snooze has elapsed.
 *  - A MANUAL offer bypasses both — the user asked, and the dialog lists the terminals it would kill
 *    instead of silently doing nothing.
 *  - Snooze, never the action, is what a stray Enter/Escape does: the dialog can pop while the user is
 *    typing and a mis-keyed restart would wipe a live session.
 *  - Every suppression is LOGGED with its reason (which tabs were busy / snoozed until when) — this is
 *    the line that answers "I clicked it and nothing happened".
 */
import { BrowserWindow, dialog } from 'electron'

import type { UpdateChoice, UpdatePrompt } from '../../../../core/update/update-status.types.js'
import { allTabsIdle } from '../tab-tree-cache'
import { buildSessionList } from '../relaunch'
import { publish } from '../streams'
import { logUpdate } from './update-log'
import { getSnoozedUntil, setSnoozedUntil } from './update-state'

const SNOOZE_HOURS = [1, 2, 4, 12] // the snooze choices offered in both the dialog and the fallback

export interface PromptSpec {
  channel: 'github' | 'source'
  /** The version a restart would land on — logged, and used to dedupe suppression lines. */
  version: string
  running: string
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

/** Resolves the in-flight renderer prompt. Null when no dialog is open. */
let pendingChoice: ((choice: UpdateChoice) => void) | null = null

/** The renderer's answer (`update:choice`) — routed here by the manager's IPC registration. */
export function resolveChoice(choice: UpdateChoice): void {
  const resolve = pendingChoice
  pendingChoice = null
  resolve?.(choice)
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
      const prompt: UpdatePrompt = {
        channel: spec.channel,
        version: spec.version,
        running: spec.running,
        actionLabel: spec.actionLabel,
        busy: allTabsIdle() ? null : buildSessionList(),
      }
      const choice = hasWindow() ? await askRenderer(prompt) : await askNative(prompt)
      if (choice.kind === 'action') {
        logUpdate({ event: 'user-choice', channel: spec.channel, trigger: manual ? 'manual' : 'background', found: spec.version, detail: spec.actionLabel })
        // The driver owns what happens next (github: download → install; source: restart) and drives
        // the phases the dialog renders. The dialog stays open on screen through all of it.
        await spec.onAction()
      } else if (choice.kind === 'snooze') {
        setSnoozedUntil(Date.now() + choice.hours * 60 * 60 * 1000)
        logUpdate({ event: 'user-choice', channel: spec.channel, found: spec.version, detail: `snoozed ${choice.hours}h` })
        // Re-offer the moment the snooze elapses (if idle by then).
        if (state.snoozeTimer) clearTimeout(state.snoozeTimer)
        state.snoozeTimer = setTimeout(() => { state.snoozeTimer = null; offer(spec, false) }, choice.hours * 60 * 60 * 1000 + 1000)
      } else
        throw new Error(`Unknown update choice: ${JSON.stringify(choice)}`)
    } finally {
      state.prompting = false
      pendingChoice = null
    }
  }

  return { offer }
}

function hasWindow(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())
}

/** Ask the in-app dialog. Resolves when the user answers; a vanished window falls back to a snooze. */
function askRenderer(prompt: UpdatePrompt): Promise<UpdateChoice> {
  return new Promise<UpdateChoice>((resolve) => {
    let guard: ReturnType<typeof setInterval> | null = null
    const finish = (choice: UpdateChoice) => {
      if (guard) clearInterval(guard)
      pendingChoice = null
      resolve(choice)
    }
    pendingChoice = finish
    // Every window closing takes the dialog with it — treat that as "not now" rather than hanging the
    // gate forever (a stuck `prompting` flag would silently swallow every later offer).
    guard = setInterval(() => { if (!hasWindow()) finish({ kind: 'snooze', hours: 1 }) }, 2000)
    publish('update:prompt', prompt)
  })
}

/** No renderer to ask (window-less run) — the old native message box, kept as the fallback only. */
async function askNative(prompt: UpdatePrompt): Promise<UpdateChoice> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: prompt.channel === 'github' ? 'Update ready' : 'Newer build on disk',
    message: `Jamat ${prompt.version} is ready to install.`,
    detail: prompt.busy
      ? `Running: ${prompt.running}\nNew: ${prompt.version}\n\nRestarting now closes these terminals — some are still working:\n${prompt.busy}`
      : `Running: ${prompt.running}\nNew: ${prompt.version}\n\nAll terminals are idle — restart now to finish the update.`,
    buttons: [prompt.actionLabel, ...SNOOZE_HOURS.map((h) => `Snooze ${h}h`)],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) return { kind: 'action' }
  return { kind: 'snooze', hours: SNOOZE_HOURS[response - 1] ?? 1 }
}
