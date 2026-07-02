import type { DockviewApi, IDockviewPanel } from 'dockview'
import type { Terminal } from '@xterm/xterm'
import type { RemotePeer } from '../../../../core/types/remote-control'

/**
 * Close a tab and, when it was the active one, activate its NEIGHBOR — the next tab in the same
 * group, or the previous tab when closing the last one — instead of dockview's default, which
 * jumps to the group's LAST tab. Closing a background tab leaves the active tab untouched. The
 * neighbor is captured BEFORE removal (the group's panel list shrinks on remove).
 */
export function closePanelActivatingNeighbor(api: DockviewApi, panel: IDockviewPanel): void {
  const wasActive = api.activePanel === panel
  const siblings = panel.group?.panels ?? []
  const idx = siblings.indexOf(panel)
  const neighbor = idx >= 0 ? (siblings[idx + 1] ?? siblings[idx - 1]) : undefined
  api.removePanel(panel)
  if (wasActive && neighbor && api.getPanel(neighbor.id)) neighbor.api.setActive()
}

export function bracketedPaste(terminalId: string, text: string): void {
  if (!text) return
  window.electronAPI.writeTerminal(terminalId, `\x1b[200~${text}\x1b[201~`)
}

/** Delay between per-line pastes in {@link pasteAsTextByLines}. Small enough to feel quick
 *  for normal text, large enough that the TUI registers each line as its own paste event. */
const PASTE_LINE_DELAY_MS = 10

/**
 * Paste the clipboard as ACTUAL editable text instead of one big bracketed paste.
 *
 * A single large bracketed paste makes Claude's TUI collapse it into a
 * "[Pasted text +N lines]" placeholder you can't edit. This sends the text one line at a
 * time, each as its OWN tiny bracketed paste — small enough to never trip that per-paste
 * collapse — carrying the line break as a literal in-paste `\n` (bracketed-paste mode
 * suppresses Enter's submit, so the newline lands in the input rather than sending it).
 * The result is the whole clipboard laid out as real lines in the prompt, ready to edit.
 * Lines are spaced by PASTE_LINE_DELAY_MS so the TUI treats them as distinct pastes and a
 * huge clipboard streams in instead of locking the UI.
 */
export function pasteAsTextByLines(terminalId: string, text: string): void {
  if (!text) return
  const lines = text.split(/\r?\n/)
  let i = 0
  const step = () => {
    if (i >= lines.length) return
    const isLast = i === lines.length - 1
    // Trailing \n on every line but the last is a literal newline INSIDE the paste → no submit.
    window.electronAPI.writeTerminal(terminalId, `\x1b[200~${isLast ? lines[i] : lines[i] + '\n'}\x1b[201~`)
    i++
    if (i < lines.length) setTimeout(step, PASTE_LINE_DELAY_MS)
  }
  step()
}

/** Focus the xterm terminal whose container carries data-terminal-id={terminalId}. */
export function focusTerminal(terminalId: string): void {
  const el = document.querySelector(
    `[data-terminal-id="${terminalId}"] .xterm-helper-textarea`
  ) as HTMLElement | null
  el?.focus()
}

export function openOrActivatePanel(
  api: DockviewApi,
  id: string,
  component: string,
  title: string,
  params?: Record<string, unknown>
): void {
  const existing = api.panels.find(p => p.id === id)
  if (existing) {
    // Push fresh params so a re-activation can carry new context — e.g.
    // RecentFiles "Show changes in prompts" reopens the same panel for a
    // different file, the panel reads the updated filterFilePath via its
    // params sync effect.
    if (params) existing.api.updateParameters(params)
    existing.api.setActive()
  } else {
    api.addPanel({ id, component, title, params })
  }
}

