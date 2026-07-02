import { IDockviewPanelProps } from 'dockview'
import { useState, useEffect, useRef, useCallback } from 'react'
import { MasterDetailLayout } from '../MasterDetailLayout'
import type { SessionInfo, SessionMessage, SessionSearchMatch } from '../../../../../core/types/session'

interface SessionSearchParams {
  projectDir?: string
}

type SearchMatch = SessionSearchMatch

interface SearchGroup {
  sessionId: string
  sessionLabel: string | null
  sessionDate: string
  projectDir?: string
  matches: SearchMatch[]
}

/** The session whose conversation is shown in the detail pane. */
interface SelectedSession {
  sessionId: string
  projectDir: string
  label: string
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

function groupBySession(matches: SearchMatch[]): SearchGroup[] {
  const order: string[] = []
  const groups = new Map<string, SearchGroup>()
  for (const m of matches) {
    if (!groups.has(m.sessionId)) {
      groups.set(m.sessionId, {
        sessionId: m.sessionId,
        sessionLabel: m.sessionLabel,
        sessionDate: m.sessionDate,
        projectDir: m.projectDir,
        matches: [],
      })
      order.push(m.sessionId)
    }
    groups.get(m.sessionId)!.matches.push(m)
  }
  return order.map((id) => groups.get(id)!)
}

export function SessionSearchPanel({ api, params }: IDockviewPanelProps<SessionSearchParams>) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchMatch[]>([])
  const [searching, setSearching] = useState(false)
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([])
  const [selected, setSelected] = useState<SelectedSession | null>(null)
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic counter so a slow search response for a stale query is dropped.
  const searchSeq = useRef(0)

  const projectDir = params?.projectDir ?? ''
  const displayProject = projectDir ? projectDir.replace(/.*[/\\]/, '') : '(no project)'

  useEffect(() => {
    // Title comes from the opener (source-prefixed); don't override it here.
    const t = setTimeout(() => inputRef.current?.focus(), 100)
    return () => clearTimeout(t)
  }, [])

