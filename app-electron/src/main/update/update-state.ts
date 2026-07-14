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
import { buildSessionList } from '../relaunch'
import { publish } from '../streams'
import { allTabsIdle } from '../tab-tree-cache'

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

/** A phase the user has already consented to — a later check must not knock it back. */
function inProgress(): boolean {
  return phase === 'downloading' || phase === 'ready' || phase === 'installing'
}

export function setChecking(): void {
  if (inProgress() || phase === 'available') return
  phase = 'checking'
  notify()
}

/** A newer version exists and is waiting for the user's yes. NOTHING has been fetched yet. */
export function setAvailable(v: string): void {
  pendingVersion = v
  if (inProgress()) return
  phase = 'available'
  progress = null
  lastError = null
  notify()
}

export function setDownloading(p: UpdateDownloadProgress): void {
  phase = 'downloading'
  progress = p
  lastError = null
  notify()
}

/** Downloaded, but a terminal is busy — the installer is staged and waits for everything to go idle. */
export function setReady(v: string): void {
  pendingVersion = v
  phase = 'ready'
  progress = null
  lastError = null
  notify()
}

/** The user said yes and the app is handing over to the installer / restarting. */
export function setInstalling(v: string): void {
  pendingVersion = v
  phase = 'installing'
  progress = null
  lastError = null
  notify()
}

/** Up to date — the check ran and there is nothing to do. */
export function setIdle(): void {
  if (inProgress()) return
  phase = 'idle'
  progress = null
  pendingVersion = null
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
    // Live, not a snapshot — a dialog opened from the chip (no prompt behind it) must warn about the
    // terminals a restart would close, exactly as the offer does.
    busy: allTabsIdle() ? null : buildSessionList(),
    lastError,
    lastCheckAt,
    lastCheckOutcome,
    pendingVersion,
    snoozedUntil,
  }
}
