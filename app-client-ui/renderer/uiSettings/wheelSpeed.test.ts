import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UiSettings } from '../../shared/uiSettings'
import { UiSettingsStore } from './uiSettingsStore'
import { WheelSpeed } from './wheelSpeed'

describe('app-client-ui/renderer/uiSettings/wheelSpeed', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    stop = WheelSpeed.install()
  })

  afterEach(() => {
    stop?.()
    stop = null
    UiSettingsStore.reset()
    document.body.replaceChildren()
  })

  /** The speed the window is set to, through the same preview a dragged slider applies. */
  function speed(percent: number): void {
    UiSettingsStore.preview({ ...UiSettings.defaultValue(), scrollSpeedPercent: percent })
  }

  /**
   * A box that scrolls, which in jsdom is a box that SAYS it does: nothing is laid out here, so the
   * sizes and the scroll offset are declared rather than measured, and `scrollBy` is a spy because
   * jsdom implements no scrolling of its own.
   */
  function scrollable(options?: { offset?: number; height?: number; parent?: HTMLElement }): {
    element: HTMLElement
    scrollBy: ReturnType<typeof vi.fn>
  } {
    const element = document.createElement('div')
    element.style.overflowY = 'auto'
    Object.defineProperty(element, 'scrollHeight', { value: options?.height ?? 1000 })
    Object.defineProperty(element, 'clientHeight', { value: 200 })
    Object.defineProperty(element, 'scrollTop', { value: options?.offset ?? 0, writable: true })
    const scrollBy = vi.fn()
    element.scrollBy = scrollBy as unknown as HTMLElement['scrollBy'];
    (options?.parent ?? document.body).append(element)
    return { element, scrollBy }
  }

  function wheel(target: HTMLElement, init?: WheelEventInit): WheelEvent {
    const event = new WheelEvent('wheel', {
      deltaY: 100,
      bubbles: true,
      cancelable: true,
      ...init,
    })
    target.dispatchEvent(event)
    return event
  }

  /*
   * The default costs nothing and does nothing: the listener is installed either way, so the one
   * thing that must be true at 100 % is that the event leaves it exactly as it arrived - no
   * cancelling, no scrolling by hand, no behaviour to go wrong for anybody who never touched it.
   */
  it('leaves the wheel to the window at 100 %', () => {
    const { element, scrollBy } = scrollable()

    const event = wheel(element)

    expect(event.defaultPrevented).toBe(false)
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('takes the wheel and moves the box by the multiplied delta', () => {
    speed(250)
    const { element, scrollBy } = scrollable()

    const event = wheel(element, { deltaY: 100, deltaX: 40 })

    expect(event.defaultPrevented).toBe(true)
    expect(scrollBy).toHaveBeenCalledWith({ left: 100, top: 250, behavior: 'instant' })
  })

  it('moves it more slowly below 100 %, because the slider goes both ways', () => {
    speed(50)
    const { element, scrollBy } = scrollable()

    wheel(element, { deltaY: 120 })

    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: 60, behavior: 'instant' })
  })

  // Ctrl and Meta are the zoom, and Shift is how Chromium composes a horizontal scroll out of a
  // vertical wheel. None of the three is the gesture this speed is about.
  it('leaves a zoom and a shifted wheel alone', () => {
    speed(300)
    const { element, scrollBy } = scrollable()

    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      const event = wheel(element, init)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(scrollBy).not.toHaveBeenCalled()
  })

  /*
   * The terminal scrolls a buffer of its own at a speed of its own, and its wheel does not always
   * end in a cancelled event - at the end of the buffer xterm lets the page have it. A screen that
   * suddenly scrolled the panel behind it three times as fast would read as a bug.
   */
  it('leaves the terminal to its own speed', () => {
    speed(300)
    const holder = document.createElement('div')
    holder.className = 'xterm'
    document.body.append(holder)
    const { element, scrollBy } = scrollable({ parent: holder })

    const event = wheel(element)

    expect(event.defaultPrevented).toBe(false)
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('leaves an event another handler has already taken', () => {
    speed(300)
    const { element, scrollBy } = scrollable()
    element.addEventListener('wheel', (event) => event.preventDefault())

    wheel(element)

    expect(scrollBy).not.toHaveBeenCalled()
  })

  /*
   * The scroll chain, which is what a naive multiplier breaks: a list scrolled to its end hands the
   * wheel to the panel around it. Reading only the nearest overflow box would stop the wheel dead
   * at the bottom of every list.
   */
  it('hands the wheel to the box behind one that cannot move that way', () => {
    speed(200)
    const outer = scrollable()
    const inner = scrollable({ parent: outer.element, offset: 800 })

    wheel(inner.element)

    expect(inner.scrollBy).not.toHaveBeenCalled()
    expect(outer.scrollBy).toHaveBeenCalledWith({ left: 0, top: 200, behavior: 'instant' })
  })

  it('does nothing where nothing under the pointer scrolls at all', () => {
    speed(200)
    const plain = document.createElement('div')
    document.body.append(plain)

    const event = wheel(plain)

    expect(event.defaultPrevented).toBe(false)
  })

  it('stops answering once it is uninstalled', () => {
    speed(300)
    const { element, scrollBy } = scrollable()

    stop?.()
    stop = null
    wheel(element)

    expect(scrollBy).not.toHaveBeenCalled()
  })
})
