/**
 * The update module's live status — the wire shape shared by main (`debug:info.update`,
 * `update:status`), the preload bridge and the Settings panel. Lives in core/ so nothing under
 * app-electron/ has to be imported across the app boundary.
 */
import type { UpdateChannel } from './update-channel.js'

/**
 * What the update module is doing RIGHT NOW — the status bar renders this directly, so every state a
 * user can sit in must be nameable. `error` is one of them on purpose: a failed download used to be
 * invisible (a 404 on a mis-named release asset looked exactly like "nothing happened").
 */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export interface UpdateDownloadProgress {
  version: string
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

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
  /** A newer version known/downloaded and waiting for a restart (`phase === 'ready'`). */
  pendingVersion: string | null
  /** Epoch ms until which the prompt is snoozed (0 = not snoozed). */
  snoozedUntil: number
}
