import { useCallback, useSyncExternalStore } from 'react'

import type { SessionCompact } from '../contextCompaction/sessionCompact'
import { SessionContextUsage } from '../sessionModel/sessionContextUsage'
import { SessionModelLine } from './sessionModelLine'
import type { SessionModelCurrent, SessionModelStore } from '../sessionModel/sessionModelStore'
import type { ActiveAgentTerminal } from './useActiveAgentTerminal'

/**
 * What this document has to say about the session behind its active tab, or null while it has
 * nothing. The bar reads it rather than the item, because a widget that draws nothing still leaves
 * its slot and its separator behind: whether the item EXISTS is the bar's decision.
 */
export function useSessionModel(
  store: SessionModelStore,
  focus: ActiveAgentTerminal | null,
): SessionModelCurrent | null {
  const subscribe = useCallback((onChanged: () => void) => store.subscribe(onChanged), [store])
  const current = useCallback(() => store.current(), [store])
  const reading = useSyncExternalStore(subscribe, current, current)
  // The bar reads the focus straight out of its own store and pushes it into this one from an
  // effect, so on the commit that draws a new tab the reading in hand is still the old tab's. The
  // reading carries the focus it belongs to precisely so the two cannot come apart here.
  return reading !== null && reading.focus.sessionId === focus?.sessionId ? reading : null
}

/**
 * `Sonnet 4.5 · high · 90k / 1M · 9%` for the session the active tab is attached to.
 *
 * The whole line carries the level's colour rather than the numbers alone: at this size the strip
 * reads as one word, and a fill worth colouring is a fact about the session rather than about the
 * three characters holding the percentage. A model whose window is unknown has no percentage, so it
 * never reaches a colour - the degradation runs the safe way, and the button stays, because what
 * compacting needs is a running session rather than a number.
 *
 * The button is the one thing in the whole bar that WRITES to a session. It reaches the terminal
 * through this document's own registry rather than through the main process, and the session it
 * names is the one the tab in front is attached to - read from the same reading the line is drawn
 * from, so the numbers on screen and the session written to cannot come apart.
 */
export function SessionModelItem(props: {
  reading: SessionModelCurrent
  compact: SessionCompact
  /** Injected so a test can age a reading without waiting for one. */
  now?: number
}): React.JSX.Element {
  const { focus, info, readAt } = props.reading
  const percent = SessionContextUsage.percentOf(info)
  const level = SessionModelLine.levelOf(percent)
  const age = (props.now ?? Date.now()) - readAt
  // Dimmed rather than blanked, and the Compact button goes with it: the last true numbers are
  // still worth reading, while writing into a session that stopped answering is what should stop.
  const stale = SessionContextUsage.isStale(age)
  return (
    <span
      className={`jamat-session-model jamat-session-model--${level}`
        + (stale ? ' jamat-session-model--stale' : '')}
      title={SessionModelLine.tooltipOf(info, focus.agentId, age)}
    >
      {SessionModelLine.lineOf(info)}
      {!stale && SessionModelLine.compactVisible(focus.life) && (
        <button
          className="jamat-session-model__compact"
          type="button"
          title="Compact this session: types /compact into its terminal and runs it"
          onClick={() => props.compact.manual(focus.sessionId)}
        >
          Compact
        </button>
      )}
    </span>
  )
}
