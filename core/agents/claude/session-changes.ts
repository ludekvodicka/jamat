import { readFileSync, statSync } from 'fs'
import type { TurnInfo, FileTurnEdit, EditStep } from '../../types/session.js'
import { extractUserText } from './sessions.js'
import { applyStepsToState, composeSteps, fileKey } from '../../menu-core/diff-compose.js'
import { ClaudeSessionChangeConst } from './sessionChangeConst.js'

const PROMPT_TRUNCATE_LEN = 80

const turnsCache = new Map<
  string,
  { mtimeMs: number; size: number; turns: TurnInfo[] }
>()

/**
 * Parse a Claude Code .jsonl transcript into per-turn aggregated edits.
 *
 * Turn boundary: a JSONL line with `type === "user"` starts a new turn.
 * Anything before the first user message (system preamble, sidechain meta)
 * is ignored.
 *
 * For each turn we collect every Edit/Write/NotebookEdit `tool_use` from
 * the assistant's response and group it by `input.file_path`. For each
 * file we synthesize a single `beforeText` → `afterText` pair covering
 * the affected region (see {@link composeAggregatedDiff}), suitable for
 * line-level diff rendering.
 *
 * Cached per `jsonlPath`, invalidated on file mtime/size change — mirrors
 * the {@link extractSessionEditedFiles} pattern.
 */
