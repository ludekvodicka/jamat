import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../../../shared/appClientUiReport'
import { ErrorText } from '../../../../shared/errorText'
import type { SplitPinRecord } from '../../../../shared/splitPinsState'
import { type PanelSplitHandle, PanelSplitParams } from '../../../widgets/tabs/panelSplit'

export type TerminalSplitPinsStore = Pick<AppClientUiBridge['state'], 'loadSplitPins' | 'saveSplitPins'>

/**
 * The session's pinned split items, kept in the client state beside the layout. The layout already
 * restores an open tab; this store is what brings the pins back into a tab that was closed, after
 * Reset Layout and after a restart.
 *
 * Nothing is written before the stored list was read, so a panel that mounts without its pins
 * cannot erase them. The write follows the split rather than a close, which is why a tab closed by
 * any path, a window that quits and a crash all leave the last list behind.
 */
export function useTerminalSplitPins(
  sessionId: string,
  enabled: boolean,
  split: PanelSplitHandle,
  store: TerminalSplitPinsStore,
): void {
  /** The list the store holds, as JSON; null until it was read, and then saving is allowed. */
  const stored = useRef<string | null>(null)
  const splitRef = useRef(split)
  // Bumped by the read, so a layout that holds more pins than the store still writes them back.
  const [reads, setReads] = useState(0)
  useLayoutEffect(() => { splitRef.current = split }, [split])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    stored.current = null
    void store.loadSplitPins(sessionId).then((answer) => {
      if (cancelled) return
      if (!answer.ok) {
        AppClientUiReport.error(`Reading the split pins of ${sessionId} failed: ${answer.error}`)
        return
      }
      stored.current = JSON.stringify(answer.value)
      splitRef.current.restorePinned(answer.value)
      setReads((count) => count + 1)
    }, (error: unknown) => {
      if (!cancelled) AppClientUiReport.error(`Reading the split pins of ${sessionId} failed: ${ErrorText.of(error)}`)
    })
    return () => { cancelled = true }
  }, [enabled, sessionId, store])

  const pinned = JSON.stringify(PanelSplitParams.pinnedOf(split.state))
  useEffect(() => {
    if (stored.current === null || stored.current === pinned) return
    stored.current = pinned
    void store.saveSplitPins(sessionId, JSON.parse(pinned) as SplitPinRecord[]).then((answer) => {
      if (!answer.ok)
        AppClientUiReport.error(`Saving the split pins of ${sessionId} failed: ${answer.error}`)
      else if (!answer.value)
        AppClientUiReport.error(`The client state refused the split pins of ${sessionId}`)
    }, (error: unknown) => {
      AppClientUiReport.error(`Saving the split pins of ${sessionId} failed: ${ErrorText.of(error)}`)
    })
  }, [pinned, reads, sessionId, store])
}
