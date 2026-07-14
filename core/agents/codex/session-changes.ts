/**
 * Codex transcript parsing — the analog of Claude's `session-changes.ts`.
 * Codex's file edits are cleaner to detect than Claude's: every applied patch
 * emits an `event_msg` with `payload.type === 'patch_apply_end'` carrying
 * `changes: { "<abs-path>": {kind} }` and `success` (verified 0.144.1, see
 * README). So edited-file extraction reads those events directly rather than
 * reconstructing edits from tool inputs.
 *
 * `extractCodexTurns` returns structurally-valid `TurnInfo`s (user prompt +
 * timestamp + the files that turn touched) but WITHOUT the line-level
 * before/after diff bodies Claude synthesizes from Edit oldString/newString —
 * Codex ships `apply_patch` envelopes, not region replacements, so the
 * SessionChanges diff view degrades to "which files changed" for now. The
 * before/after reconstruction is a documented follow-up.
 */

import type { TurnInfo, FileTurnEdit } from '../../types/session.js'
import { iterateRollout, messageText, isInjectedUserContext } from './sessions.js'

const PROMPT_TRUNCATE_LEN = 80

/** Absolute file paths changed by a session, unique, in first-seen order. */
export function extractCodexEditedFiles(file: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of iterateChangedPaths(file)) {
    const key = normalizePathKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

/** Whether the session applied any successful file patch. */
export function extractCodexHasEdits(file: string): boolean {
  for (const _ of iterateChangedPaths(file)) return true
  return false
}

/** Per-turn view: user prompt + the files that turn changed (no diff bodies — see file header). */
export function extractCodexTurns(file: string): TurnInfo[] {
  const turns: TurnInfo[] = []
  let current: TurnInfo | null = null
  let currentFiles = new Map<string, FileTurnEdit>()

  const finalize = (): void => {
    if (!current) return
    current.files = [...currentFiles.values()]
    turns.push(current)
  }

  for (const rec of iterateRollout(file)) {
    const userText = messageText(rec, 'user')
    if (userText !== null && !isInjectedUserContext(userText)) {
      finalize()
      current = {
        turnIndex: turns.length,
        timestampISO: rec.timestamp ?? null,
        userPromptText: userText,
        userPromptTextShort: userText.length > PROMPT_TRUNCATE_LEN ? userText.slice(0, PROMPT_TRUNCATE_LEN) + '…' : userText,
        files: [],
      }
      currentFiles = new Map()
      continue
    }
    if (!isSuccessfulPatch(rec) || !current) continue
    const changes = rec.payload?.changes ?? {}
    for (const [path, meta] of Object.entries(changes)) {
      const key = normalizePathKey(path)
      const existing = currentFiles.get(key)
      if (existing) { existing.editCount++; continue }
      const kind = (meta as { kind?: string } | undefined)?.kind
      currentFiles.set(key, {
        filePath: path,
        editCount: 1,
        isNewFile: kind === 'add',
        isOverwritten: false,
        beforeText: '',
        afterText: '',
        steps: [],
        disjoint: false,
      })
    }
  }
  finalize()
  return turns
}

function* iterateChangedPaths(file: string): Generator<string> {
  for (const rec of iterateRollout(file)) {
    if (!isSuccessfulPatch(rec)) continue
    for (const path of Object.keys(rec.payload?.changes ?? {})) yield path
  }
}

function isSuccessfulPatch(rec: { type?: string; payload?: { type?: string; success?: boolean; changes?: unknown } }): boolean {
  return (
    rec.type === 'event_msg' &&
    rec.payload?.type === 'patch_apply_end' &&
    rec.payload.success === true &&
    !!rec.payload.changes
  )
}

function normalizePathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}
