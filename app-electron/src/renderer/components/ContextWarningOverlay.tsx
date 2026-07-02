import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { resolveContextLevels } from '../utils/context-level'
import { useLayoutStore } from '../store/layout-store'
import type { RemotePeer } from '../../../../core/types/remote-control'

/**
 * Context-fullness nudge — a centered, semi-transparent card drawn over the terminal when a Claude
 * session crosses a configured popup threshold (a `contextLevels` entry with `popup` on) AND the
 * session is idle (work finished, prompt waiting). Offers Compact (runs /compact) or Postpone.
 * Postpone snoozes THIS level — the card reappears only once context climbs to the NEXT threshold.
 * Closing (✕ / Esc) is the same as Postpone.
 *
 * It does NOT poll on its own: it rides the per-tab context poll already running in CustomTab,
 * which broadcasts `context-pct {id, pct}`, plus the `terminal-status {id, status}` events from
 * useTerminal. So no extra transcript reads beyond what the tab indicator already does.
 *
 * Reset is path-agnostic: when context % DROPS below the last-acknowledged level — a /compact
 * anywhere (this button, the status-bar button, the tab menu, a hand-typed /compact, /clear, a
 * fresh session) all shrink the transcript tail — the dismissed level re-arms to 0, so the next
 * climb past a threshold nudges again.
 *
 * Thresholds come from the user-configured `contextLevels` (Settings → Context warnings): the popup
 * fires only at the levels whose `popup` is on; the accent colour is the level's severity-rank
 * colour, so a popup-only level (no `statusBar`) still shows a coloured card.
 */

interface Props {
  terminalId: string
  /** The panel's params — carries `peer` + `terminalId` for a remote-viewer tab (compact routing). */
  params?: Record<string, unknown>
}

