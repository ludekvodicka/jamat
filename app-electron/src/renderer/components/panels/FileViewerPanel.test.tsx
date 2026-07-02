/**
 * Plan 2026-05-27-004 R4 enumerated FOUR target regression tests; this
 * one (FileViewerPanel `userPickedDiffMode` ref guard against late IPC
 * overwrite) was deferred during implementation. The component has
 * many IPC dependencies (getFileDiffOptions, getFileDiffBaseline, file
 * watcher, readFile) and a full mount is heavy.
 *
 * Two viable paths when picking this up:
 *   (a) Stub every IPC method needed, mount FileViewerPanel, simulate
 *       a slow getFileDiffOptions resolve + user click on the selector
 *       + late default arriving — assert user's pick survives.
 *   (b) Extract the override-guard logic into a tiny pure helper
 *       (`shouldApplyDefault(initialDiffMode, userPicked) => boolean`)
 *       and unit-test that. Option (b) is more honest about what's
 *       being tested and survives FileViewerPanel refactors.
 *
 * Tracked in .aidocs/review-todos/013-pending-p1-vitest-coverage-gaps.md (item 2).
 */

import { describe, it } from 'vitest'

describe('FileViewerPanel userPickedDiffMode guard regression', () => {
  it.skip('pending — see .aidocs/review-todos/013-pending-p1-vitest-coverage-gaps.md', () => {
    // Intentionally skipped. See file header.
  })
})
