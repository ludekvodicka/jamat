/**
 * Decide what to do with the diff mode when a fresh `getFileDiffOptions`
 * result lands. Extracted from FileViewerPanel as a pure function so the
 * "late IPC must not clobber the user's pick" guard is unit-testable
 * without mounting the whole panel.
 *
 * - `'initial'` — the tab was opened with an explicit `initialDiffMode`
 *   (e.g. from RecentFiles "open with diff"); it wins on first options.
 * - `'default'` — no explicit initial mode and the user hasn't picked yet
 *   → take the backend's smart default.
 * - `'keep'`   — the user already picked a mode; a late/slow options
 *   resolve must NOT overwrite it.
 */
export type DiffModeDecision = 'initial' | 'default' | 'keep'

export function resolveDiffModeOnOptions(
  hasInitialDiffMode: boolean,
  userPicked: boolean,
): DiffModeDecision {
  if (hasInitialDiffMode) return 'initial'
  if (!userPicked) return 'default'
  return 'keep'
}