export function ContextWarningOverlay({ terminalId, params }: Props) {
  const [pct, setPct] = useState<number | null>(null)
  // Is a turn in progress? Driven by terminal-status events. Starts true ("assume busy until we
  // learn otherwise") so we never flash the card over a terminal that opened straight into work;
  // the mount grace below flips it to idle when a tab opens into an ALREADY-idle (e.g. resumed)
  // session, which emits no status transition and would otherwise leave this stuck.
  const [active, setActive] = useState(true)
  const [visible, setVisible] = useState(false)
  const [shownLevel, setShownLevel] = useState(0)
  // The highest threshold the user has acknowledged for the CURRENT context era. A ref (not state)
  // because the decide-effect reads it inline and re-runs on pct/active changes anyway.
  const dismissedLevelRef = useRef(0)
  // Whether any terminal-status event has arrived yet — distinguishes "opened idle, no event"
  // (→ nudge on open) from "actively working" (→ wait).
  const sawStatusRef = useRef(false)

  // User-configured warning levels (Settings → Context warnings); the popup fires only at the
  // levels whose `popup` is on. `resolved` is sorted ascending by pct; undefined config → defaults.
  const contextLevels = useLayoutStore(s => s.appConfig?.contextLevels)
  const resolved = useMemo(() => resolveContextLevels(contextLevels), [contextLevels])
  const popupThresholds = useMemo(() => resolved.filter(l => l.popup).map(l => l.pct), [resolved])
  // Highest popup threshold the pct has exceeded, or 0 below the first.
  const levelFor = useCallback((p: number): number => {
    let lvl = 0
    for (const t of popupThresholds) if (p > t) lvl = t
    return lvl
  }, [popupThresholds])

  // pct from CustomTab's per-tab poll — no extra poll here.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (d?.id === terminalId) setPct(typeof d.pct === 'number' ? d.pct : null)
    }
    window.addEventListener('context-pct', handler)
    return () => window.removeEventListener('context-pct', handler)
  }, [terminalId])

  // Track whether a turn is in progress. running / tool-use / blocked / waiting are all "active"
  // (the card never covers an in-progress turn or a question/permission menu); only 'idle' clears it.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (d?.id === terminalId) {
        sawStatusRef.current = true
        setActive(d.status !== 'idle')
      }
    }
    window.addEventListener('terminal-status', handler)
    return () => window.removeEventListener('terminal-status', handler)
  }, [terminalId])

  // Open-into-idle: a tab that opens straight into an already-idle session (e.g. resuming a large
  // one) emits no status transition — useTerminal starts at 'idle' and only dispatches on change —
  // so `active` would stay stuck at its initial true. If no status event lands shortly after mount,
  // treat the terminal as idle so an already-over-limit session nudges immediately on open. A tab
  // that opened into work fires 'running' on its first data chunk (well under this grace), marking
  // sawStatus, so this no-ops there.
  useEffect(() => {
    const t = setTimeout(() => { if (!sawStatusRef.current) setActive(false) }, 1500)
    return () => clearTimeout(t)
  }, [])

  // Decide visibility. Re-runs whenever pct (poll) or active (status) changes.
  useEffect(() => {
    if (pct == null) return
    const lvl = levelFor(pct)
    // Context shrank below what we'd acknowledged → a compact/clear/reset happened somewhere →
    // re-arm so the next threshold crossing nudges again.
    if (lvl < dismissedLevelRef.current) dismissedLevelRef.current = 0
    if (active) { setVisible(false); return } // only nudge once the turn is done
    if (lvl > dismissedLevelRef.current) {
      setShownLevel(lvl)
      setVisible(true)
    } else if (lvl < shownLevel) {
      // pct dropped below the level the OPEN card is showing — a /compact-clear-reset, or the
      // transcript tail flipping to a synthetic/low-usage turn — so the open nudge is stale.
      // Hide it instead of leaving a contradictory "Context N% full" (e.g. "0% full") card up.
      setVisible(false)
    }
  }, [pct, active, shownLevel, levelFor])

  // Postpone / ✕ / Esc: acknowledge the current level — reappears only at the next higher threshold.
  const snooze = useCallback(() => {
    dismissedLevelRef.current = shownLevel
    setVisible(false)
  }, [shownLevel])

  const doCompact = useCallback(() => {
    // Hide now; the post-compact pct drop will re-arm dismissed back to 0 for the next era.
    dismissedLevelRef.current = shownLevel
    setVisible(false)
    const peer = params?.peer as RemotePeer | undefined
    const tid = params?.terminalId as string | undefined
    if (peer && tid) {
      void window.electronAPI?.remoteOp?.(peer, 'control:write-keys', [{ terminalId: tid, data: '/compact\r' }])
    } else {
      window.electronAPI?.writeTerminal?.(terminalId, '/compact\r')
    }
  }, [shownLevel, params, terminalId])

  // Esc closes (== Postpone). Capture so it doesn't also reach the terminal underneath.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); snooze() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, snooze])

  if (!visible || pct == null) return null
  // Accent = the SHOWN level's severity-rank colour (works even for a popup-only level that has no
  // statusBar tier); fall back to amber if the level vanished from config mid-display.
  const accent = resolved.find(l => l.pct === shownLevel)?.visual.color ?? '#e0b000'

  return (
    <div className="ctx-warning-overlay" style={{ borderColor: accent }} role="alertdialog" aria-label="Context getting full">
      <button className="ctx-warning-close" onClick={snooze} title="Close (Esc) — same as Postpone">✕</button>
      <div className="ctx-warning-title" style={{ color: accent }}>Context {pct}% full</div>
      <div className="ctx-warning-bar">
        <div className="ctx-warning-bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: accent }} />
      </div>
      <div className="ctx-warning-msg">
        This session is getting large. Compacting summarizes the history so far and frees up context.
      </div>
      <div className="ctx-warning-actions">
        <button
          className="ctx-warning-btn ctx-warning-btn-primary"
          style={{ background: accent, borderColor: accent }}
          onClick={doCompact}
        >
          Compact now
        </button>
        <button className="ctx-warning-btn" onClick={snooze}>Postpone</button>
      </div>
    </div>
  )
}
