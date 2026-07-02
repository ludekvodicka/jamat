import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import { IDockviewPanelProps } from 'dockview'
import { useLayoutStore } from '../../store/layout-store'
import { FileDiffPane } from '../FileDiffPane'
import { MasterDetailLayout } from '../MasterDetailLayout'
import { composeFileNetDiff, fileKey } from '../../../../../core/menu-core/diff-compose'
import { useAgentBadges } from '../../hooks/useAgentBadges'
import { makeDataSource } from '../../datasource/panelDataSource'
import type { RemotePeer } from '../../../../../core/types/remote-control'
import type { TurnInfo, FileTurnEdit, SessionInfo } from '../../../../../core/types/session'

interface SessionChangesParams {
  projectDir?: string
  sessionId?: string
  /**
   * When set, the panel shows only turns/files matching this path. Used by
   * RecentFiles' "Show changes in prompts" — focuses the panel on the
   * lifecycle of one file. User can clear the filter from the panel header.
   */
  filterFilePath?: string
  /**
   * When set, the panel reads the session changes from this PEER over the op API instead of the
   * local machine (Direction #2). Remote mode is fixed to `projectDir` — the active-terminal
   * auto-follow (a local-layout concern) is disabled.
   */
  peer?: RemotePeer
}

type ViewMode = 'session' | 'file'

/** What the detail pane is currently showing. */
type Selection =
  | { kind: 'turnFile'; turnIndex: number; filePath: string }
  | { kind: 'file'; filePath: string }

interface FileAggregate {
  filePath: string
  shortName: string
  totalEdits: number
  turnCount: number
}

function formatTime(iso: string | null): string {
  if (!iso) return '--:--'
  try {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return '--:--'
  }
}

