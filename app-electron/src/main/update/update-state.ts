/**
 * The update module's live status — one record the drivers write and every surface reads (Settings,
 * `debug:info.update`, the manual action). Lives apart from the manager so a driver can report into it
 * without importing the manager back (no cycle).
 *
 * Two resolutions on purpose: the BOOT one (what the running driver actually uses — the background
 * driver is resolved once, so reporting the just-saved config's knobs would be a lie) and a fresh
 * CONFIG view (channel/reason/warnings reflect the config as it is NOW, so a deprecated key the user
 * just removed stops being flagged).
 */
import type { UpdateResolution } from '../../../../core/update/update-channel.js'
import type { UpdateStatus } from '../../../../core/update/update-status.types.js'
import { getAppVersion } from '../app-root'

export type { UpdateStatus }

let boot: UpdateResolution | null = null
let current: UpdateResolution | null = null
let lastCheckAt: number | null = null
let lastCheckOutcome: string | null = null
let pendingVersion: string | null = null
let snoozedUntil = 0

/** Called once at boot — these knobs are what the background driver runs with until a restart. */
export function setBootResolution(res: UpdateResolution): void { boot = res; current = res }
/** Called on every manual action / status read — refreshes the config-derived view. */
export function setCurrentResolution(res: UpdateResolution): void { current = res }
export function setLastCheck(outcome: string): void { lastCheckAt = Date.now(); lastCheckOutcome = outcome }
export function setPendingVersion(v: string | null): void { pendingVersion = v }
export function setSnoozedUntil(ms: number): void { snoozedUntil = ms }
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
    lastCheckAt,
    lastCheckOutcome,
    pendingVersion,
    snoozedUntil,
  }
}
