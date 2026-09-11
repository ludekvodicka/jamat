import { UiSettings } from '../../shared/uiSettings'
import { UiSettingsStore } from './uiSettingsStore'

/**
 * The wheel, multiplied, for everything in this window except the terminal.
 *
 * A list, a tree and a document are scrolled by Chromium, which takes no setting from us and reads
 * the wheel straight from the OS. So the only way to a speed of our own is to take the event: the
 * handler cancels it and performs the movement itself, multiplied. The terminal is the opposite
 * case and is not here - xterm scrolls a buffer of its own and takes the multiplier as an option -
 * which is why the two are separate rows in the settings card rather than one number.
 *
 * **At 100 % nothing of ours runs.** The multiplier is read per event, so the default costs one
 * number comparison and the event is then the browser's exactly as before: no `preventDefault`, no
 * scrolling by hand, no behaviour to go wrong for everybody who never touched the slider.
 *
 * It is deliberately NOT a capture listener. Anything that handles its own wheel - xterm, a zoom, a
 * widget with a wheel of its own - runs first and, if it acted, has already cancelled the event;
 * this then leaves it alone. Capturing would take the wheel away from all of them.
 */
export class WheelSpeed {
  /** One handler per document, installed where the settings store is started. */
  static install(): () => void {
    const onWheel = (event: WheelEvent): void => WheelSpeed.scrolled(event)
    // Not passive: the whole point is that this event can be cancelled, and a passive listener
    // cannot. Chromium treats a `wheel` listener on the window as passive unless it is told.
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }

  private static scrolled(event: WheelEvent): void {
    const factor = UiSettings.scrollFactorOf(UiSettingsStore.current().scrollSpeedPercent)
    if (factor === 1) return
    // Somebody else's wheel: a zoom (Ctrl, and the same gesture under Meta), a horizontal scroll
    // Chromium composes out of a vertical wheel with Shift, or a handler that has already acted.
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return
    // Chromium reports every wheel in pixels, mouse and trackpad alike. The other two modes belong
    // to the spec rather than to this browser, and turning a "line" into pixels here would scroll
    // by a number nobody measured.
    if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return
    if (event.deltaX === 0 && event.deltaY === 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    // The terminal has its own speed and its own scrolling. Its wheel does not always end in a
    // cancelled event - at the end of the buffer xterm lets the page have it - and a screen that
    // suddenly scrolled the panel behind it at four times the speed would read as a bug.
    if (target.closest('.xterm') !== null) return
    const element = WheelSpeed.scrollableFrom(target, event.deltaX, event.deltaY)
    if (element === null) return
    event.preventDefault()
    // `instant` rather than `auto`: `auto` obeys `scroll-behavior`, so one container styled smooth
    // would animate every notch and fall behind a fast wheel.
    element.scrollBy({
      left: event.deltaX * factor,
      top: event.deltaY * factor,
      behavior: 'instant',
    })
  }

  /**
   * What Chromium would have scrolled: the nearest ancestor that overflows in the direction asked
   * for and still has room to move that way. The room is what keeps the chain intact - a list
   * scrolled to its end hands the wheel to the panel around it, which is what the browser does and
   * what this would otherwise break.
   */
  private static scrollableFrom(target: Element, deltaX: number, deltaY: number): Element | null {
    let node: Element | null = target
    while (node !== null) {
      if (WheelSpeed.moves(node, deltaX, deltaY)) return node
      node = node.parentElement
    }
    // The viewport last, and asked about room alone: a page scrolls when its document overflows,
    // whatever `overflow` says about the two elements at the top of it. A shell that fills the
    // window has no room there and answers null, which leaves the wheel where it started.
    return WheelSpeed.hasRoom(document.documentElement, deltaX, deltaY)
      ? document.documentElement
      : null
  }

  /** A box inside the page: it scrolls only if it was styled to, and only while it has room. */
  private static moves(element: Element, deltaX: number, deltaY: number): boolean {
    const style = getComputedStyle(element)
    if (deltaY !== 0 && WheelSpeed.overflows(style.overflowY)
      && WheelSpeed.room(element.scrollTop, element.scrollHeight, element.clientHeight, deltaY))
      return true
    return deltaX !== 0 && WheelSpeed.overflows(style.overflowX)
      && WheelSpeed.room(element.scrollLeft, element.scrollWidth, element.clientWidth, deltaX)
  }

  private static hasRoom(element: Element, deltaX: number, deltaY: number): boolean {
    if (deltaY !== 0
      && WheelSpeed.room(element.scrollTop, element.scrollHeight, element.clientHeight, deltaY))
      return true
    return deltaX !== 0
      && WheelSpeed.room(element.scrollLeft, element.scrollWidth, element.clientWidth, deltaX)
  }

  private static overflows(value: string): boolean {
    return value === 'auto' || value === 'scroll' || value === 'overlay'
  }

  /**
   * Whether this box can still move the way the wheel is asking. The rounding slack is the sub-pixel
   * one every zoomed layout has: without it a list sitting a third of a pixel from its end is read
   * as able to move, and the wheel stops there instead of reaching the panel behind it.
   */
  private static room(offset: number, scrollSize: number, clientSize: number, delta: number): boolean {
    if (delta > 0) return offset < scrollSize - clientSize - 1
    return offset > 0
  }
}
