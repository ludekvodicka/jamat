/**
 * The persistent update log — an append-only JSONL file that SURVIVES the restart an update causes.
 *
 * The app's normal log is an in-memory ring buffer: it dies with the process, i.e. exactly when an
 * update installs or a restart happens, so "why didn't it update?" was unanswerable after the fact.
 * Every decision the update module makes — the boot resolution, each check and its outcome, downloads,
 * a prompt shown OR SUPPRESSED (with the reason: which tabs were busy, snoozed until when), the user's
 * choice, installs, remote triggers — lands here.
 *
 * Pure store: the file path is a PARAMETER (repo rule: core/ takes paths, never resolves them), so the
 * smoke test runs it against a temp file with no electron in sight.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

export type UpdateLogEvent =
  | 'boot-resolution'
  | 'check'
  | 'download-start'
  | 'downloaded'
  | 'prompt-shown'
  | 'prompt-suppressed'
  | 'user-choice'
  | 'install'
  | 'relaunch'
  | 'channel-none'
  | 'remote-trigger'
  | 'error'

export interface UpdateLogEntry {
  ts: number
  event: UpdateLogEvent
  channel?: 'github' | 'source' | 'none'
  trigger?: 'background' | 'manual' | 'remote'
  running?: string
  /** Version discovered (release / disk); `null` = checked, nothing newer. */
  found?: string | null
  /** Resolution reason, or WHY a prompt was suppressed ('idle-gate: 2 busy tabs', 'snoozed until …'). */
  reason?: string
  detail?: string
}

/** Rewrite the file when it grows past this, keeping the newest `KEEP_BYTES` of whole lines. */
const MAX_BYTES = 512 * 1024
const KEEP_BYTES = 256 * 1024

export function appendUpdateLog(filePath: string, entry: Omit<UpdateLogEntry, 'ts'>): void {
  appendFileSync(filePath, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf-8')
  trimIfOversize(filePath)
}

function trimIfOversize(filePath: string): void {
  let size: number
  try { size = statSync(filePath).size } catch { return }
  if (size <= MAX_BYTES) return
  const text = readFileSync(filePath, 'utf-8')
  const tail = text.slice(-KEEP_BYTES)
  // Drop the (probably partial) first line so every retained line stays parseable.
  const firstBreak = tail.indexOf('\n')
  writeFileSync(filePath, firstBreak === -1 ? '' : tail.slice(firstBreak + 1), 'utf-8')
}

/** Newest-last, at most `maxEntries`. Unparseable lines are skipped, never thrown on. */
export function readUpdateLogTail(filePath: string, maxEntries = 200): UpdateLogEntry[] {
  let text: string
  try { text = readFileSync(filePath, 'utf-8') } catch { return [] }
  const entries: UpdateLogEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line) as UpdateLogEntry) } catch { /* torn/partial line */ }
  }
  return entries.slice(-maxEntries)
}
