/**
 * Unified, versioned, crash-safe app-state store — the SINGLE source of truth for everything the
 * Electron app exclusively owns and restores on launch: the window list, window groups, the
 * per-window dockview tab layouts, and per-project notes. One file, written ONLY by main.
 *
 * Why this exists (data-loss incident 2026-06-11): the tab history lived in N separate
 * `layouts/layout-<id>.json` files written by the RENDERER. A failed/empty restore could silently
 * overwrite a rich layout with a 1-tab default, the renderer's async write could truncate on quit,
 * and there were NO backups — so a bad restart permanently destroyed the workspace.
 *
 * The fixes baked in here:
 *  - ONE file `<userData>/app-state.json`, MAIN is the only writer (kills the renderer race AND the
 *    windowId/window-state-vs-layouts mismatch class — windows, groups and layouts are one
 *    consistent document).
 *  - ATOMIC writes (tmp + rename) — a crash mid-write never corrupts the live file.
 *  - ROTATING SNAPSHOTS in `<userData>/snapshots/` taken once per launch (the loaded-good state),
 *    last {@link SNAPSHOT_KEEP} kept. Recovery = restore a snapshot.
 *  - If the live file is unreadable on load, auto-recover from the newest valid snapshot instead of
 *    starting empty.
 *
 * NOT folded in (each for a concrete reason — separate processes / lifecycle, NOT preference):
 *  - `remote-control.json` — also read by the standalone `app-agent` process.
 *  - `menu-prefs.json` / `usage-stats.json` / `stats/` — read/written by `app-cli` / `app-stats`.
 *  - `ideas-*.json` — lives in the SHARED machine dir (dev+prod share it); app-state is dev-split.
 *  - `usage-cache.json` — a regenerable cache (folding it would rewrite this whole file every poll).
 *  - `remote-activity/<day>.jsonl` — an append-only audit log.
 *
 * Reads happen only inside `app.whenReady` / via IPC (never at import time), AFTER `bootstrap-userdata`
 * applied the dev `-debug` userData split.
 */

import { app } from 'electron'
import { join } from 'path'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, rmSync,
} from 'fs'
import { logError } from './logger'
import { getJamatPaths } from './jamat-paths'
import type { WindowStateEntry } from './window-state-manager'
import type { WindowGroup } from './groups-manager'

const SCHEMA_VERSION = 1
const SNAPSHOT_KEEP = 10

export interface AppState {
  schemaVersion: number
  savedAt: number
  /** windowId → window metadata (group, bounds, maximized). Was `window-state.json`. */
  windows: Record<string, WindowStateEntry>
  /** Window groups (named windows). Was `groups.json`. */
  groups: WindowGroup[]
  /** windowId → dockview `toJSON()` object (the tab layout). Was `layouts/layout-<id>.json`. */
  layouts: Record<string, unknown>
  /** sanitized panelId → notes lines. Was `notes/<id>.json`. */
  notes: Record<string, string[]>
  /** First-run onboarding decided? `undefined` = never decided (pre-existing config or a brand-new
   *  install before the decision is made at load); `false` = needs the guided Settings flow;
   *  `true` = done (or a pre-existing user who never needed it). Drives `onboarding:get-state`. */
  onboardingComplete?: boolean
}

function emptyState(): AppState {
  return { schemaVersion: SCHEMA_VERSION, savedAt: Date.now(), windows: {}, groups: [], layouts: {}, notes: {} }
}

function stateFilePath(): string { return getJamatPaths().appState }
function snapshotDirPath(): string { return getJamatPaths().snapshotsDir }

let state: AppState | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Coerce an unknown parsed blob into a well-formed AppState (tolerate missing sections). */
function coerce(raw: unknown): AppState {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const s = emptyState()
  if (o.windows && typeof o.windows === 'object') s.windows = o.windows as AppState['windows']
  if (Array.isArray(o.groups)) s.groups = o.groups as AppState['groups']
  if (o.layouts && typeof o.layouts === 'object') s.layouts = o.layouts as AppState['layouts']
  if (o.notes && typeof o.notes === 'object') s.notes = o.notes as AppState['notes']
  if (typeof o.onboardingComplete === 'boolean') s.onboardingComplete = o.onboardingComplete
  if (typeof o.schemaVersion === 'number') s.schemaVersion = o.schemaVersion
  return s
}

