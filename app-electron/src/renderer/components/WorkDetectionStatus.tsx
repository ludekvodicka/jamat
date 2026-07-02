import { useEffect, useState } from 'react'
import { useLayoutStore } from '../store/layout-store'
import { matchBusy, BUSY_SIGNAL_NAMES, type BusySignalName } from '../../../../core/agents/claude/patterns'

/**
 * Always-on status-bar read-out of the work-detection classifier for the ACTIVE terminal — shows
 * the current state AND why (which busy markers fire, from which source). The user kept seeing a
 * session reported "done" while Claude was visibly working; this surfaces the live decision so a
 * disagreement is obvious the instant it happens (and tells us which detection source is failing).
 *
 * Two sources are scored independently:
 *  • screen — the rendered xterm bottom rows (the robust source; Claude's status line always renders
 *    here, even when the raw PTY stream only carries differential spinner diffs).
 *  • raw — the raw PTY tail (what the old detection relied on).
 * The classifier ORs them, so `busy = screen || raw`. If `busy` is true but the tab STATUS shows
 * idle (or vice-versa), the row turns red — that mismatch is the bug we're chasing.
 *
 * Mounting flips `detectionDebug` on so useTerminal publishes the tails; unmount turns it off.
 */

const SHORT: Record<BusySignalName, string> = {
  escToInterrupt: 'esc',
  tokenCounter: 'tok',
  elapsedDot: 'el·',
  elapsedEllipsis: 'el…',
  spinnerGlyph: 'glyph',
}

const STATUS_COLOR: Record<string, string> = {
  idle: '#888',
  running: '#4caf50',
  'tool-use': '#42a5f5',
  blocked: '#ef5350',
  waiting: '#ffca28',
  done: '#26a69a',
}

const fired = (sig: Record<BusySignalName, string | null>): BusySignalName[] =>
  BUSY_SIGNAL_NAMES.filter((n) => sig[n]) as BusySignalName[]

export function WorkDetectionStatus() {
  const setDetectionDebug = useLayoutStore((s) => s.setDetectionDebug)
  const activePanel = useLayoutStore((s) => s.activePanel)
  const terminalStatus = useLayoutStore((s) => s.terminalStatus)
  const terminalDebug = useLayoutStore((s) => s.terminalDebug)
  const [, setTick] = useState(0)

  useEffect(() => {
    setDetectionDebug(true)
    const t = setInterval(() => setTick((n) => n + 1), 500)
    return () => { clearInterval(t); setDetectionDebug(false) }
  }, [setDetectionDebug])

  if (!activePanel) return null
  const dbg = terminalDebug[activePanel]
  // No published tail yet → this active panel isn't a classified terminal (Settings/Help/etc.).
  if (!dbg) return null

  const status = terminalStatus[activePanel] ?? 'idle'
  const scr = matchBusy(dbg.screen)
  const raw = matchBusy(dbg.tail)
  const busy = scr.busy || raw.busy
  const ageMs = Date.now() - dbg.ts

  const scrFired = fired(scr.signals)
  const rawFired = fired(raw.signals)

  // The tell: detection says BUSY but the tab settled to idle/done (or the reverse). Highlight it.
  const statusIsWork = status === 'running' || status === 'tool-use' || status === 'blocked' || status === 'waiting'
  const mismatch = busy !== statusIsWork

  const summary =
    `scr[${scrFired.map((n) => SHORT[n]).join(',') || '—'}] ` +
    `raw[${rawFired.map((n) => SHORT[n]).join(',') || '—'}]`

  // NOTE: keep the title content STABLE between 500ms ticks. A native `title` tooltip is dismissed by
  // Chromium whenever the attribute value changes while hovering, so anything that updates every render
  // (the live `ageMs`) must NOT go in here — it would re-write the title every 500ms and the tooltip
  // could never settle past its ~1s show delay (that's why the buffer hover "stopped working"). The
  // live age stays in the visible bar below; the title only changes when the buffers/markers do.
  const title =
    `WORK DETECTION (active terminal ${activePanel})\n` +
    `tab status: ${status}\n` +
    `busy verdict: ${busy ? 'YES (working)' : 'NO (idle)'}  (screen=${scr.busy} raw=${raw.busy})\n` +
    (mismatch ? `⚠ MISMATCH: detection says ${busy ? 'busy' : 'idle'} but tab status is ${status}\n` : '') +
    `\nscreen markers: ${scrFired.length ? scrFired.map((n) => `${n}=${JSON.stringify(scr.signals[n])}`).join('  ') : '(none)'}\n` +
    `raw markers:    ${rawFired.length ? rawFired.map((n) => `${n}=${JSON.stringify(raw.signals[n])}`).join('  ') : '(none)'}\n` +
    `\n── rendered screen bottom (robust source) ──\n${dbg.screen || '(empty)'}\n` +
    `\n── raw PTY tail (space-preserved) ──\n${(dbg.tail || '(empty)').slice(-400)}`

  return (
    <span
      className="status-item"
      title={title}
      style={{
        fontFamily: 'monospace',
        fontSize: '11px',
        cursor: 'default',
        color: mismatch ? '#ef5350' : '#e8e8e8',
        fontWeight: mismatch ? 700 : 400,
      }}
    >
      <span style={{ color: STATUS_COLOR[status] ?? '#e8e8e8' }}>●</span>
      {' '}det:{busy ? 'WORK' : 'idle'}/{status}
      {' '}<span style={{ opacity: 0.9 }}>{summary}</span>
      {' '}<span style={{ opacity: 0.75 }}>{ageMs > 9999 ? '9s+' : `${ageMs}ms`}</span>
    </span>
  )
}
