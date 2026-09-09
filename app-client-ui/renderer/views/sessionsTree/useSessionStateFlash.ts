import { useEffect, useRef, useState } from 'react'

import type { SessionGlyph } from './sessionNodeState'

/**
 * How many times this row's state has changed since this window first drew it.
 *
 * It is a COUNT rather than a boolean because the number is used as a React key, and a new key is a
 * new element: a CSS animation restarts only when the element carrying it is new. A session that
 * goes working -> waiting -> working while the first tint is still fading has to blink twice, and a
 * class toggled on an element that is already animating blinks once.
 *
 * The GLYPH alone is read, never the paint beside it. The paint moves when a mark goes out, which
 * happens because the person opened the tab - blinking at somebody for looking at a session is how
 * a signal stops being one.
 *
 * A row this window has never drawn flashes nothing, which needs no guard of its own to say so: the
 * comparison reads a previous value and a first sighting has none. That is the rule
 * `SessionsAttentionModel` keeps for the same reason - a tree that lights up completely on every
 * start teaches the eye to skip it.
 */
export function useSessionStateFlash(glyph: SessionGlyph): number {
  const previous = useRef<SessionGlyph | null>(null)
  const [changes, setChanges] = useState(0)
  useEffect(() => {
    const before = previous.current
    previous.current = glyph
    if (before !== null && before !== glyph)
      setChanges((count) => count + 1)
  }, [glyph])
  return changes
}