/** Newest readable snapshot (for recovery when the live file is corrupt), or null. */
function newestSnapshot(): AppState | null {
  try {
    const dir = snapshotDirPath()
    if (!existsSync(dir)) return null
    const files = readdirSync(dir).filter((f) => /^app-state-\d+\.json$/.test(f)).sort().reverse()
    for (const f of files) {
      try { return coerce(JSON.parse(readFileSync(join(dir, f), 'utf-8'))) } catch { /* try older */ }
    }
  } catch { /* none */ }
  return null
}

/** Copy the live file into `snapshots/app-state-<savedAt>.json`, pruning to the newest SNAPSHOT_KEEP. */
function snapshotCurrent(): void {
  try {
    const file = stateFilePath()
    if (!existsSync(file)) return
    const dir = snapshotDirPath()
    mkdirSync(dir, { recursive: true })
    const stamp = state?.savedAt ?? Date.now()
    const dst = join(dir, `app-state-${stamp}.json`)
    if (!existsSync(dst)) writeFileSync(dst, readFileSync(file, 'utf-8'), 'utf-8')
    const snaps = readdirSync(dir).filter((f) => /^app-state-\d+\.json$/.test(f)).sort()
    for (const f of snaps.slice(0, Math.max(0, snaps.length - SNAPSHOT_KEEP))) {
      try { unlinkSync(join(dir, f)) } catch { /* best effort */ }
    }
  } catch (e) { logError('app-state', `snapshot failed: ${e instanceof Error ? e.message : String(e)}`) }
}

/** Atomic write of the in-memory state (tmp + rename). */
function writeNow(): void {
  if (!state) return
  try {
    state.savedAt = Date.now()
    const file = stateFilePath()
    mkdirSync(getJamatPaths().configDir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (e) { logError('app-state', `write failed: ${e instanceof Error ? e.message : String(e)}`) }
}

/** Debounced flush — coalesces bursts of section writes (e.g. a layout drag) into one disk write. */
function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { flushTimer = null; writeNow() }, 400)
}

/** Synchronous flush — call on `before-quit` so the final state lands before the process exits. */
export function flushAppStateNow(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  writeNow()
}

/**
 * Load (once) the unified state. On first run with no `app-state.json`, MIGRATE the legacy files
 * in the current userData dir into it (then delete them). If the live file is corrupt, recover from
 * the newest snapshot. Always takes a fresh launch snapshot of the good state.
 */
export function loadAppState(): AppState {
  if (state) return state
  const file = stateFilePath()
  if (existsSync(file)) {
    try {
      state = coerce(JSON.parse(readFileSync(file, 'utf-8')))
      snapshotCurrent()                 // launch recovery point
      archiveLegacyFiles()              // archive any stray legacy files from an interrupted migration
      return state
    } catch (e) {
      logError('app-state', `live file corrupt (${e instanceof Error ? e.message : String(e)}) — recovering from snapshot`)
      const recovered = newestSnapshot()
      state = recovered ?? emptyState()
      writeNow()                        // restore the live file from the snapshot (or a clean empty)
      return state
    }
  }
  // First run on this build → migrate legacy files, or start empty.
  state = migrateLegacy()
  writeNow()
  snapshotCurrent()
  // Only AFTER app-state.json is safely on disk: move the legacy originals into a one-time
  // premigration backup (original format, fully recoverable) — never a blind delete.
  if (existsSync(file)) archiveLegacyFiles()
  return state
}

// ── section accessors (each getter reads memory; each setter mutates + schedules an atomic flush) ──

export function getWindowsState(): Record<string, WindowStateEntry> { return loadAppState().windows }
export function setWindowsState(windows: Record<string, WindowStateEntry>): void {
  loadAppState().windows = windows; scheduleFlush()
}

export function getGroupsState(): WindowGroup[] { return loadAppState().groups }
export function setGroupsState(groups: WindowGroup[]): void { loadAppState().groups = groups; scheduleFlush() }

export function getLayoutState(windowId: string): unknown | undefined { return loadAppState().layouts[windowId] }
export function setLayoutState(windowId: string, layout: unknown): void {
  loadAppState().layouts[windowId] = layout; scheduleFlush()
}
export function deleteLayoutState(windowId: string): void {
  const s = loadAppState()
  if (windowId in s.layouts) { delete s.layouts[windowId]; scheduleFlush() }
}