// Single source of truth for derived-panel titles + IDs. Used by the title-
// peeling regex below, by `panelIdForProject` callers, and by the opener
// helpers at the bottom of this file.
export const FILE_CHANGES_SUFFIX = '📝 File Changes'
export const SESSION_HISTORY_SUFFIX = '🔍 Session History'
export const SESSION_CHANGES_ID_PREFIX = 'session-changes'
export const SESSION_HISTORY_ID_PREFIX = 'session-history'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const DERIVED_SUFFIX_RE = new RegExp(
  `\\s*-\\s*(?:${[FILE_CHANGES_SUFFIX, SESSION_HISTORY_SUFFIX].map(escapeRe).join('|')})\\s*$`,
)

/**
 * Title of the active panel suitable as a prefix for our derived-panel
 * titles. For a terminal it's the tab title; for one of our own derived
 * panels (File Changes, Session History) the known suffix is peeled so the
 * original source name carries forward and titles don't recurse. Returns
 * '' for anything else — caller can fall back to e.g. project basename.
 */
export function getSourceTabTitle(api: DockviewApi): string {
  const active = api.activePanel
  if (!active) return ''
  if (active.id.startsWith(`${SESSION_CHANGES_ID_PREFIX}:`) || active.id.startsWith(`${SESSION_HISTORY_ID_PREFIX}:`)) {
    // Peel our own suffix to recover the original source name.
    return (active.title ?? '').replace(DERIVED_SUFFIX_RE, '').trim()
  }
  const p = active.params as Record<string, unknown> | undefined
  const isTerminal = !!(p?.projectDir ?? p?.cwd)
  if (!isTerminal) return ''
  return (active.title ?? '').trim()
}

/**
 * Source prefix for derived-panel titles, with project-basename fallback so
 * the title always has *some* project context even when opened from a
 * non-terminal panel that yielded no usable name.
 */
export function getSourcePrefix(api: DockviewApi, projectDir: string): string {
  const fromTab = getSourceTabTitle(api)
  if (fromTab) return fromTab
  return projectDir.split(/[/\\]/).filter(Boolean).pop() ?? ''
}

/**
 * Stable but per-project panel id. Two openers for the same project return
 * the same id (so one panel is reused); openers for different projects get
 * different ids (so you get one panel per project, not one global panel).
 */
export function panelIdForProject(prefix: string, projectDir: string): string {
  // Strip trailing separators so `Q:\Foo` and `Q:\Foo\` produce the same id.
  const slug = projectDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return `${prefix}:${slug}`
}

/**
 * Stable dockview panel id for a FileViewer tab. Normalizes separators +
 * case so the SAME file opened via different entry points (RecentFiles,
 * CommandPalette, …) maps to one panel instead of spawning duplicate tabs.
 */
export function fileViewerPanelId(projectDir: string | undefined, filePath: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  return `file:${norm(projectDir ?? 'unknown')}::${norm(filePath)}`
}

/**
 * Stable dockview panel id for a Directory Viewer tab — one tab per folder (separators + case
 * normalized, trailing slash stripped), so re-opening the same folder reuses its tab.
 */
