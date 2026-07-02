import { IDockviewPanelProps } from 'dockview'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useIpcQuery } from '../../hooks/useIpcQuery'
import { useAgentBadges } from '../../hooks/useAgentBadges'
import type { SessionSearchMatch } from '../../../../../core/types/session'

type SearchResult = SessionSearchMatch & { projectDir: string }

export function SessionsSearchPanel(_props: IDockviewPanelProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 350ms debounce so typing-fast doesn't fire one search per keystroke.
  // `sessions:search-all` walks every project's JSONLs and is not cheap.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useIpcQuery<SearchResult[]>(
    () => debounced.length >= 2 && window.electronAPI?.searchAllSessions
      ? window.electronAPI.searchAllSessions(debounced)
      : undefined,
    [debounced],
    // Drop stale match snippets the moment the query changes, so the old
    // results don't linger under the new search term.
    { clearOnRefetch: true },
  )

  const open = (r: SearchResult) => {
    void window.electronAPI?.openSessionInTab?.(r.projectDir, r.sessionId)
  }

  const matches = results.data ?? []
  const noQuery = debounced.length < 2

  // Distinct sessionIds across results — badge resolution is per session,
  // not per match (a session can have many hits). Inert unless >1 agent.
  const uniqueSessionIds = useMemo(
    () => [...new Set(matches.map((m) => m.sessionId))],
    [matches],
  )
  const agentBadges = useAgentBadges(uniqueSessionIds)

  return (
    <div className="sessions-search-panel">
      <div className="sessions-search-bar">
        <input
          ref={inputRef}
          type="text"
          className="sessions-search-input"
          placeholder="Search across all sessions (min 2 chars)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoFocus
        />
        {results.loading && <span className="sessions-search-status">Searching…</span>}
        {!results.loading && !noQuery && (
          <span className="sessions-search-status">
            {matches.length} match{matches.length === 1 ? '' : 'es'}
          </span>
        )}
      </div>

      {noQuery && (
        <div className="sessions-search-empty">Type at least 2 characters to search session transcripts across all projects.</div>
      )}

      {!noQuery && results.error && (
        <div className="sessions-search-empty sessions-search-error">{results.error.message}</div>
      )}

      {!noQuery && !results.error && !results.loading && results.data !== null && matches.length === 0 && (
        <div className="sessions-search-empty">No matches.</div>
      )}

      <div className="sessions-search-results">
        {matches.map((m, i) => (
          <div
            key={`${m.sessionId}:${m.timestamp}:${i}`}
            className="sessions-search-result"
            onClick={() => open(m)}
            title={`Open ${m.sessionLabel ?? m.sessionId} in a new tab`}
          >
            <div className="sessions-search-result-meta">
              <span className="sessions-search-result-project">{m.projectDir}</span>
              {agentBadges.get(m.sessionId) && (
                <span className="sessions-search-result-agent">[{agentBadges.get(m.sessionId)}]</span>
              )}
              <span className="sessions-search-result-label">{m.sessionLabel ?? m.sessionId.slice(0, 8)}</span>
              <span className="sessions-search-result-role">{m.role}</span>
              <span className="sessions-search-result-time">{m.timestamp.slice(0, 19).replace('T', ' ')}</span>
            </div>
            <div className="sessions-search-result-snippet">{m.snippet}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
