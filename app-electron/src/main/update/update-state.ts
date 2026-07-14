/**
 * The update module's live status — one record the drivers write and every surface reads (the status
 * bar, Settings, `debug:info.update`, the manual action). Lives apart from the manager so a driver can
 * report into it without importing the manager back (no cycle).
 *
 * Every mutation BROADCASTS (`update:changed`) — the status bar is a live view, not a poll. A download
 * that fails must move the phase to `error`, because an invisible failure is exactly the bug this
 * module exists to end.
 *
 * Two resolutions on purpose: the BOOT one (what the running driver actually uses — the background
 * driver is resolved once, so reporting the just-saved config's knobs would be a lie) and a fresh
 * CONFIG view (channel/reason/warnings reflect the config as it is NOW, so a deprecated key the user
 * just removed stops being flagged).
 */
import type { UpdateResolution } from '../../../../core/update/update-channel.js'
import type { UpdateDownloadProgress, UpdatePhase, UpdateStatus } from '../../../../core/update/update-status.types.js'
import { getAppVersion } from '../app-root'
import { publish } from '../streams'

export type { UpdateStatus }

let boot: UpdateResolution | null = null
let current: UpdateResolution | null = null
let phase: UpdatePhase = 'idle'
let progress: UpdateDownloadProgress | null = null
let lastError: string | null = null
let lastCheckAt: number | null = null
let lastCheckOutcome: string | null = null
let pendingVersion: string | null = null
let snoozedUntil = 0

function notify(): void {
  publish('update:changed', getUpdateStatus())
}

/** Called once at boot — these knobs are what the background driver runs with until a restart. */
export function setBootResolution(res: UpdateResolution): void { boot = res; current = res; notify() }
/** Called on every manual action / status read — refreshes the config-derived view. */
export function setCurrentResolution(res: UpdateResolution): void { current = res; notify() }

export function setChecking(): void {
  // A check while a download runs (or one is ready) must not erase the more advanced phase.
  if (phase === 'downloading' || phase === 'ready') return
  phase = 'checking'
  notify()
}

export function setDownloading(p: UpdateDownloadProgress): void {
  phase = 'downloading'
  progress = p
  lastError = null
  notify()
}

/** Up to date — the check ran and there is nothing to do. */
export function setIdle(): void {
  if (phase === 'ready') return  // a pending update outranks a later "nothing new" check
  phase = 'idle'
  progress = null
  lastError = null
  notify()
}

export function setError(message: string): void {
  phase = 'error'
  progress = null
  lastError = message
  notify()
}

export function setLastCheck(outcome: string): void {
  lastCheckAt = Date.now()
  lastCheckOutcome = outcome
  notify()
}

/** A version is waiting for a restart (github: downloaded; source: newer build on disk). */
export function setPendingVersion(v: string | null): void {
  pendingVersion = v
  if (v) { phase = 'ready'; progress = null; lastError = null }
  else if (phase === 'ready') phase = 'idle'
  notify()
}

export function setSnoozedUntil(ms: number): void { snoozedUntil = ms; notify() }
export function getSnoozedUntil(): number { return snoozedUntil }

export function getUpdateStatus(): UpdateStatus {
  return {
    channel: current?.channel ?? 'none',
    reason: current?.reason ?? 'The update module has not started yet.',
    warnings: current?.warnings ?? [],
    // The RUNNING driver's knobs, not the saved config's — Settings says "applies after a restart".
    autoCheck: boot?.autoCheck ?? true,
    checkIntervalMinutes: boot?.checkIntervalMinutes ?? 0,
    running: getAppVersion(),
    phase,
    progress,
    lastError,
    lastCheckAt,
    lastCheckOutcome,
    pendingVersion,
    snoozedUntil,
  }
}
