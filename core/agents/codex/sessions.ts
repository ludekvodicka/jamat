/**
 * Codex session discovery — the date-tree analog of Claude's per-project-dir
 * `sessions.ts`. Codex stores sessions as
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`, keyed by DATE,
 * with the project dir living in the `session_meta` header's `cwd` field (NOT
 * in the path). So "sessions for this project" means: walk the date tree, read
 * each header's `cwd`, and group by it.
 *
 * Cheap by construction (verified against codex-cli 0.144.1, see `README.md`):
 *  - `sessionId` + `createdAt` come from the FILENAME — no file read.
 *  - `lastActivity` = file mtime — a stat, no read.
 *  - only `cwd` needs a read, and it sits at the very front of the header line,
 *    so a bounded 16 KB prefix + regex avoids parsing the ~8 KB base-instructions.
 *
 * The index is built once per process (short-lived CLI menu) and dropped on
 * `invalidateCodexIndex()`. Cold-start is bounded to a trailing day window so a
 * heavy user's 25k-file history doesn't stall the first menu open. A persistent
 * cross-process cache is a possible future optimization (see README).
 */

import { closeSync, openSync, readdirSync, readSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SessionInfo, LatestSessionMeta } from '../../types/session.js'

/** Only index sessions from the last N days — bounds cold-start on large histories. */
const SCAN_WINDOW_DAYS = 90
const HEADER_READ_BYTES = 16384
const PREVIEW_MAX_LINES = 8

/** `rollout-2026-07-10T14-19-12-019f4bf7-b5d8-74b0-9175-a5a5938a4082.jsonl` */
const ROLLOUT_RE =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

interface CodexSessionMeta {
  sessionId: string
  file: string
  cwd: string
  createdAtMs: number
  mtimeMs: number
}

/**
 * Normalize a path for cwd matching: forward slashes, no trailing slash,
 * lowercased (Windows is case-insensitive). NOTE: an 8.3 short-name cwd
 * (`C:/users/jane~1.doe/...`) will not fold to its long form — sessions Codex
 * recorded under a short name may not match a long-name project dir. Sessions
 * launched from our menu carry the real long-form dir, so those always match.
 */
function normalizeCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function codexSessionsRoot(homeDir: string): string {
  return join(homeDir, '.codex', 'sessions')
}

