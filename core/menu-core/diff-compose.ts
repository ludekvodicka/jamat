import type { TurnInfo, EditStep } from '../types/session.js'

/**
 * Pure diff-composition helpers — **no `node:fs`, no I/O**. Safe to import
 * from the Electron renderer as well as the main process.
 *
 * The per-turn composition logic lives here (extracted from
 * `session-changes.ts`) so the renderer can compose a whole-session net diff
 * (`composeFileNetDiff`) without pulling the fs-bound parser into its bundle.
 */

export interface ComposeResult {
  beforeText: string
  afterText: string
  isNewFile: boolean
  isOverwritten: boolean
  /**
   * True when the composition glued together ≥1 disjoint region (a step whose
   * `old_string` was not found in the running `after`). The resulting
   * before/after concatenate far-apart file regions with a single newline, so
   * real line-number anchoring past the first region is unreliable.
   */
  disjoint: boolean
}

function isWriteStep(step: EditStep): boolean {
  return step.tool === 'Write' || (step.tool === 'NotebookEdit' && step.content !== null)
}

/**
 * Synthesize `beforeText` / `afterText` for one file's chain of steps.
 *
 * Strategy (affected-region only, not full file):
 *   - First Edit: before = old_string, after = new_string
 *   - Subsequent Edit: if `after` contains step.old_string, replace it
 *     with step.new_string (respecting `replace_all`). Otherwise treat it as
 *     a disjoint region — append both sides separated by a newline, so the
 *     rendered diff still shows the change.
 *   - Write (first in chain): `before = priorState` (often `''`), `after = content`.
 *     `isOverwritten = true` only when the file was seen in an earlier turn
 *     AND we have no `priorState` to compare against — i.e. the prior content
 *     is genuinely unrecoverable. With a known `priorState`, the Write becomes
 *     a normal whole-file transition.
 *   - Write (mid-chain): `before = after` (preserve prior state from earlier
 *     steps in this same chain), so the diff doesn't collapse to all-`+`.
 *
 * `priorState`, when set, is the file's full content at the start of this
 * chain — supplied by the per-turn caller that tracks running state across
 * turns. With it, a single-Write turn that overwrites an earlier-turn state
 * renders as a real diff instead of "everything new".
 *
 * `seenInEarlierTurn` is independent — it tags the file lifecycle (was it
 * touched before this chain). A file can be seen-earlier without a known
 * priorState (when earlier turns were Edits only and we never saw a Write).
 */
export function composeSteps(
  steps: EditStep[],
  seenInEarlierTurn: boolean,
  priorState: string = '',
): ComposeResult {
  let before = priorState
  let after = priorState
  let hadEdit = false
  let hadWrite = false
  let isNewFile = !seenInEarlierTurn
  let isOverwritten = false
  let disjoint = false

  for (const step of steps) {
    if (isWriteStep(step)) {
      const newContent = step.content ?? ''
      if (!hadEdit && !hadWrite) {
        // First step in chain.
        if (priorState !== '') {
          // Known prior state → Write is a normal whole-file transition.
          // `before`/`after` are already initialized to priorState; the
          // assignment below bumps `after` to the new content.
          isOverwritten = false
          isNewFile = false
        } else if (seenInEarlierTurn) {
          // Earlier turn(s) touched it but we don't have full content
          // (typically because those earlier turns were Edit-only). The
          // prior file state is genuinely unrecoverable from the transcript.
          before = ''
          isOverwritten = true
          isNewFile = false
        } else {
          // First-ever occurrence — potentially a new file (left as-is below).
          before = ''
        }
      } else {
        // Subsequent step in the same chain: promote the prior `after`
        // (whatever earlier Edits/Writes left in there) to `before`, so the
        // Write renders as a real transition instead of collapsing to all-`+`.
        before = after
        isOverwritten = false
      }
      after = newContent
      hadWrite = true
      continue
    }

    // Edit / NotebookEdit (with old_string + new_string)
    const oldStr = step.oldString ?? ''
    const newStr = step.newString ?? ''

    if (!hadEdit && !hadWrite) {
      // Region-scoped: ignore priorState and anchor on the step's own
      // old/new. priorState still matters for a *follow-up* Write in the
      // same chain (handled in the Write branch above).
      before = oldStr
      after = newStr
    } else if (after.includes(oldStr) && oldStr.length > 0) {
      // Use function arg / split-join so `$`, `$&`, `$<name>`, etc. in
      // `newStr` are NOT interpreted as String.replace substitution patterns.
      if (step.replaceAll) {
        after = after.split(oldStr).join(newStr)
      } else {
        after = after.replace(oldStr, () => newStr)
      }
    } else {
      // Disjoint region — append both sides so the diff still surfaces it.
      before = before.length > 0 ? before + '\n' + oldStr : oldStr
      after = after.length > 0 ? after + '\n' + newStr : newStr
      disjoint = true
    }
    hadEdit = true
    isNewFile = false // an Edit can't create a file; only Write can
  }

  return {
    beforeText: before,
    afterText: after,
    // A later Write that follows other steps marks the file as overwritten;
    // in that case it's no longer provably a "new file" creation, even though
    // hadEdit may be false (Write+Write across turns).
    isNewFile: isNewFile && hadWrite && !hadEdit && !seenInEarlierTurn && !isOverwritten,
    isOverwritten,
    disjoint,
  }
}