export function getNotesState(key: string): string[] | undefined { return loadAppState().notes[key] }
export function setNotesState(key: string, entries: string[]): void { loadAppState().notes[key] = entries; scheduleFlush() }

/** True once onboarding is explicitly marked complete. (`undefined` flag → false here.) */
export function getOnboardingComplete(): boolean { return loadAppState().onboardingComplete === true }
/** Whether the first-run decision has been made at all (vs never set). */
export function isOnboardingDecided(): boolean { return typeof loadAppState().onboardingComplete === 'boolean' }
export function setOnboardingComplete(v: boolean): void { loadAppState().onboardingComplete = v; scheduleFlush() }

// ── one-time migration from the legacy per-file layout ──────────────────────────────────────────

/** Build the initial AppState from the legacy files in the current userData dir. Best-effort per
 *  section — a missing/garbled legacy file just leaves that section empty, never aborts. */
function migrateLegacy(): AppState {
  const base = app.getPath('userData')
  const s = emptyState()
  // window-state.json → windows
  try {
    const p = join(base, 'window-state.json')
    if (existsSync(p)) { const v = JSON.parse(readFileSync(p, 'utf-8')); if (v && typeof v === 'object') s.windows = v }
  } catch (e) { logError('app-state', `migrate window-state: ${e instanceof Error ? e.message : String(e)}`) }
  // groups.json → groups
  try {
    const p = join(base, 'groups.json')
    if (existsSync(p)) { const v = JSON.parse(readFileSync(p, 'utf-8')); if (Array.isArray(v)) s.groups = v }
  } catch (e) { logError('app-state', `migrate groups: ${e instanceof Error ? e.message : String(e)}`) }
  // layouts/layout-<id>.json → layouts[id]
  try {
    const dir = join(base, 'layouts')
    if (existsSync(dir)) for (const f of readdirSync(dir)) {
      const m = /^layout-(.+)\.json$/.exec(f)
      if (!m) continue
      try { s.layouts[m[1]] = JSON.parse(readFileSync(join(dir, f), 'utf-8')) } catch { /* skip a bad file */ }
    }
  } catch (e) { logError('app-state', `migrate layouts: ${e instanceof Error ? e.message : String(e)}`) }
  // notes/<key>.json → notes[key]
  try {
    const dir = join(base, 'notes')
    if (existsSync(dir)) for (const f of readdirSync(dir)) {
      const m = /^(.+)\.json$/.exec(f)
      if (!m) continue
      try { const v = JSON.parse(readFileSync(join(dir, f), 'utf-8')); if (Array.isArray(v)) s.notes[m[1]] = v } catch { /* skip */ }
    }
  } catch (e) { logError('app-state', `migrate notes: ${e instanceof Error ? e.message : String(e)}`) }
  const n = Object.keys(s.windows).length + s.groups.length + Object.keys(s.layouts).length
  logError('app-state', `migrated legacy → app-state.json (${Object.keys(s.windows).length} windows, ${s.groups.length} groups, ${Object.keys(s.layouts).length} layouts, ${Object.keys(s.notes).length} notes)`)
  void n
  return s
}

const LEGACY_FILES = ['window-state.json', 'groups.json', 'layouts', 'notes']

/**
 * MOVE the legacy originals (now folded into app-state.json) into a one-time premigration backup
 * under `snapshots/premigration/` — original format, fully recoverable — instead of deleting them.
 * Satisfies "remove the old files from the cluttered dir" AND "keep a versioned backup", and makes
 * the one-time migration safe even against a logic bug in it. Only called once app-state.json exists.
 */
function archiveLegacyFiles(): void {
  const base = app.getPath('userData')
  const backup = join(snapshotDirPath(), 'premigration')
  try { mkdirSync(backup, { recursive: true }) } catch { /* best effort */ }
  for (const rel of LEGACY_FILES) {
    try {
      const src = join(base, rel)
      if (!existsSync(src)) continue
      const dst = join(backup, rel)
      if (existsSync(dst)) { rmSync(src, { recursive: true, force: true }) } // backup already has it → drop the stray
      else renameSync(src, dst)                                              // move original into the backup
    } catch { /* best effort */ }
  }
}
