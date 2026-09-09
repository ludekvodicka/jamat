import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { LoadSidebarsResult } from '../../../shared/appClientUiIpc'
import { ErrorText } from '../../../shared/errorText'
import {
  type SidebarSide,
  SidebarsState,
  type SidebarsStateValue,
} from '../../../shared/sidebarsState'
import { WorkspaceSaveLimits } from '../workspaceSaveLimits'
import type { SidebarRegistry } from './sidebarRegistry'

export interface SidebarsPorts {
  load(): Promise<LoadSidebarsResult>
  /** Answers whether the state reached disk; the cursor advances only on true. */
  save(state: SidebarsStateValue): Promise<boolean>
  reportError(message: string): void
}

export interface SidebarsHandle {
  state: SidebarsStateValue
  toggle(side: SidebarSide): void
  resize(side: SidebarSide, width: number): void
  /** Called before the window closes: the debounce would otherwise eat the last change. */
  flush(): void
}

/**
 * Holds the global sidebar state in React and stores it under the same rules as the layout: a
 * failed read latches and never writes again, a state identical to the one read is not written
 * back, and a drag of the splitter is one write rather than one per pixel.
 */
export function useSidebars(registry: SidebarRegistry, ports: SidebarsPorts): SidebarsHandle {
  const [state, setState] = useState<SidebarsStateValue>(() =>
    SidebarsState.withKnownViews(SidebarsState.default(), (side) => registry.keysOf(side)))
  const latched = useRef(false)
  /** The last state read or STORED; a save that would repeat it is not a change. */
  const persisted = useRef<string | null>(null)
  /** The state of a write that has not answered yet, so a burst does not send it twice. */
  const inFlight = useRef<string | null>(null)
  /** What the timer will look at when it fires - never what the state was when it was armed. */
  const latest = useRef(state)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let disposed = false
    // The armed timer is deliberately left alone: `persist` refuses once the latch is set, so this
    // is one rule in one place. Clearing it here as well would answer the latch test with the
    // clearTimeout and leave the check that actually protects the file untested.
    const latch = (message: string): void => {
      latched.current = true
      ports.reportError(message)
    }
    void ports.load()
      .then((result) => {
        if (disposed)
          return
        if (result.failed) {
          latch('Stored sidebar state could not be read; this session will not overwrite it')
          return
        }
        if (!result.sidebars)
          return
        const restored = SidebarsState.withKnownViews(
          SidebarsState.coerce(result.sidebars),
          (side) => registry.keysOf(side),
        )
        persisted.current = JSON.stringify(restored)
        latest.current = restored
        setState(restored)
      })
      // A read that rejects is a read that failed. Without this the hook keeps a fully writable
      // default and the first toggle stores it over whatever the file holds.
      .catch((error: unknown) => {
        if (!disposed)
          latch(`Stored sidebar state could not be read (${ErrorText.of(error)}); this session will not overwrite it`)
      })
    return () => { disposed = true }
  }, [ports, registry])

  /**
   * Every rule is answered HERE, when the timer fires, never when it was armed - the same shape
   * `TabsController.persist` uses and for the same reasons. A change undone inside the debounce
   * window leaves an armed timer holding a state that is no longer current; reading `latest` at
   * fire time is what stops it from writing the state the user already took back.
   */
  const persist = useCallback(() => {
    if (latched.current)
      return
    const value = latest.current
    const serialized = JSON.stringify(value)
    if (serialized === persisted.current || serialized === inFlight.current)
      return
    // The cursor moves only once the write is confirmed, so a refused write leaves the change
    // pending instead of being remembered as stored.
    inFlight.current = serialized
    void ports.save(value)
      .then((stored) => {
        inFlight.current = null
        if (!stored)
          return
        persisted.current = serialized
        // The state can move again while the write is in flight, and a move BACK to the stored
        // value arms nothing (the effect sees no change against the old cursor). Re-reading here is
        // what stops the file from keeping a state the user already took back.
        if (JSON.stringify(latest.current) !== serialized)
          persist()
      })
      .catch((error: unknown) => {
        // Without this the guard would hold this value forever and the same state could never be
        // written again, silently.
        inFlight.current = null
        ports.reportError(`Sidebar state could not be stored: ${ErrorText.of(error)}`)
      })
  }, [ports])

  useEffect(() => {
    latest.current = state
    if (latched.current)
      return
    const serialized = JSON.stringify(state)
    // The first state this effect sees is the default nobody asked for; storing it would write a
    // file on every start of an app the user never touched.
    if (persisted.current === null) {
      persisted.current = serialized
      return
    }
    if (serialized === persisted.current)
      return
    if (timer.current)
      clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      persist()
    }, WorkspaceSaveLimits.debounceMilliseconds)
  }, [state, persist])

  // A timer that outlives the window would call into a closure that is gone.
  useEffect(() => () => {
    if (timer.current)
      clearTimeout(timer.current)
    timer.current = null
  }, [])

  const flush = useCallback(() => {
    if (!timer.current)
      return
    clearTimeout(timer.current)
    timer.current = null
    persist()
  }, [persist])

  const toggle = useCallback(
    (side: SidebarSide) => setState((current) => SidebarsState.toggled(current, side)),
    [],
  )
  const resize = useCallback(
    (side: SidebarSide, width: number) =>
      setState((current) => SidebarsState.withWidth(current, side, width)),
    [],
  )

  // Memoised, so the handle's identity changes when the state does and not on every render of the
  // shell. Every consumer that keys an effect on it - the command binding and the beforeunload
  // listener today - would otherwise tear that effect down and build it again each time.
  return useMemo(() => ({ state, toggle, resize, flush }), [state, toggle, resize, flush])
}
