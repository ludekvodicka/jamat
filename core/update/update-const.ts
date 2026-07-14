/**
 * Update-module constants shared by main and the renderer. `SNOOZE_HOURS` lived in two places (the
 * gate and the dialog); the main process validates the renderer's answer against it, so a drift
 * between the two lists would silently accept an hour count nobody offered.
 */
export const SNOOZE_HOURS = [1, 2, 4, 12] as const

export function isSnoozeHours(hours: unknown): hours is (typeof SNOOZE_HOURS)[number] {
  return typeof hours === 'number' && (SNOOZE_HOURS as readonly number[]).includes(hours)
}
