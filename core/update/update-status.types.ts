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
 * The order matters: `available` comes BEFORE `downloading`. Nothing is fetched until the user says
 * yes — a background download of a 128 MB installer is not the app's call to make, and downloading
 * first made the dialog appear *after* the work, with the visible wait landing in the wrong place
 * (click → 10–20 s of silence → installer). Now: ask → download with a progress bar → install.
 */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error'

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
