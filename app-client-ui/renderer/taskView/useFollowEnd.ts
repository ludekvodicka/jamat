import { useLayoutEffect, useRef } from 'react'

/**
 * Keeps a scroller at its end while the person reads the end. Only the person's own scrolling (wheel,
 * keys, touch, a scrollbar drag) changes whether it follows: a focus, a scroll anchor or this hook's
 * own scroll never does, so a step that focuses its heading cannot stop the pane from following.
 */
export function useFollowEnd(scroller: HTMLElement | null, startAtEnd = true): void {
  // Read at the first attach only: a settled transcript opens at its prompt and stays there.
  const startFollowing = useRef(startAtEnd)
  useLayoutEffect(() => {
    if (scroller === null) return
    let following = startFollowing.current
    let personUntil = 0
    let pointerDown = false
    const toEnd = (): void => { if (following) scroller.scrollTop = scroller.scrollHeight }
    const person = (): void => { personUntil = performance.now() + FollowEnd.personScrollMsConst }
    const pointer = (down: boolean) => (): void => { pointerDown = down; person() }
    const onScroll = (): void => {
      if (!pointerDown && performance.now() > personUntil) return
      following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FollowEnd.endSlackPxConst
    }
    const mutations = new MutationObserver(toEnd)
    mutations.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-expanded'] })
    // A pane shown again after another split tab covered it has a size again, but no content changed.
    const sizes = new ResizeObserver(toEnd)
    sizes.observe(scroller)
    const pressed = pointer(true)
    const released = pointer(false)
    scroller.addEventListener('wheel', person, { passive: true })
    scroller.addEventListener('touchmove', person, { passive: true })
    scroller.addEventListener('keydown', person)
    scroller.addEventListener('pointerdown', pressed)
    window.addEventListener('pointerup', released)
    scroller.addEventListener('scroll', onScroll)
    toEnd()
    return () => {
      mutations.disconnect()
      sizes.disconnect()
      scroller.removeEventListener('wheel', person)
      scroller.removeEventListener('touchmove', person)
      scroller.removeEventListener('keydown', person)
      scroller.removeEventListener('pointerdown', pressed)
      window.removeEventListener('pointerup', released)
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [scroller])
}

export class FollowEnd {
  /** How near the end still counts as the end: a fractional scroll position never reaches 0. */
  static readonly endSlackPxConst = 24
  /** A smooth wheel or key scroll lands its last scroll event within this time after the input. */
  static readonly personScrollMsConst = 500
}
