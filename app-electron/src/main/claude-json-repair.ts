/**
 * Detect + (safely) repair a corrupt `~/.claude.json` BEFORE any Claude session is launched.
 *
 * The corruption this app can cause is an INTERRUPTED IN-PLACE WRITE: `claude` rewrites the file
 * from byte 0 with newer (often shorter) content, but is hard-killed before it truncates the old
 * longer tail — leaving a complete JSON object followed by stale leftover bytes ("additional text
 * after JSON"). Claude Code then rejects the file, snapshots it as `.claude.json.corrupted.*`, and
 * recovers from a backup — i.e. the whole app starts and then thrashes its state on launch.
 *
 * We pre-empt that: at startup, if the file is corrupt AND its leading top-level object parses on its
 * own, we truncate the trailing garbage (keeping the NEWEST write) and write it back atomically,
 * backing the corrupt original up first. ANY OTHER corruption shape is left untouched for Claude
 * Code's own recovery — we never guess-repair a file we don't own.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logInfo, logError } from './logger'

/** Index of the matching close-brace of the FIRST top-level `{…}` object (string/escape aware), or -1. */
function rootObjectEnd(raw: string): number {
  let depth = 0
  let inStr = false
  let esc = false
  let started = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { if (inStr) esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') { depth++; started = true }
    else if (c === '}') { depth--; if (started && depth === 0) return i }
  }
  return -1
}

/** Best-effort, runs once at startup. Never throws. */
export function repairClaudeJsonIfCorrupt(): void {
  const file = join(homedir(), '.claude.json')
  let raw: string
  try { raw = readFileSync(file, 'utf-8') } catch { return } // missing/unreadable → nothing to do
  try { JSON.parse(raw); return } catch { /* corrupt — try the safe truncate repair below */ }

  const end = rootObjectEnd(raw)
  if (end > 0 && end < raw.length - 1) {
    const prefix = raw.slice(0, end + 1)
    let prefixValid = false
    try { JSON.parse(prefix); prefixValid = true } catch { /* leading object isn't valid on its own */ }
    if (prefixValid) {
      const trailing = raw.length - prefix.length
      try {
        // Preserve the corrupt original next to Claude Code's own backups (not in the home root).
        const backupDir = join(homedir(), '.claude', 'backups')
        mkdirSync(backupDir, { recursive: true })
        copyFileSync(file, join(backupDir, `.claude.json.jamat-prerepair.${Date.now()}`))
        const tmp = `${file}.jamat.tmp`
        writeFileSync(tmp, prefix, 'utf-8')
        renameSync(tmp, file)
        logInfo('claude-json-repair', `repaired ~/.claude.json — truncated ${trailing} trailing bytes after the root object`)
      } catch (e) {
        logError('claude-json-repair', `repair write failed: ${String((e as Error)?.message ?? e)}`)
      }
      return
    }
  }
  logError('claude-json-repair', '~/.claude.json is corrupt but not safely auto-repairable (unknown shape) — leaving Claude Code to recover')
}
