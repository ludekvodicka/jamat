/**
 * Local-vs-remote data-source seam (Direction #2). One object, two backends — so the EXISTING
 * data panels (FileViewer / SessionChanges / Notes / Ideas) can render either THIS machine's data
 * or a PEER's, by swapping their single fetch point from `window.electronAPI.<x>(…)` to `ds.<x>(…)`.
 *
 *   makeDataSource()        → local: calls the current IPC ops verbatim (byte-identical to today).
 *   makeDataSource(peer)    → remote: routes each call to `remoteOp(peer, 'control:<op>', args)`.
 *
 * The remote arg order mirrors each underlying IPC op exactly, because the peer-side `control:*`
 * wrapper (remote-data-ops.ts) forwards args verbatim to that same op. `unwrap` collapses the
 * `{ok,data}` Result to the value (or throws) so callers — incl. `useIpcQuery` — see the same
 * shape they do locally.
 */

import type { RemotePeer } from '../../../../core/types/remote-control'
import type { TurnInfo, SessionInfo } from '../../../../core/types/session'
import type { DiffOptions, DiffBaseline, DiffMode } from '../../../../core/types'
import type { Idea } from '../../../../core/types/ideas'

/** A recently-modified file entry (mirrors the `file:list-recent` op result). */
export interface RecentFileEntry { path: string; name: string; mtime: number; relative: string }

export interface PanelDataSource {
  /** True for a peer-backed source — panels can show a 🛰 badge / skip local-only affordances. */
  readonly remote: boolean
  readFile(filePath: string): Promise<string | null>
  listRecentFiles(dirPath: string, limit?: number): Promise<RecentFileEntry[]>
  getSessionChanges(projectDir: string, sessionId?: string): Promise<TurnInfo[]>
  listSessions(projectDir: string): Promise<SessionInfo[]>
  getSessionEditFlags(projectDir: string): Promise<Record<string, boolean>>
  getFileDiffOptions(filePath: string, projectDir?: string | null, sessionId?: string | null): Promise<DiffOptions>
  getFileDiffBaseline(filePath: string, mode: DiffMode, projectDir?: string | null, sessionId?: string | null): Promise<DiffBaseline>
  locateRegion(filePath: string, afterText: string): Promise<number | null>
  loadNotes(panelId: string): Promise<string[]>
  saveNotes(panelId: string, entries: string[]): Promise<void>
  loadIdeas(windowId: string): Promise<Idea[]>
  saveIdeas(windowId: string, ideas: Idea[]): Promise<{ ok: boolean; error?: string }>
}

/** Collapse a remoteOp Result to its data, throwing on failure (so useIpcQuery surfaces the error). */
async function unwrap<T>(p: Promise<{ ok: true; data: unknown } | { ok: false; error: string }>): Promise<T> {
  const r = await p
  if (!r.ok) throw new Error(r.error || 'remote op failed')
  return r.data as T
}

function remoteOp(peer: RemotePeer, name: string, args: unknown[]): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const fn = window.electronAPI?.remoteOp
  if (!fn) return Promise.resolve({ ok: false, error: 'remoteOp unavailable' })
  return fn(peer, name, args)
}

/** The local backend — every method is the existing IPC call, unchanged. */
const localSource: PanelDataSource = {
  remote: false,
  readFile: (filePath) => window.electronAPI!.readFile(filePath),
  listRecentFiles: (dirPath, limit) => window.electronAPI!.listRecentFiles(dirPath, limit),
  getSessionChanges: (projectDir, sessionId) => window.electronAPI!.getSessionChanges(projectDir, sessionId),
  listSessions: (projectDir) => window.electronAPI!.listSessions(projectDir),
  getSessionEditFlags: (projectDir) => window.electronAPI!.getSessionEditFlags(projectDir),
  getFileDiffOptions: (filePath, projectDir, sessionId) => window.electronAPI!.getFileDiffOptions(filePath, projectDir, sessionId),
  getFileDiffBaseline: (filePath, mode, projectDir, sessionId) => window.electronAPI!.getFileDiffBaseline(filePath, mode, projectDir, sessionId),
  locateRegion: (filePath, afterText) => window.electronAPI!.locateRegion(filePath, afterText),
  loadNotes: (panelId) => window.electronAPI!.loadNotes(panelId),
  saveNotes: (panelId, entries) => window.electronAPI!.saveNotes(panelId, entries),
  loadIdeas: (windowId) => window.electronAPI!.loadIdeas(windowId),
  saveIdeas: (windowId, ideas) => window.electronAPI!.saveIdeas(windowId, ideas),
}

/** A peer backend — every method re-routes to the peer's matching `control:*` op. */
function remoteSource(peer: RemotePeer): PanelDataSource {
  return {
    remote: true,
    readFile: (filePath) => unwrap(remoteOp(peer, 'control:file-read', [filePath])),
    listRecentFiles: (dirPath, limit) => unwrap(remoteOp(peer, 'control:list-recent', [dirPath, limit])),
    getSessionChanges: (projectDir, sessionId) => unwrap(remoteOp(peer, 'control:session-changes', [projectDir, sessionId])),
    listSessions: (projectDir) => unwrap(remoteOp(peer, 'control:session-list', [projectDir])),
    getSessionEditFlags: (projectDir) => unwrap(remoteOp(peer, 'control:session-edit-flags', [projectDir])),
    getFileDiffOptions: (filePath, projectDir, sessionId) => unwrap(remoteOp(peer, 'control:file-diff-options', [filePath, projectDir ?? null, sessionId ?? null])),
    getFileDiffBaseline: (filePath, mode, projectDir, sessionId) => unwrap(remoteOp(peer, 'control:file-diff-baseline', [filePath, mode, projectDir ?? null, sessionId ?? null])),
    locateRegion: (filePath, afterText) => unwrap(remoteOp(peer, 'control:locate-region', [filePath, afterText])),
    loadNotes: (panelId) => unwrap(remoteOp(peer, 'control:notes-load', [panelId])),
    saveNotes: (panelId, entries) => unwrap(remoteOp(peer, 'control:notes-save', [panelId, entries])),
    loadIdeas: (windowId) => unwrap(remoteOp(peer, 'control:ideas-load', [windowId])),
    saveIdeas: (windowId, ideas) => unwrap(remoteOp(peer, 'control:ideas-save', [windowId, ideas])),
  }
}

/** Build the data source for a panel. No peer → local (today's behavior); a peer → that peer's data. */
export function makeDataSource(peer?: RemotePeer | null): PanelDataSource {
  return peer ? remoteSource(peer) : localSource
}