/**
 * Apply a chain of steps to a running full-file `state`, returning the
 * post-chain state. Used by per-turn callers to thread the file's content
 * across turns so the next turn's Write can produce a real diff.
 *
 * `known` tracks whether `state` reflects a complete file content (true once
 * a Write has been observed) — Edits applied to a `known=false` state stay
 * best-effort and don't promote to known.
 */
export function applyStepsToState(state: string, steps: EditStep[]): { state: string; known: boolean } {
  let s = state
  let known = s !== ''
  for (const step of steps) {
    if (isWriteStep(step)) {
      s = step.content ?? ''
      known = true
      continue
    }
    if (!known) continue // Edits on unknown state can't be applied reliably
    const oldStr = step.oldString ?? ''
    if (!oldStr) continue
    if (step.replaceAll) {
      s = s.split(oldStr).join(step.newString ?? '')
    } else if (s.includes(oldStr)) {
      s = s.replace(oldStr, () => step.newString ?? '')
    }
    // If oldStr isn't in s, we can't anchor the edit — state stays as-is.
  }
  return { state: s, known }
}

/** Net change to one file across every turn of a session. */
export interface FileNetDiff {
  filePath: string
  beforeText: string
  afterText: string
  isNewFile: boolean
  isOverwritten: boolean
  /** See {@link ComposeResult.disjoint} — suppresses real line anchoring. */
  disjoint: boolean
  editCount: number
  turnCount: number
}

/**
 * Canonical key for a file path — forward slashes, lower-cased. Shared so
 * every module that groups edits by file normalizes identically.
 */
export function fileKey(fp: string): string {
  return fp.replace(/\\/g, '/').toLowerCase()
}

/**
 * Compose a single net before/after for one file across all turns it appears
 * in. Steps are flattened in chronological turn order and composed as one
 * chain — the result answers "what did this whole session do to this file".
 * Returns `null` when the file was never edited in the session.
 *
 * Note: edits in different turns usually touch different regions, so the
 * composed chain hits the disjoint-append path and sets `disjoint` — meaning
 * File-history net diffs frequently fall back to relative line numbering.
 */
export function composeFileNetDiff(turns: TurnInfo[], filePath: string): FileNetDiff | null {
  const key = fileKey(filePath)
  const allSteps: EditStep[] = []
  let editCount = 0
  let turnCount = 0
  let canonicalPath = filePath

  for (const turn of turns) {
    for (const edit of turn.files) {
      if (fileKey(edit.filePath) !== key) continue
      allSteps.push(...edit.steps)
      editCount += edit.editCount
      turnCount++
      canonicalPath = edit.filePath
    }
  }

  if (allSteps.length === 0) return null

  // Compose every step across the session as one chain. `isNewFile` /
  // `isOverwritten` are taken straight from the composition — a leading Write
  // followed by Edits cannot be proven to be a create (the prior on-disk
  // content is unrecoverable), so we do not upgrade it to "new file".
  const r = composeSteps(allSteps, false)
  return {
    filePath: canonicalPath,
    beforeText: r.beforeText,
    afterText: r.afterText,
    isNewFile: r.isNewFile,
    isOverwritten: r.isOverwritten,
    disjoint: r.disjoint,
    editCount,
    turnCount,
  }
}

/**
 * Best-effort: find the 1-based line number in `fileContent` where the diff
 * region `afterText` begins. Fingerprints the first few non-empty region
 * lines and looks for that exact consecutive block on disk.
 *
 * Returns `null` when the region cannot be located unambiguously — the file
 * changed since the edit, the region appears more than once, or the content
 * is too short to fingerprint. Callers fall back to relative numbering.
 */
export function locateRegionStartLine(fileContent: string, afterText: string): number | null {
  if (!fileContent || !afterText) return null

  const region = afterText.split('\n')
  let firstNonEmpty = 0
  while (firstNonEmpty < region.length && region[firstNonEmpty].trim() === '') {
    firstNonEmpty++
  }
  if (firstNonEmpty >= region.length) return null

  // Up to 3 consecutive verbatim region lines, starting at the first
  // non-empty one. A 1-line fingerprint is too weak to trust — bail out.
  const window = region.slice(firstNonEmpty, firstNonEmpty + 3)
  if (window.length < 2) return null
  const fileLines = fileContent.split('\n')

  let matchIndex = -1
  let matchCount = 0
  for (let i = 0; i + window.length <= fileLines.length; i++) {
    let ok = true
    for (let j = 0; j < window.length; j++) {
      if (fileLines[i + j] !== window[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      matchCount++
      if (matchCount > 1) return null // ambiguous
      matchIndex = i
    }
  }
  if (matchCount !== 1) return null

  // matchIndex is the first non-empty region line; back up over any leading
  // blank region lines to anchor the region's first line. A negative start
  // means the region's blank prefix cannot fit before the file start — the
  // match is spurious, so bail rather than clamp to a lie.
  const start = matchIndex - firstNonEmpty
  if (start < 0) return null
  return start + 1
}