function formatSessionDate(value: Date | string): string {
  try {
    const d = new Date(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return ''
  }
}

function shortFileName(fp: string): string {
  return fp.split(/[\\/]/).pop() ?? fp
}

function changeLabel(isNewFile: boolean, isOverwritten: boolean): string | null {
  if (isNewFile) return 'new file'
  if (isOverwritten) return 'overwritten'
  return null
}

/** Whether a selection still points at something present in the current data. */
function isSelectionResolvable(
  sel: Selection,
  mode: ViewMode,
  turns: TurnInfo[] | null,
  files: FileAggregate[],
): boolean {
  if (!turns) return false
  if (mode === 'session' && sel.kind === 'turnFile') {
    const turn = turns.find((t) => t.turnIndex === sel.turnIndex)
    return !!turn && turn.files.some((f) => fileKey(f.filePath) === fileKey(sel.filePath))
  }
  if (mode === 'file' && sel.kind === 'file') {
    return files.some((f) => fileKey(f.filePath) === fileKey(sel.filePath))
  }
  return false
}

/** Active-terminal pin: empty string means "follow the active terminal". */
const FOLLOW_ACTIVE = ''

export function SessionChangesPanel({ api, params }: IDockviewPanelProps<SessionChangesParams>) {
  // Data source: local, or — when opened for a peer — that peer's data over the op API.
  const ds = useMemo(() => makeDataSource(params?.peer), [params?.peer?.id])
  const remote = ds.remote
  const activePanelKey = useLayoutStore((s) => s.activePanel)
  const [resolvedProjectDir, setResolvedProjectDir] = useState<string>(() => params?.projectDir ?? '')
  const [resolvedSessionId, setResolvedSessionId] = useState<string | undefined>(params?.sessionId)
  // Local filter — initialized from params, updated when a fresh
  // `updateParameters` arrives (RecentFiles re-opens for a different file).
  // Cleared explicitly by the user via the filter banner's × button.
  const [filterFilePath, setFilterFilePath] = useState<string | undefined>(params?.filterFilePath)
  useEffect(() => {
    setFilterFilePath(params?.filterFilePath)
  }, [params?.filterFilePath])
  // Picker value. FOLLOW_ACTIVE = follow the active terminal; any other value
  // pins the panel to that session until the user returns to "Active session".
  const [pickedSessionId, setPickedSessionId] = useState<string>(FOLLOW_ACTIVE)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [editFlags, setEditFlags] = useState<Record<string, boolean>>({})
  const [hideEmptySessions, setHideEmptySessions] = useState(true)
  const [turns, setTurns] = useState<TurnInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('session')
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set())
  const [selection, setSelection] = useState<Selection | null>(null)
  const [netStartLine, setNetStartLine] = useState<number | null>(null)
  const effectiveSessionId = pickedSessionId || resolvedSessionId

  // Auto-follow the active terminal panel — within our own project.
  // The panel is bound to one project (per-project stable ID); switching to
  // a terminal of a *different* project must NOT yank our context. Switching
  // between terminals of the same project updates the active sessionId and
  // refreshes the tab title to reflect the source terminal.
  useEffect(() => {
    if (remote) return // a peer panel is pinned to its projectDir — never follow this machine's active tab
    const dvApi = useLayoutStore.getState().dockviewApi
    const active = dvApi?.activePanel
    if (!active || active.id === api.id) return // ignore self
    const p = active.params as Record<string, unknown> | undefined
    const dir = (p?.projectDir as string | undefined) ?? (p?.cwd as string | undefined)
    if (!dir) return // non-terminal panel — keep prior resolution
    const ownDir = params?.projectDir
    if (ownDir) {
      const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase()
      if (norm(ownDir) !== norm(dir)) return // different project — ignore
    }
    const sid = p?.sessionId as string | undefined
    setResolvedProjectDir(dir)
    setResolvedSessionId(sid)
    const src = (active.title ?? '').trim()
    const nextTitle = src ? `${src} - 📝 File Changes` : '📝 File Changes'
    if (api.title !== nextTitle) api.setTitle(nextTitle)
  }, [activePanelKey, api, params?.projectDir, remote])

  // Switching projects clears a manual pin — the pinned session belonged to
  // the previous project's session list.
  useEffect(() => {
    setPickedSessionId(FOLLOW_ACTIVE)
  }, [resolvedProjectDir])

  // Load the project's session list for the picker.
  useEffect(() => {
    if (!resolvedProjectDir) {
      setSessions([])
      return
    }
    let cancelled = false
    ds.listSessions(resolvedProjectDir)
      .then((list) => {
        if (!cancelled) setSessions(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [resolvedProjectDir, ds])

  // Edit-presence flags for filtering conversation-only sessions out of the
  // picker. Loaded once per project; cached in the main process.
  useEffect(() => {
    // Clear stale flags from the previous project immediately, so the
    // hide-empty filter doesn't briefly hide every session of the new
    // project while waiting for the new fetch.
    setEditFlags({})
    if (!resolvedProjectDir) return
    let cancelled = false
    ds.getSessionEditFlags(resolvedProjectDir)
      .then((flags) => {
        if (!cancelled) setEditFlags(flags ?? {})
      })
      .catch(() => {
        if (!cancelled) setEditFlags({})
      })
    return () => {
      cancelled = true
    }
  }, [resolvedProjectDir, ds])

  const turnsQuery = useIpcQuery<TurnInfo[]>(
    () => resolvedProjectDir
      ? ds.getSessionChanges(resolvedProjectDir, effectiveSessionId)
      : undefined,
    [resolvedProjectDir, effectiveSessionId, ds],
    {
      onResolve: (result) => { setTurns(result); setLoading(false) },
    },
  )
  const refresh = useCallback(() => { turnsQuery.refetch() }, [turnsQuery])

  // Drive local state from the query's lifecycle. (Existing rendering keeps
  // referencing `turns` / `loading` setters, so we mirror the query into
  // them rather than refactoring every consumer.)
  useEffect(() => {
    if (turnsQuery.loading) setLoading(true)
  }, [turnsQuery.loading])
  useEffect(() => {
    if (turnsQuery.error) { setTurns([]); setLoading(false) }
  }, [turnsQuery.error])
  // Clear when conditions don't allow a fetch.
  useEffect(() => {
    if (!resolvedProjectDir) {
      setTurns([])
      setLoading(false)
    }
  }, [resolvedProjectDir])

  // Re-fetch when this panel itself becomes active (cheap — mtime+size cache
  // in the main process).
  useEffect(() => {
    const disposable = api.onDidActiveChange(({ isActive }) => {
      if (isActive) refresh()
    })
    return () => disposable.dispose()
  }, [api, refresh])

  // When a file filter is set, the panel restricts to turns/files matching
  // that path. Driven through derived data so the rest of the rendering
  // logic (selection, defaults, view switches) is unchanged.
  const filterKey = useMemo(
    () => (filterFilePath ? fileKey(filterFilePath) : null),
    [filterFilePath],
  )

  // Files touched in the session, most-recently-touched first. Filter pass:
  // when the panel is scoped to a single file, only that one survives.
  const fileAggregates = useMemo<FileAggregate[]>(() => {
    if (!turns) return []
    const byKey = new Map<string, FileAggregate>()
    for (let i = turns.length - 1; i >= 0; i--) {
      for (const edit of turns[i].files) {
        const key = fileKey(edit.filePath)
        if (filterKey && key !== filterKey) continue
        let agg = byKey.get(key)
        if (!agg) {
          agg = { filePath: edit.filePath, shortName: shortFileName(edit.filePath), totalEdits: 0, turnCount: 0 }
          byKey.set(key, agg)
        }
        agg.totalEdits += edit.editCount
        agg.turnCount++
      }
    }
    return [...byKey.values()]
  }, [turns, filterKey])

  // Turns for the Session-history view — under filter, drop turns that
  // didn't touch the file (cleaner nav, no empty rows).
  const visibleTurns = useMemo<TurnInfo[] | null>(() => {
    if (!turns) return null
    if (!filterKey) return turns
    return turns
      .map((t) => ({
        ...t,
        files: t.files.filter((f) => fileKey(f.filePath) === filterKey),
      }))
      .filter((t) => t.files.length > 0)
  }, [turns, filterKey])

  // Default selection for the current mode (R8): most recent turn's first
  // file in Session history; most recently touched file in File history.
  // Under a path filter we look at visibleTurns instead — picking a turn
  // that the filter dropped would be unreachable in the nav.
  const computeDefault = useCallback(
    (mode: ViewMode, t: TurnInfo[] | null): Selection | null => {
      if (!t || t.length === 0) return null
      if (mode === 'file') {
        const agg = fileAggregates[0]
        return agg ? { kind: 'file', filePath: agg.filePath } : null
      }
      const pool = filterKey ? (visibleTurns ?? t) : t
      for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].files.length > 0) {
          return { kind: 'turnFile', turnIndex: pool[i].turnIndex, filePath: pool[i].files[0].filePath }
        }
      }
      return null
    },
    [fileAggregates, filterKey, visibleTurns],
  )

  // Keep the current selection if it still resolves against the latest data
  // (so a background focus-refresh doesn't yank the user back to the top);
  // otherwise fall back to the mode's default. Prune expanded turns to
  // indices that still exist, and keep the selected turn expanded.
  useEffect(() => {
    const keep = selection && isSelectionResolvable(selection, viewMode, turns, fileAggregates)
    const next = keep ? selection : computeDefault(viewMode, turns)
    if (next !== selection) setSelection(next)
    setExpandedTurns((prev) => {
      const valid = new Set<number>()
      if (turns) for (const t of turns) if (prev.has(t.turnIndex)) valid.add(t.turnIndex)
      if (next && next.kind === 'turnFile') valid.add(next.turnIndex)
      // Bail when membership is unchanged so we don't churn a fresh Set
      // reference on every selection click.
      if (prev.size === valid.size) {
        let same = true
        for (const x of prev) if (!valid.has(x)) { same = false; break }
        if (same) return prev
      }
      return valid
    })
  }, [turns, viewMode, computeDefault, fileAggregates, selection])

  // Net diff for the File-history detail pane.
  const netDiff = useMemo(() => {
    if (!turns || !selection || selection.kind !== 'file') return null
    return composeFileNetDiff(turns, selection.filePath)
  }, [turns, selection])

  // Best-effort real line numbers for the net diff (async disk lookup).
  // Skipped for disjoint compositions — their line numbers can't be trusted.
  // The path-tracking ref lets us avoid resetting netStartLine when re-render
  // recomputes netDiff for the same file (which would flicker the gutter).
  const lastLocatedPath = useRef<string | null>(null)
  useEffect(() => {
    const path = netDiff?.filePath ?? null
    if (path !== lastLocatedPath.current) {
      setNetStartLine(null)
      lastLocatedPath.current = path
    }
    if (!netDiff || netDiff.disjoint) return
    let cancelled = false
    ds.locateRegion(netDiff.filePath, netDiff.afterText)
      .then((line) => {
        if (!cancelled) setNetStartLine(line)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [netDiff, ds])

  // Ref tracking the latest `expandedTurns`, so the click handler reads the
  // current value rather than the render-time closure snapshot (which can be
  // stale if the keeper effect updates the set between render and click).
  const expandedTurnsRef = useRef(expandedTurns)
  expandedTurnsRef.current = expandedTurns

  const toggleTurnExpand = (idx: number) => {
    const opening = !expandedTurnsRef.current.has(idx)
    setExpandedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
    // When opening a turn, jump straight to its first file's diff so the
    // detail pane shows something useful without a second click.
    if (opening && turns) {
      const turn = turns.find((t) => t.turnIndex === idx)
      const first = turn?.files[0]
      if (first) setSelection({ kind: 'turnFile', turnIndex: idx, filePath: first.filePath })
    }
  }

  // Resolve the FileTurnEdit currently selected in Session-history mode.
  const selectedTurnEdit = useMemo<{ turn: TurnInfo; edit: FileTurnEdit } | null>(() => {
    if (!turns || !selection || selection.kind !== 'turnFile') return null
    const turn = turns.find((t) => t.turnIndex === selection.turnIndex)
    if (!turn) return null
    const edit = turn.files.find((f) => fileKey(f.filePath) === fileKey(selection.filePath))
    return edit ? { turn, edit } : null
  }, [turns, selection])

  // Empty / loading / no-session states
  if (!resolvedProjectDir) {
    return (
      <div className="session-changes-empty">
        Open a Claude session in a terminal tab to see its changes.
      </div>
    )
  }

  const visibleSessions = hideEmptySessions
    ? sessions.filter(
        (s) =>
          editFlags[s.sessionId] === true ||
          s.sessionId === resolvedSessionId ||
          s.sessionId === pickedSessionId, // always keep a manually-pinned session
      )
    : sessions

  const header = (
    <SessionChangesHeader
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      onRefresh={refresh}
      loading={loading}
      sessions={visibleSessions}
      pickedSessionId={pickedSessionId}
      onPickSession={setPickedSessionId}
      hideEmpty={hideEmptySessions}
      onToggleHideEmpty={setHideEmptySessions}
    />
  )

  if (loading && turns === null) {
    return (
      <div className="session-changes">
        {header}
        <div className="session-changes-empty">Loading…</div>
      </div>
    )
  }

  const hasChanges = !!turns && turns.length > 0 && fileAggregates.length > 0

  if (!hasChanges) {
    return (
      <div className="session-changes">
        {header}
        {filterFilePath ? (
          <div className="sc-filter-banner" title={filterFilePath}>
            <span className="sc-filter-label">
              Filtered: <strong>{shortFileName(filterFilePath)}</strong>
            </span>
            <button
              className="sc-filter-clear"
              onClick={() => setFilterFilePath(undefined)}
              title="Clear file filter"
            >×</button>
          </div>
        ) : null}
        <div className="session-changes-empty">
          {filterFilePath
            ? `No edits to ${shortFileName(filterFilePath)} in this session.`
            : 'No file edits in this session yet.'}
        </div>
      </div>
    )
  }

  const filterBanner = filterFilePath ? (
    <div className="sc-filter-banner" title={filterFilePath}>
      <span className="sc-filter-label">
        Filtered: <strong>{shortFileName(filterFilePath)}</strong>
      </span>
      <button
        className="sc-filter-clear"
        onClick={() => setFilterFilePath(undefined)}
        title="Clear file filter"
      >×</button>
    </div>
  ) : null

  const nav = (
    <>
      {filterBanner}
      {viewMode === 'session' ? (
        <SessionHistoryNav
          turns={(visibleTurns ?? turns)!}
          hideEmpty={hideEmptySessions}
          expandedTurns={expandedTurns}
          onToggleTurn={toggleTurnExpand}
          selection={selection}
          onSelectFile={(turnIndex, filePath) => setSelection({ kind: 'turnFile', turnIndex, filePath })}
        />
      ) : (
        <FileHistoryNav
          files={fileAggregates}
          selection={selection}
          onSelectFile={(filePath) => setSelection({ kind: 'file', filePath })}
        />
      )}
    </>
  )

  const detail =
    viewMode === 'session' && selectedTurnEdit ? (
      <FileDiffPane
        key={`s:${selectedTurnEdit.turn.turnIndex}:${selectedTurnEdit.edit.filePath}`}
        filePath={selectedTurnEdit.edit.filePath}
        regionBefore={selectedTurnEdit.edit.beforeText}
        regionAfter={selectedTurnEdit.edit.afterText}
        disjoint={selectedTurnEdit.edit.disjoint}
        regionStartLine={selectedTurnEdit.edit.afterStartLine ?? null}
        label={changeLabel(selectedTurnEdit.edit.isNewFile, selectedTurnEdit.edit.isOverwritten)}
      />
    ) : viewMode === 'file' && netDiff ? (
      <FileDiffPane
        key={`f:${netDiff.filePath}`}
        filePath={netDiff.filePath}
        regionBefore={netDiff.beforeText}
        regionAfter={netDiff.afterText}
        disjoint={netDiff.disjoint}
        regionStartLine={netStartLine}
        label={changeLabel(netDiff.isNewFile, netDiff.isOverwritten)}
      />
    ) : (
      <div className="session-changes-empty">Select a file to see its diff.</div>
    )

  return <MasterDetailLayout className="session-changes" header={header} nav={nav} detail={detail} />
}

interface SessionHistoryNavProps {
  turns: TurnInfo[]
  hideEmpty: boolean
  expandedTurns: Set<number>
  onToggleTurn: (idx: number) => void
  selection: Selection | null
  onSelectFile: (turnIndex: number, filePath: string) => void
}

function SessionHistoryNav({ turns, hideEmpty, expandedTurns, onToggleTurn, selection, onSelectFile }: SessionHistoryNavProps) {
  const shown = hideEmpty ? turns.filter((t) => t.files.length > 0) : turns
  if (shown.length === 0) {
    return (
      <div className="session-changes-empty">
        {hideEmpty ? 'No turns with file edits in this session.' : 'No turns to show.'}
      </div>
    )
  }
  return (
    <div className="session-changes-list">
      {[...shown].reverse().map((turn) => {
        const totalEdits = turn.files.reduce((s, f) => s + f.editCount, 0)
        const expanded = expandedTurns.has(turn.turnIndex)
        return (
          <div key={turn.turnIndex} className="sc-turn">
            <div className="sc-row sc-turn-row" onClick={() => onToggleTurn(turn.turnIndex)}>
              <span className="sc-caret">{expanded ? '▼' : '▶'}</span>
              <span className="sc-time">{formatTime(turn.timestampISO)}</span>
              <span className="sc-prompt" title={turn.userPromptText}>
                {turn.userPromptTextShort || '<no prompt text>'}
              </span>
              <span className="sc-counts">
                {turn.files.length} file{turn.files.length !== 1 ? 's' : ''}, {totalEdits} edit
                {totalEdits !== 1 ? 's' : ''}
              </span>
            </div>
            {expanded ? (
              <div className="sc-files">
                {turn.files.map((edit) => {
                  const isSelected =
                    selection?.kind === 'turnFile' &&
                    selection.turnIndex === turn.turnIndex &&
                    fileKey(selection.filePath) === fileKey(edit.filePath)
                  const label = changeLabel(edit.isNewFile, edit.isOverwritten)
                  return (
                    <div
                      key={edit.filePath}
                      className={`sc-row sc-file-row ${isSelected ? 'sc-selected' : ''}`}
                      onClick={() => onSelectFile(turn.turnIndex, edit.filePath)}
                      title={edit.filePath}
                    >
                      <span className="sc-caret" />
                      <span className="sc-file-name">{shortFileName(edit.filePath)}</span>
                      {label ? <span className="sc-file-tag">{label}</span> : null}
                      <span className="sc-counts">
                        {edit.editCount} edit{edit.editCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

interface FileHistoryNavProps {
  files: FileAggregate[]
  selection: Selection | null
  onSelectFile: (filePath: string) => void
}

function FileHistoryNav({ files, selection, onSelectFile }: FileHistoryNavProps) {
  return (
    <div className="session-changes-list">
      {files.map((agg) => {
        const isSelected = selection?.kind === 'file' && fileKey(selection.filePath) === fileKey(agg.filePath)
        return (
          <div
            key={agg.filePath}
            className={`sc-row sc-file-row sc-file-row-flat ${isSelected ? 'sc-selected' : ''}`}
            onClick={() => onSelectFile(agg.filePath)}
            title={agg.filePath}
          >
            <span className="sc-file-name">{agg.shortName}</span>
            <span className="sc-counts">
              {agg.totalEdits} edit{agg.totalEdits !== 1 ? 's' : ''} · {agg.turnCount} turn
              {agg.turnCount !== 1 ? 's' : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

interface HeaderProps {
  viewMode: ViewMode
  onViewModeChange: (m: ViewMode) => void
  onRefresh: () => void
  loading: boolean
  sessions: SessionInfo[]
  pickedSessionId: string
  onPickSession: (id: string) => void
  hideEmpty: boolean
  onToggleHideEmpty: (v: boolean) => void
}

function SessionChangesHeader({
  viewMode,
  onViewModeChange,
  onRefresh,
  loading,
  sessions,
  pickedSessionId,
  onPickSession,
  hideEmpty,
  onToggleHideEmpty,
}: HeaderProps) {
  const agentBadges = useAgentBadges(sessions.map((s) => s.sessionId))
  return (
    <div className="session-changes-header">
      <div className="sc-toggle">
        <button
          className={`sc-toggle-btn ${viewMode === 'session' ? 'active' : ''}`}
          onClick={() => onViewModeChange('session')}
          type="button"
        >
          Session history
        </button>
        <button
          className={`sc-toggle-btn ${viewMode === 'file' ? 'active' : ''}`}
          onClick={() => onViewModeChange('file')}
          type="button"
        >
          File history
        </button>
      </div>
      <select
        className="sc-session-picker"
        value={pickedSessionId}
        onChange={(e) => onPickSession(e.target.value)}
        title="Which session to inspect"
      >
        <option value={FOLLOW_ACTIVE}>● Active session</option>
        {sessions.map((s) => {
          const badge = agentBadges.get(s.sessionId)
          const prefix = badge ? `[${badge}] ` : ''
          return (
            <option key={s.sessionId} value={s.sessionId}>
              {prefix + (s.slug ?? s.sessionId.slice(0, 8)) + ' · ' + formatSessionDate(s.lastActivity)}
            </option>
          )
        })}
      </select>
      <label className="sc-hide-empty" title="Only show sessions that edited at least one file">
        <input
          type="checkbox"
          checked={hideEmpty}
          onChange={(e) => onToggleHideEmpty(e.target.checked)}
        />
        Hide empty
      </label>
      <button
        className="sc-refresh-btn"
        onClick={onRefresh}
        type="button"
        title="Refresh"
        disabled={loading}
      >
        ↻
      </button>
    </div>
  )
}
