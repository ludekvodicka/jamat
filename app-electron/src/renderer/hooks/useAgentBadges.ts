import { useEffect, useState } from 'react'

/**
 * Resolves a one-letter agent badge ("C" Claude / "X" Codex) per
 * sessionId — but only when more than one agent is actually available
 * on PATH. With a single agent (today: Claude only) every row would
 * carry the same letter, so the hook returns an empty map and skips the
 * per-session IPC entirely. Zero cost until a second backend ships.
 *
 * Mirrors the CLI session picker's `showAgentBadges` gate.
 */
export function useAgentBadges(sessionIds: string[]): Map<string, string> {
  const [multiAgent, setMultiAgent] = useState(false)
  const [badges, setBadges] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.listAgents?.()
      .then((list) => {
        if (!cancelled) setMultiAgent((list?.filter((a) => a.available).length ?? 0) > 1)
      })
      .catch(() => { /* single-agent fallback — no badges */ })
    return () => { cancelled = true }
  }, [])

  // Re-resolve when the set of sessions changes. Keyed on the joined ids
  // so a stable list doesn't re-fire.
  const key = sessionIds.join(',')
  useEffect(() => {
    if (!multiAgent || sessionIds.length === 0) {
      setBadges(new Map())
      return
    }
    let cancelled = false
    Promise.all(
      sessionIds.map(async (id) => [id, await window.electronAPI?.resolveAgentForSession?.(id)] as const),
    ).then((pairs) => {
      if (cancelled) return
      const m = new Map<string, string>()
      for (const [id, agent] of pairs) {
        if (agent) m.set(id, agent === 'claude' ? 'C' : 'X')
      }
      setBadges(m)
    }).catch(() => { /* leave badges empty on failure */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiAgent, key])

  return badges
}