/** Read only the header's `cwd` from the first bytes of a rollout (no full parse). */
function readHeaderCwd(file: string): string | null {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return null }
  try {
    const buf = Buffer.alloc(HEADER_READ_BYTES)
    const n = readSync(fd, buf, 0, HEADER_READ_BYTES, 0)
    const head = buf.toString('utf-8', 0, n)
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (!m) return null
    try { return JSON.parse(`"${m[1]}"`) } catch { return null }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

class CodexSessionIndex {
  private byCwd = new Map<string, CodexSessionMeta[]>()
  private byId = new Map<string, CodexSessionMeta>()
  private built = false

  invalidate(): void {
    this.built = false
    this.byCwd.clear()
    this.byId.clear()
  }

  private ensureBuilt(homeDir: string): void {
    if (this.built) return
    this.build(homeDir)
    this.built = true
  }

  private build(homeDir: string): void {
    const root = codexSessionsRoot(homeDir)
    const cutoffMs = Date.now() - SCAN_WINDOW_DAYS * 86_400_000
    for (const dayDir of this.walkDayDirs(root, cutoffMs)) {
      for (const name of safeReaddir(dayDir)) {
        const m = name.match(ROLLOUT_RE)
        if (!m) continue
        const file = join(dayDir, name)
        const cwd = readHeaderCwd(file)
        if (!cwd) continue
        const createdAtMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
        const mtimeMs = safeMtimeMs(file) ?? createdAtMs
        const meta: CodexSessionMeta = { sessionId: m[7], file, cwd, createdAtMs, mtimeMs }
        this.byId.set(meta.sessionId, meta)
        const key = normalizeCwd(cwd)
        const arr = this.byCwd.get(key)
        if (arr) arr.push(meta)
        else this.byCwd.set(key, [meta])
      }
    }
  }

  /** YYYY/MM/DD dirs newer than the cutoff (numeric dirs only). */
  private *walkDayDirs(root: string, cutoffMs: number): Generator<string> {
    for (const y of safeReaddir(root)) {
      if (!/^\d{4}$/.test(y)) continue
      const yDir = join(root, y)
      for (const mo of safeReaddir(yDir)) {
        if (!/^\d{2}$/.test(mo)) continue
        const moDir = join(yDir, mo)
        for (const d of safeReaddir(moDir)) {
          if (!/^\d{2}$/.test(d)) continue
          const dayMs = Date.parse(`${y}-${mo}-${d}T00:00:00`)
          if (Number.isNaN(dayMs) || dayMs < cutoffMs) continue
          yield join(moDir, d)
        }
      }
    }
  }

  sessionsForCwd(homeDir: string, cwd: string): CodexSessionMeta[] {
    this.ensureBuilt(homeDir)
    const arr = this.byCwd.get(normalizeCwd(cwd)) ?? []
    return [...arr].sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  fileForId(homeDir: string, sessionId: string): string | null {
    this.ensureBuilt(homeDir)
    return this.byId.get(sessionId)?.file ?? null
  }
}

const index = new CodexSessionIndex()

export function invalidateCodexIndex(): void {
  index.invalidate()
}

/** Real cwd IS the storage-dir identity for Codex (no path encoding). Null when no sessions. */
export function findCodexProjectDir(projectDir: string, homeDir: string): string | null {
  return index.sessionsForCwd(homeDir, projectDir).length > 0 ? projectDir : null
}

export function listCodexSessionsForProject(projectDir: string, homeDir: string): SessionInfo[] {
  return index.sessionsForCwd(homeDir, projectDir).map((meta) => ({
    sessionId: meta.sessionId,
    slug: null,
    firstUserMessage: readFirstUserMessage(meta.file),
    createdAt: new Date(meta.createdAtMs),
    lastActivity: new Date(meta.mtimeMs),
    // Codex has no live-pid tracking (capabilities.activePids=false) — never flagged active.
    // (Fork IS supported via a launched-session resolver; see resolveCodexLaunchedSession.)
    active: false,
  }))
}

export function buildCodexSessionMetaCache(catPath: string, folderNames: string[]): Map<string, LatestSessionMeta> {
  const home = homedir()
  const out = new Map<string, LatestSessionMeta>()
  for (const folder of folderNames) {
    const metas = index.sessionsForCwd(home, join(catPath, folder))
    if (metas.length === 0) continue
    const latest = metas[0] // sorted newest-first
    out.set(folder, {
      createdAt: new Date(latest.createdAtMs),
      lastActivity: new Date(latest.mtimeMs),
      label: null,
    })
  }
  return out
}

export function findCodexSessionFileById(sessionId: string, homeDir: string): string | null {
  return index.fileForId(homeDir, sessionId)
}

export function resolveCodexActiveSessionFile(projectDir: string, sessionId: string | null, homeDir: string): string | null {
  if (sessionId) return index.fileForId(homeDir, sessionId)
  const metas = index.sessionsForCwd(homeDir, projectDir)
  return metas[0]?.file ?? null
}

/** Day-dirs to scan when hunting a just-created rollout — covers a local/UTC midnight boundary. */
const LAUNCH_SCAN_DAYS = 3
/** Tolerate the poll landing a hair before the rollout's mtime settles / clock skew. */
const LAUNCH_MTIME_SLACK_MS = 3000

/**
 * Resolve the session id a Codex launch in `projectDir` just created — the newest rollout for that
 * cwd whose mtime is at/after `sinceMs` (the launch time). A new `cc` session and a fork both write
 * a fresh rollout NOW; a fork's file carries the fork's OWN new id (not the parent), so persisting
 * it makes a forked tab restart-safe (resume the fork, not re-fork the parent).
 *
 * A FRESH scan of the last few day-dirs — deliberately NOT the process-cached `index`, which was
 * built before this launch and can't see the new file. Cheap: readdir + stat over ~1-3 day-dirs,
 * a header read only on the (usually one) mtime-recent candidate. Null until the file exists, so
 * the caller keeps polling. `ccc` (resume of an OLD session) touches a file outside the scan window
 * → returns null → the tab stays `ccc` and self-heals to "resume --last" on restart.
 */
export function resolveCodexLaunchedSession(projectDir: string, homeDir: string, sinceMs: number): { sessionId: string } | null {
  const root = codexSessionsRoot(homeDir)
  const wantCwd = normalizeCwd(projectDir)
  const floor = sinceMs - LAUNCH_MTIME_SLACK_MS
  let best: { sessionId: string; mtimeMs: number } | null = null

  for (const dayDir of recentDayDirs(root, LAUNCH_SCAN_DAYS)) {
    for (const name of safeReaddir(dayDir)) {
      const m = name.match(ROLLOUT_RE)
      if (!m) continue
      const file = join(dayDir, name)
      const mtimeMs = safeMtimeMs(file)
      if (mtimeMs === null || mtimeMs < floor) continue
      if (best && mtimeMs <= best.mtimeMs) continue // only header-read a new front-runner
      if (normalizeCwd(readHeaderCwd(file) ?? '') !== wantCwd) continue
      best = { sessionId: m[7], mtimeMs }
    }
  }
  return best ? { sessionId: best.sessionId } : null
}

/** The newest `LAUNCH_SCAN_DAYS` YYYY/MM/DD dirs by name (descending), regardless of the 90-day window. */
function recentDayDirs(root: string, limit: number): string[] {
  const days: string[] = []
  for (const y of safeReaddir(root).filter((s) => /^\d{4}$/.test(s)).sort().reverse()) {
    const yDir = join(root, y)
    for (const mo of safeReaddir(yDir).filter((s) => /^\d{2}$/.test(s)).sort().reverse()) {
      const moDir = join(yDir, mo)
      for (const d of safeReaddir(moDir).filter((s) => /^\d{2}$/.test(s)).sort().reverse()) {
        days.push(join(moDir, d))
        if (days.length >= limit) return days
      }
    }
  }
  return days
}

export function loadCodexSessionPreview(_projectDir: string, sessionId: string): string[] {
  const file = index.fileForId(homedir(), sessionId)
  if (!file) return []
  const lines: string[] = []
  for (const rec of iterateRollout(file)) {
    const user = messageText(rec, 'user')
    const text = user && !isInjectedUserContext(user) ? user : messageText(rec, 'assistant')
    if (text) lines.unshift(text) // newest-first, like Claude's preview
    if (lines.length >= PREVIEW_MAX_LINES) break
  }
  return lines
}

// ── record helpers (shared with session-changes.ts via re-export) ──

export interface RolloutRecord {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    role?: string
    content?: { type?: string; text?: string }[]
    changes?: Record<string, { kind?: string } | unknown>
    success?: boolean
    message?: string
  }
}

/** Iterate rollout records, skipping unparseable lines (tolerant of schema churn). */
export function* iterateRollout(file: string): Generator<RolloutRecord> {
  let text: string
  try { text = readFileSync(file, 'utf-8') } catch { return }
  for (const line of text.split('\n')) {
    if (!line) continue
    try { yield JSON.parse(line) as RolloutRecord } catch { /* skip bad line */ }
  }
}

/** Extract the text of a `response_item` message with the given role, or null. */
export function messageText(rec: RolloutRecord, role: 'user' | 'assistant'): string | null {
  if (rec.type !== 'response_item' || rec.payload?.type !== 'message' || rec.payload.role !== role) return null
  const text = (rec.payload.content ?? [])
    .map((c) => c.text ?? '')
    .join('')
    .trim()
  return text || null
}

/**
 * Codex injects synthetic `user`-role messages at session start — an
 * `<environment_context>` block (cwd/os) and `<user_instructions>`. They are
 * NOT the user's prompt, so they must not become the row label or a turn.
 */
export function isInjectedUserContext(text: string): boolean {
  return /^<(environment_context|user_instructions)\b/i.test(text.trimStart())
}

function readFirstUserMessage(file: string): string | null {
  let fallback: string | null = null
  for (const rec of iterateRollout(file)) {
    const t = messageText(rec, 'user')
    if (!t) continue
    if (isInjectedUserContext(t)) { fallback ??= t; continue }
    return t
  }
  return fallback
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function safeMtimeMs(p: string): number | null {
  try { return statSync(p).mtimeMs } catch { return null }
}
