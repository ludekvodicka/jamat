/**
 * The update module's live status — the wire shape shared by main (`debug:info.update`,
 * `update:status`), the preload bridge and the Settings panel. Lives in core/ so nothing under
 * app-electron/ has to be imported across the app boundary.
 */
import type { UpdateChannel } from './update-channel.js'

export interface UpdateStatus {
  channel: UpdateChannel
  /** Why THIS channel — the resolution is never silent. */
  reason: string
  /** Deprecated `selfUpdate` keys found in the config (ignored, but surfaced). */
  warnings: string[]
  autoCheck: boolean
  checkIntervalMinutes: number
  running: string
  /** Epoch ms of the last check (any trigger); null = none yet. */
  lastCheckAt: number | null
  lastCheckOutcome: string | null
  /** A newer version known/downloaded and waiting for a restart. */
  pendingVersion: string | null
  /** Epoch ms until which the prompt is snoozed (0 = not snoozed). */
  snoozedUntil: number
}