  // Recent sessions for the no-query browse list.
  useEffect(() => {
    if (!projectDir || !window.electronAPI?.listSessions) {
      setAllSessions([])
      return
    }
    let cancelled = false
    window.electronAPI
      .listSessions(projectDir)
      .then((list) => {
        if (!cancelled) setAllSessions(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (!cancelled) setAllSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [projectDir])

  const doSearch = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([])
        setSearching(false)
        return
      }
      const seq = ++searchSeq.current
      setSearching(true)
      try {
        const res = projectDir
          ? await window.electronAPI.searchSessions?.(projectDir, q.trim())
          : await window.electronAPI.searchSessionsAll?.(q.trim())
        if (seq !== searchSeq.current) return // superseded by a newer query
        setResults(res ?? [])
      } catch {
        if (seq === searchSeq.current) setResults([])
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    },
    [projectDir],
  )

  const handleQueryChange = (q: string) => {
    setQuery(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => doSearch(q), 300)
  }

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [])

  // Load the selected session's conversation into the detail pane.
  useEffect(() => {
    if (!selected || !window.electronAPI?.loadSession) {
      setMessages([])
      return
    }
    let cancelled = false
    setMessagesLoading(true)
    window.electronAPI
      .loadSession(selected.projectDir, selected.sessionId)
      .then((msgs) => {
        if (cancelled) return
        setMessages(Array.isArray(msgs) ? msgs : [])
        setMessagesLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setMessages([])
        setMessagesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const handleOpenInTab = async (sessionId: string, rowProjectDir: string, e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const effectiveProjectDir = rowProjectDir || projectDir
    if (!effectiveProjectDir || !window.electronAPI?.openSessionInTab) return
    try {
      await window.electronAPI.openSessionInTab(effectiveProjectDir, sessionId)
    } catch {
      /* ignore — opening is best-effort */
    }
  }

  const groups = groupBySession(results)

  const header = (
    <div className="session-search-toolbar">
      <span className="session-search-project" title={projectDir}>
        {displayProject}
      </span>
      <input
        ref={inputRef}
        className="session-search-input"
        type="text"
        placeholder="Search session history..."
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQuery('')
            setResults([])
          }
        }}
      />
      {searching && <span className="session-search-loading">Searching…</span>}
      {!searching && query.length >= 2 && (
        <span className="session-search-count">
          {results.length} match{results.length !== 1 ? 'es' : ''}
        </span>
      )}
    </div>
  )

  const renderSessionRow = (
    sessionId: string,
    rowProjectDir: string,
    label: string,
    date: string,
    info: React.ReactNode,
    preview: React.ReactNode,
  ) => {
    const isSelected = selected?.sessionId === sessionId
    return (
      <div
        key={sessionId}
        className={`session-search-group-header ${isSelected ? 'selected' : ''}`}
        onClick={() => {
          // Skip when clicking the already-selected row — avoids a redundant
          // loadSession IPC round-trip (the effect keys on object identity).
          if (selected?.sessionId === sessionId) return
          setSelected({ sessionId, projectDir: rowProjectDir || projectDir, label })
        }}
      >
        <span className="session-search-row-date">{formatDate(date)}</span>
        <span className="session-search-session-label">{label}</span>
        {info}
        {preview}
        <button
          className="session-search-open-btn"
          title="Open this session in a new tab"
          onClick={(e) => handleOpenInTab(sessionId, rowProjectDir, e)}
        >
          📂 Open
        </button>
      </div>
    )
  }

  let nav: React.ReactNode
  if (query.length === 1) {
    nav = <div className="session-search-empty">Type at least 2 characters to search.</div>
  } else if (query.length >= 2) {
    if (searching && groups.length === 0) {
      nav = <div className="session-search-empty">Searching…</div>
    } else if (groups.length === 0) {
      nav = <div className="session-search-empty">No matches found.</div>
    } else {
      nav = groups.map((g) => {
        const label = g.sessionLabel ?? g.sessionId.slice(0, 8)
        const first = g.matches[0]
        const preview = first ? (
          <span className="session-search-row-preview">
            <span className={`session-search-role ${first.role}`}>
              {first.role === 'user' ? 'You' : 'Claude'}
            </span>
            {' '}
            {first.snippet}
          </span>
        ) : null
        return (
          <div key={g.sessionId} className="session-search-group">
            {renderSessionRow(
              g.sessionId,
              g.projectDir ?? projectDir,
              label,
              g.sessionDate,
              <span className="session-search-match-count">
                {g.matches.length} match{g.matches.length !== 1 ? 'es' : ''}
              </span>,
              preview,
            )}
          </div>
        )
      })
    }
  } else if (allSessions.length === 0) {
    nav = <div className="session-search-empty">No past sessions for this project.</div>
  } else {
    nav = allSessions.map((s) => {
      const label = s.slug ?? s.sessionId.slice(0, 8)
      return (
        <div key={s.sessionId} className="session-search-group">
          {renderSessionRow(
            s.sessionId,
            projectDir,
            label,
            new Date(s.lastActivity).toISOString(),
            s.active ? <span className="session-row-active" title="Active session">●</span> : null,
            s.firstUserMessage ? (
              <span className="session-search-row-preview">{s.firstUserMessage}</span>
            ) : null,
          )}
        </div>
      )
    })
  }

  let detail: React.ReactNode
  if (!selected) {
    detail = <div className="session-search-empty">Select a session to read its conversation.</div>
  } else if (messagesLoading) {
    detail = <div className="session-search-empty">Loading…</div>
  } else if (messages.length === 0) {
    detail = <div className="session-search-empty">No messages in this session.</div>
  } else {
    detail = (
      <div className="session-search-full">
        {messages.map((msg, i) => (
          <div key={i} className={`session-full-message ${msg.role}`}>
            <div className="session-full-message-header">
              <span className={`session-search-role ${msg.role}`}>{msg.role === 'user' ? 'You' : 'Claude'}</span>
              {msg.timestamp && <span className="session-full-ts">{formatDate(msg.timestamp)}</span>}
            </div>
            <div className="session-full-message-content">{msg.content}</div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <MasterDetailLayout
      className="session-search-panel"
      defaultNavBasis={35}
      header={header}
      nav={<div className="session-search-results">{nav}</div>}
      detail={detail}
    />
  )
}
