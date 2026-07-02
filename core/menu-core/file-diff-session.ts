/**
 * Whole-file before/after for the FileViewer inline-diff feature, derived
 * from a session's JSONL transcript.
 *
 * Strategy: the existing `composeSteps` / `composeFileNetDiff` helpers
 * produce a **region-scoped** before/after — small `oldString`/`newString`
 * snippets, not full files. To render a whole-file diff in the FileViewer
 * we anchor the region into the current on-disk content:
 *
 *   wholeBefore = currentDiskContent.replace(regionAfter, regionBefore)
 *
 * Single, non-global replace. When `regionAfter` is not present verbatim
 * (file edited outside the session — Bash, IDE, format-on-save) or when
 * the composition glued together disjoint regions, the anchor fails and
 * we fall back to a **region-only** result: the renderer shows just the
 * hunk with a "region only — file diverged" tag.
 *
 * Pure — no fs, no IPC. Caller passes `currentDiskContent` directly.
 */

import { composeFileNetDiff, composeSteps, fileKey } from './diff-compose.js'
import type { EditStep, FileTurnEdit, TurnInfo } from '../types/session.js'
import type { SessionBaselineResult, SessionPoint } from '../types/file-diff.js'

/**
 * Normalize CRLF/CR to LF. Substitution is byte-level (`indexOf` / `slice`),
 * so mixed line endings between the JSONL-derived region and the disk content
 * would cause every anchor lookup to fail. Normalizing both sides up-front
 * sidesteps that — the caller can pass either CRLF or LF and the result is
 * consistent.
 */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function pickTurnsForFile(turns: TurnInfo[], filePath: string): { turn: TurnInfo; edit: FileTurnEdit }[] {
  const key = fileKey(filePath)
  const out: { turn: TurnInfo; edit: FileTurnEdit }[] = []
  for (const turn of turns) {
    for (const edit of turn.files) {
      if (fileKey(edit.filePath) === key) out.push({ turn, edit })
    }
  }
  return out
}

/**
 * Public so the renderer can run the same substitution on the SessionChanges
 * "Full file" toggle without re-implementing the algorithm. Returns the
 * substituted whole-file before/after on success, or a region-only fallback
 * with a reason string when the anchor cannot be placed.
 */
export function substituteOrFallback(
  currentDiskContent: string,
  regionBefore: string,
  regionAfter: string,
  disjoint: boolean,
): SessionBaselineResult {
  // Anchor lookup is byte-level — normalize both sides so a CRLF disk and
  // an LF region (or vice versa) don't fail the substitution.
  const disk = normalizeNewlines(currentDiskContent)
  const rBefore = normalizeNewlines(regionBefore)
  const rAfter = normalizeNewlines(regionAfter)

  if (disjoint) {
    return {
      beforeText: rBefore,
      afterText: rAfter,
      isRegionOnly: true,
      regionOnlyReason: 'disjoint composition — multiple non-adjacent regions',
      regionBefore: rBefore,
      regionAfter: rAfter,
      disjoint: true,
    }
  }
  if (!rAfter) {
    return {
      beforeText: rBefore,
      afterText: rAfter,
      isRegionOnly: true,
      regionOnlyReason: 'composed region is empty',
      regionBefore: rBefore,
      regionAfter: rAfter,
      disjoint: false,
    }
  }
  const idx = disk.indexOf(rAfter)
  if (idx < 0) {
    return {
      beforeText: rBefore,
      afterText: rAfter,
      isRegionOnly: true,
      regionOnlyReason: 'file diverged from session — region not found in current content',
      regionBefore: rBefore,
      regionAfter: rAfter,
      disjoint: false,
    }
  }
  const wholeBefore = disk.slice(0, idx) + rBefore + disk.slice(idx + rAfter.length)
  return {
    beforeText: wholeBefore,
    afterText: disk,
    isRegionOnly: false,
    regionBefore: rBefore,
    regionAfter: rAfter,
    disjoint: false,
  }
}

/**
 * Build a whole-file before/after for `filePath` against the chosen session
 * `point`. Returns `null` when the session never touched the file.
 *
 * `currentDiskContent` is the disk text right now — we anchor the
 * region-scoped composition into it via substitution.
 */
export function composeFileBaselineFromSession(
  turns: TurnInfo[],
  filePath: string,
  point: SessionPoint,
  currentDiskContent: string,
): SessionBaselineResult | null {
  const hits = pickTurnsForFile(turns, filePath)
  if (hits.length === 0) return null

  if (point.kind === 'session-start') {
    const net = composeFileNetDiff(turns, filePath)
    if (!net) return null
    return substituteOrFallback(currentDiskContent, net.beforeText, net.afterText, net.disjoint)
  }

  if (point.kind === 'last-turn') {
    const last = hits[hits.length - 1]
    return substituteOrFallback(
      currentDiskContent,
      last.edit.beforeText,
      last.edit.afterText,
      last.edit.disjoint,
    )
  }

  if (point.kind === 'turn-back') {
    const n = Math.max(1, Math.floor(point.n))
    // Take the last N hits (in chronological order) and compose their steps
    // as one chain — covers "last 2 turns", "last 3 turns" etc.
    const window = hits.slice(Math.max(0, hits.length - n))
    const steps: EditStep[] = []
    for (const h of window) steps.push(...h.edit.steps)
    if (steps.length === 0) return null
    // `seenInEarlierTurn = true` when there are turns BEFORE the window —
    // a Write at the start of the window would otherwise be marked as a
    // brand-new file, which is wrong.
    const seenEarlier = hits.length > window.length
    const r = composeSteps(steps, seenEarlier)
    return substituteOrFallback(currentDiskContent, r.beforeText, r.afterText, r.disjoint)
  }

  // Exhaustiveness guard: a new SessionPoint variant becomes a compile
  // error here instead of silently returning null (a fake "no edits").
  return assertNever(point)
}

function assertNever(x: never): never {
  throw new Error(`unreachable SessionPoint: ${JSON.stringify(x)}`)
}

/**
 * Quick check: did any turn in this session edit the given file? Used by the
 * IPC handler to decide whether session-* options should be enabled in the
 * selector.
 */
export function sessionHasEditsForFile(turns: TurnInfo[], filePath: string): boolean {
  const key = fileKey(filePath)
  for (const t of turns) {
    for (const e of t.files) {
      if (fileKey(e.filePath) === key) return true
    }
  }
  return false
}

/**
 * Count of turns in this session that touched the given file. Used to cap
 * the "Since N turns ago" selector options sensibly (don't offer N > count).
 */
export function turnCountForFile(turns: TurnInfo[], filePath: string): number {
  return pickTurnsForFile(turns, filePath).length
}
