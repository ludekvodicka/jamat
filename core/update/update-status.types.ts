/**
 * The update module's live status — the wire shape shared by main (`debug:info.update`,
 * `update:status`), the preload bridge and the Settings panel. Lives in core/ so nothing under
 * app-electron/ has to be imported across the app boundary.
 */
import type { UpdateChannel } from './update-channel.js'

/**
 * What the update module is doing RIGHT NOW — the status bar and the update dialog render this
 * directly, so every state a user can sit in must be nameable.
 *
 * `available` precedes `downloading`: nothing is fetched before the user says yes. `ready` is the
 * downloaded-but-waiting state — a download can take minutes, so the app re-checks that no terminal is
 * busy before it quits, even though the user already consented (see the update-module ADR).
 */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'

export interface UpdateDownloadProgress {
  version: string
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** The offer, rendered as the in-app update dialog (the native message box is the fallback). */
export interface UpdatePrompt {
  channel: 'github' | 'source'
  version: string
  running: string
  /** 'Download & install' (github — the download starts on this click) / 'Restart now' (source). */
  actionLabel: string
  /** The terminals a restart would close, when some are still working; null = everything is idle. */
  busy: string | null
}

/** What the user picked in the dialog. */
export type UpdateChoice =
  | { kind: 'action' }
  | { kind: 'snooze'; hours: number }

export interface UpdateStatus {
  channel: UpdateChannel
  /** Why THIS channel — the resolution is never silent. */
  reason: string
  /** Deprecated `selfUpdate` keys found in the config (ignored, but surfaced). */
  warnings: string[]
  autoCheck: boolean
  checkIntervalMinutes: number
  running: string
  phase: UpdatePhase
  /** Live download progress while `phase === 'downloading'`; null otherwise. */
  progress: UpdateDownloadProgress | null
  /** The terminals a restart would close, when some are still working; null = everything is idle.
   *  Carried in the status (not only in the prompt) so a dialog opened from the chip warns too. */
  busy: string | null
  /** The last check/download failure. Cleared by the next successful step. */
  lastError: string | null
  /** Epoch ms of the last check (any trigger); null = none yet. */
  lastCheckAt: number | null
  lastCheckOutcome: string | null
  /** The newer version this build knows about — offered, downloading, or installing. */
  pendingVersion: string | null
  /** Epoch ms until which the prompt is snoozed (0 = not snoozed). */
  snoozedUntil: number
}