export function directoryViewerPanelId(dirPath: string): string {
  return `dir:${dirPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
}

/** Open (or activate) a Directory Viewer tab listing the folder's contents. */
export function openDirectoryViewer(api: DockviewApi, dirPath: string, projectDir?: string): void {
  const trimmed = dirPath.replace(/[/\\]+$/, '')
  const name = trimmed.replace(/^.*[/\\]/, '') || trimmed
  openOrActivatePanel(api, directoryViewerPanelId(trimmed), 'directoryViewerPanel', `📂 ${name}`, { dirPath: trimmed, projectDir })
}

/** Parent directory of an absolute path, or null at a drive/filesystem root (can't go higher). */
export function parentDir(dir: string): string | null {
  const norm = dir.replace(/\//g, '\\').replace(/\\+$/, '')
  const idx = norm.lastIndexOf('\\')
  if (idx < 0) return null
  const parent = norm.slice(0, idx)
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\` // drive letter → its root
  if (!parent) return null
  return parent
}

/** Decompose an absolute path into navigable crumbs (drive root + each segment). Each crumb's `dir`
 *  is the absolute path up to and including that segment. Shared by the directory + file viewers. */
export function pathCrumbs(dir: string): { label: string; dir: string }[] {
  const norm = dir.replace(/\//g, '\\').replace(/\\+$/, '')
  if (!norm) return []
  const parts = norm.split('\\')
  const out: { label: string; dir: string }[] = []
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    const full = i === 0
      ? (/^[a-zA-Z]:$/.test(seg) ? `${seg}\\` : (seg === '' ? '\\' : seg))
      : parts.slice(0, i + 1).join('\\')
    out.push({ label: seg || '\\', dir: full })
  }
  return out
}

/**
 * Best-effort current project directory: prefer the active panel's
 * `projectDir`/`cwd`, then derive from an open file's path. Returns `''` when
 * the active panel has no project context (e.g. a fresh layout at first launch);
 * callers treat empty as "no project" and no-op. Shared by Ctrl+H / Ctrl+J
 * handlers and the matching menu actions.
 */
export function getActiveProjectDir(api: DockviewApi): string {
  const active = api.activePanel
  if (!active) return ''
  const p = active.params as Record<string, unknown> | undefined
  const dir = (p?.projectDir as string | undefined) ?? (p?.cwd as string | undefined)
  if (dir) return dir
  const fp = p?.filePath as string | undefined
  if (fp) return fp.split(/[/\\]/).slice(0, -1).join('\\')
  return ''
}

/** Open (or activate) the per-project File Changes panel. */
export function openFileChangesPanel(
  api: DockviewApi,
  projectDir: string,
  opts?: { sessionId?: string; filterFilePath?: string },
): void {
  const src = getSourcePrefix(api, projectDir)
  const params: Record<string, unknown> = { projectDir }
  if (opts?.sessionId) params.sessionId = opts.sessionId
  // Explicit undefined so re-activation clears any prior filter; setting
  // a value installs/replaces it.
  params.filterFilePath = opts?.filterFilePath
  openOrActivatePanel(
    api,
    panelIdForProject(SESSION_CHANGES_ID_PREFIX, projectDir),
    'sessionChangesPanel',
    src ? `${src} - ${FILE_CHANGES_SUFFIX}` : FILE_CHANGES_SUFFIX,
    params,
  )
}

/** Open (or activate) the global Sessions Search panel. */
export function openSessionsSearchPanel(api: DockviewApi): void {
  openOrActivatePanel(
    api,
    'sessions-search',
    'sessionsSearchPanel',
    'Search Sessions',
    {},
  )
}

/** Open (or activate) the per-window Ideas panel. Single tab per window. */
export function openIdeasPanel(api: DockviewApi): void {
  openOrActivatePanel(
    api,
    'ideas',
    'ideasPanel',
    'Ideas',
    {},
  )
}

/** Open (or activate) the Remote connections panel. Single tab per window. */
export function openRemoteConnectionsPanel(api: DockviewApi): void {
  openOrActivatePanel(
    api,
    'remote-connections',
    'remoteConnectionsPanel',
    'Remote connections',
    {},
  )
}

/** Open (or activate) the per-project Session History panel. */
export function openSessionHistoryPanel(api: DockviewApi, projectDir: string): void {
  const src = getSourcePrefix(api, projectDir)
  openOrActivatePanel(
    api,
    panelIdForProject(SESSION_HISTORY_ID_PREFIX, projectDir),
    'sessionSearchPanel',
    src ? `${src} - ${SESSION_HISTORY_SUFFIX}` : SESSION_HISTORY_SUFFIX,
    { projectDir },
  )
}

// ── Remote peer panel openers ─────────────────────────────────────────────
// Shared by RemoteConnectionsPanel (the connection tree) and RemoteViewerPanel (the live
// viewer) so both open the SAME peer-backed panels — identical ids/titles/params. Each panel
// is peer-aware via panelDataSource.makeDataSource(peer): a `peer` param routes every fetch
// through the remote `control:*` ops instead of local IPC.

/**
 * Open (or activate) a PEER's file in a read-only FileViewer. The viewer reads the file + diff
 * baselines over the op API (path-scoped to the peer's project roots server-side). `projectDir`
 * (optional) unlocks the peer's Claude-session diff modes for that file. One tab per peer+path.
 */
export function openPeerFile(api: DockviewApi, peer: RemotePeer, filePath: string, projectDir?: string): void {
  const trimmed = filePath.trim()
  if (!trimmed) return
  const name = trimmed.replace(/^.*[/\\]/, '')
  openOrActivatePanel(api, `remote-file:${peer.id}:${trimmed}`, 'fileViewerPanel', `🛰 ${peer.name}: ${name}`, { filePath: trimmed, projectDir, peer })
}

/**
 * Open (or activate) a PEER's session File-Changes panel. `projectDir` = the peer tab's cwd;
 * `sessionId` pins the diff to that tab's session. The panel reads everything over the op API.
 * One tab per peer+project.
 */
export function openPeerChanges(api: DockviewApi, peer: RemotePeer, projectDir: string, sessionId: string | undefined, title: string): void {
  openOrActivatePanel(api, `remote-changes:${peer.id}:${projectDir}`, 'sessionChangesPanel', `🛰 ${peer.name}: 📝 ${title}`, { projectDir, sessionId, peer })
}

/**
 * Open (or activate) a PEER's notes panel (keyed by project dir == the peer tab's cwd) — read +
 * write over the op API. One tab per peer+project.
 */
export function openPeerNotes(api: DockviewApi, peer: RemotePeer, projectDir: string, title: string): void {
  openOrActivatePanel(api, `remote-notes:${peer.id}:${projectDir}`, 'remoteNotesPanel', `🛰 ${peer.name}: 🗒 ${title}`, { projectDir, peer })
}

// ── Terminal path detection + resolution ──────────────────────────────────
// Shared by the local terminal (useTerminal + TerminalContextMenu) and the remote viewer.

const PATH_CHAR = /[a-zA-Z0-9._\-\\/:~]/
const PATH_SEP = /[\\/:]/

/**
 * Extract the path-like word at a mouse position from an xterm buffer.
 *
 * Strategy: find the path-char run around the click on the clicked row, then — only if that run
 * looks path-like (contains \, /, or :) — stitch with adjacent rows. Stitching covers:
 *   - xterm soft-wrap                                                  (continuation row starts at col 0 with path-chars)
 *   - source hard-wrap at terminal edge (Ink / Claude Code, no indent) (continuation row col 0 = path-char)
 *   - hanging-indent continuation (Claude Code "Update(<long-path>)")  (continuation row = whitespace indent + path-chars)
 *
 * Cross-row rule, both directions:
 *   step back  if: chars to the LEFT  of the run on the current row are all whitespace AND the
 *                  previous row has a TRAILING path-char run (possibly followed by trailing spaces)
 *   step forward if: chars to the RIGHT of the run on the current row are all whitespace AND the
 *                  next row has a LEADING path-char run (possibly preceded by indent spaces)
 *
 * The "path-like" gate prevents stitching on normal sentence wraps where both ends happen to be
 * path-chars (e.g. "Hello world\n   I am here"). `container` is the element xterm was opened on.
 */
export function getPathAtPosition(term: Terminal, container: HTMLElement, clientX: number, clientY: number): string {
  const screenEl = container.querySelector('.xterm-screen')
  if (!screenEl) return ''
  const rect = screenEl.getBoundingClientRect()
  const col = Math.floor((clientX - rect.left) / (rect.width / term.cols))
  const row = Math.floor((clientY - rect.top) / (rect.height / term.rows))
  const buf = term.buffer.active
  const cols = term.cols
  const bufferRow = row + buf.viewportY

  const rowText = (r: number): string | null => {
    const line = buf.getLine(r)
    return line ? line.translateToString(false, 0, cols) : null
  }

  const startText = rowText(bufferRow)
  if (!startText) return ''

  // Find path-char run around the click on the clicked row.
  let clickCol = Math.min(col, startText.length - 1)
  if (clickCol < 0) return ''
  if (!PATH_CHAR.test(startText[clickCol])) {
    if (clickCol > 0 && PATH_CHAR.test(startText[clickCol - 1])) clickCol -= 1
    else return ''
  }
  let s = clickCol
  let e = clickCol + 1
  while (s > 0 && PATH_CHAR.test(startText[s - 1])) s--
  while (e < startText.length && PATH_CHAR.test(startText[e])) e++
  let result = startText.slice(s, e)

  // Only attempt cross-row stitching if the single-row run is path-like.
  if (PATH_SEP.test(result)) {
    // Walk back: prev row's trailing path-char run + indent on current row.
    let curText = startText
    let curS = s
    let curRow = bufferRow
    while (curRow > 0 && /^\s*$/.test(curText.slice(0, curS))) {
      const prev = rowText(curRow - 1)
      if (!prev) break
      let pe = prev.length
      while (pe > 0 && /\s/.test(prev[pe - 1])) pe--
      if (pe === 0 || !PATH_CHAR.test(prev[pe - 1])) break
      let ps = pe - 1
      while (ps > 0 && PATH_CHAR.test(prev[ps - 1])) ps--
      result = prev.slice(ps, pe) + result
      curRow -= 1
      curText = prev
      curS = ps
    }
    // Walk forward: trailing space on current row + next row's leading path-char run (after indent).
    curText = startText
    let curE = e
    curRow = bufferRow
    // Cap forward walk; viewportY + rows is the on-screen end of the visible region, but
    // soft-wrapped output can extend past it — use buf.length as the absolute end of valid rows.
    const maxRow = buf.length
    while (curRow + 1 < maxRow && /^\s*$/.test(curText.slice(curE))) {
      const next = rowText(curRow + 1)
      if (!next) break
      let ns = 0
      while (ns < next.length && /\s/.test(next[ns])) ns++
      if (ns === next.length || !PATH_CHAR.test(next[ns])) break
      let ne = ns
      while (ne < next.length && PATH_CHAR.test(next[ne])) ne++
      result = result + next.slice(ns, ne)
      curRow += 1
      curText = next
      curE = ne
    }
  }

  return result.trim()
}

/** Strip surrounding quotes, a trailing `:line[:col]` suffix, and trailing punctuation from a raw path token. */
export function cleanTerminalPath(raw: string): string {
  let p = raw.replace(/["`']/g, '').trim()
  p = p.replace(/:\d+(?::\d+)?$/, '')
  p = p.replace(/[.,;:!?\s]+$/, '')
  return p.trim()
}

/**
 * Resolve a path token detected in a terminal to an absolute path, or null if it can't be made
 * absolute. Drive-absolute / UNC / `~` are kept as-is; a bare relative path is joined under
 * `projectDir` when known. Mirrors the local TerminalContextMenu resolution so the remote viewer
 * resolves the same way (against the remote tab's cwd).
 */
export function resolveTerminalPath(input: string, projectDir: string | null | undefined): string | null {
  const cleaned = cleanTerminalPath(input)
  if (!cleaned) return null
  const normalized = cleaned.replace(/\//g, '\\')
  if (normalized === '~' || normalized.startsWith('~\\')) return normalized
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) return normalized
  if (normalized.startsWith('\\')) return normalized
  if (projectDir) return projectDir.replace(/[\\/]+$/, '') + '\\' + normalized
  return null
}