export function extractSessionTurns(jsonlPath: string): TurnInfo[] {
  let st: { mtimeMs: number; size: number }
  try {
    const s = statSync(jsonlPath)
    st = { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return []
  }
  const cached = turnsCache.get(jsonlPath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.turns
  }

  let content: string
  try {
    content = readFileSync(jsonlPath, 'utf-8')
  } catch {
    return []
  }

  const turns: TurnInfo[] = []
  let currentTurn: TurnInfo | null = null
  // file_path (lowercased, forward-slash) → FileTurnEdit within current turn
  let currentFiles: Map<string, FileTurnEdit> = new Map()
  // file_path → true if this file already had an edit in *any earlier* turn
  const seenFilesAcrossSession = new Set<string>()

  const finalizeTurn = () => {
    if (!currentTurn) return
    currentTurn.files = [...currentFiles.values()]
    turns.push(currentTurn)
  }

  for (const line of content.split('\n')) {
    if (!line) continue
    let obj: {
      type?: string
      timestamp?: string
      message?: { content?: unknown; role?: string }
    }
    try {
      obj = JSON.parse(line)
    } catch {
      // Partial last line (transcript being written) or malformed entry — skip.
      continue
    }

    if (obj.type === 'user') {
      // Distinguish a real user prompt (has text) from a continuation
      // message that only carries tool_result blocks. Claude Code emits
      // a "user" line after every assistant tool_use to feed the result
      // back — those are not new commands and should fold into the
      // current turn, not start a new one.
      const text = extractUserText(obj.message?.content)
      if (text === null) continue
      finalizeTurn()
      currentTurn = {
        turnIndex: turns.length,
        timestampISO: typeof obj.timestamp === 'string' ? obj.timestamp : null,
        userPromptText: text,
        userPromptTextShort: truncatePrompt(text, PROMPT_TRUNCATE_LEN),
        files: [],
      }
      currentFiles = new Map()
      continue
    }

    if (obj.type !== 'assistant' || !currentTurn) continue
    const items = obj.message?.content
    if (!Array.isArray(items)) continue

    for (const it of items as Array<{
      type?: string
      name?: string
      input?: {
        file_path?: string
        old_string?: string
        new_string?: string
        content?: string
        replace_all?: boolean
      }
    }>) {
      if (it?.type !== 'tool_use') continue
      const toolName = it.name
      if (!toolName || !ClaudeSessionChangeConst.editedFileTools.has(toolName)) continue
      const fp = it.input?.file_path
      if (typeof fp !== 'string') continue

      const key = fileKey(fp)
      const step: EditStep = {
        tool: toolName as EditStep['tool'],
        oldString: typeof it.input?.old_string === 'string' ? it.input.old_string : null,
        newString: typeof it.input?.new_string === 'string' ? it.input.new_string : null,
        content: typeof it.input?.content === 'string' ? it.input.content : null,
        replaceAll: it.input?.replace_all === true,
      }

      let edit = currentFiles.get(key)
      if (!edit) {
        edit = {
          filePath: fp,
          editCount: 0,
          isNewFile: false,
          isOverwritten: false,
          beforeText: '',
          afterText: '',
          steps: [],
          disjoint: false,
        }
        currentFiles.set(key, edit)
      }
      edit.steps.push(step)
      edit.editCount = edit.steps.length
    }
  }

  finalizeTurn()

  // Second pass: compose before/after per file per turn, and flag
  // new-file / overwritten using cross-turn visibility. We also thread a
  // running full-file `state` per file through the turns — once a Write
  // establishes the full content, later turns' Writes can render as a
  // real diff against the previous state instead of collapsing to all-`+`
  // (the "overwritten — prior content unavailable" fallback).
  const runningStatePerFile = new Map<string, string>()
  for (const turn of turns) {
    for (const edit of turn.files) {
      const key = fileKey(edit.filePath)
      const seenBefore = seenFilesAcrossSession.has(key)
      const priorState = runningStatePerFile.get(key) ?? ''
      composeAggregatedDiff(edit, seenBefore, priorState)
      seenFilesAcrossSession.add(key)
      // Advance the running state by applying this turn's steps so the
      // next turn can compare against the post-turn state. Edits on an
      // unknown (empty) state are skipped — a Write must establish a
      // baseline before Edits can be tracked usefully.
      const next = applyStepsToState(priorState, edit.steps)
      if (next.known) runningStatePerFile.set(key, next.state)
    }
  }

  turnsCache.set(jsonlPath, { ...st, turns })
  return turns
}

/**
 * Synthesize `beforeText` / `afterText` for one file's chain of steps in
 * one turn. Mutates `edit` in place. The composition itself is the pure
 * {@link composeSteps} helper (shared with the renderer's whole-session
 * net diff); this wrapper just writes the result back onto the turn edit.
 */
function composeAggregatedDiff(
  edit: FileTurnEdit,
  seenInEarlierTurn: boolean,
  priorState: string,
): void {
  const r = composeSteps(edit.steps, seenInEarlierTurn, priorState)
  edit.beforeText = r.beforeText
  edit.afterText = r.afterText
  edit.isNewFile = r.isNewFile
  edit.isOverwritten = r.isOverwritten
  edit.disjoint = r.disjoint
}

function truncatePrompt(text: string, maxLen: number): string {
  // Strip Claude Code's `[Image #N]` paste placeholders so they don't show as
  // leading clutter (e.g. " co mam nastavit") after whitespace collapse.
  const oneLine = text.replace(/\[Image\s*#?\d+\]/g, '').replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen - 1) + '…'
}

const hasEditsCache = new Map<
  string,
  { mtimeMs: number; size: number; hasEdits: boolean }
>()

/**
 * Test-only: drop both cached parse results. Production code should rely
 * on mtime+size invalidation.
 */
export function _resetSessionTurnsCacheForTests(): void {
  turnsCache.clear()
  hasEditsCache.clear()
}

/**
 * Lightweight scan: does this session have at least one Edit/Write/
 * NotebookEdit `tool_use` that would be reported by {@link extractSessionTurns}?
 * Streams the JSONL line-by-line and short-circuits on the first qualifying
 * match. Used by the file-changes panel to filter conversation-only sessions
 * out of the picker.
 *
 * Critically, the same turn-start gating as `extractSessionTurns` applies:
 * tool_use entries are only counted **after** the first real user prompt.
 * Without this gate, sidechain or pre-user assistant entries would falsely
 * mark a session as having edits even though the panel itself shows none.
 */
export function extractSessionHasEdits(jsonlPath: string): boolean {
  let st: { mtimeMs: number; size: number }
  try {
    const s = statSync(jsonlPath)
    st = { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return false
  }
  const cached = hasEditsCache.get(jsonlPath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.hasEdits
  }

  let content: string
  try {
    content = readFileSync(jsonlPath, 'utf-8')
  } catch {
    return false
  }

  let started = false
  let hasEdits = false
  for (const line of content.split('\n')) {
    if (!line) continue
    let obj: { type?: string; message?: { content?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type === 'user') {
      // Same rule as extractSessionTurns: a `user` line counts as a real
      // prompt only when it carries actual text — tool_result continuation
      // messages don't start a turn.
      if (extractUserText(obj.message?.content) !== null) started = true
      continue
    }
    if (!started || obj.type !== 'assistant') continue
    const items = obj.message?.content
    if (!Array.isArray(items)) continue
    for (const it of items as Array<{ type?: string; name?: string }>) {
      if (it?.type === 'tool_use' && it.name && ClaudeSessionChangeConst.editedFileTools.has(it.name)) {
        hasEdits = true
        break
      }
    }
    if (hasEdits) break
  }
  hasEditsCache.set(jsonlPath, { ...st, hasEdits })
  return hasEdits
}
