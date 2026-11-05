import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useFollowEnd } from './useFollowEnd'

describe('useFollowEnd', () => {
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  /** jsdom has no layout: the scroller's height grows by 20 px per row, its view is 100 px high. */
  function scroller(rows: number): HTMLElement {
    const element = document.createElement('section')
    for (let row = 0; row < rows; row++) element.append(document.createElement('p'))
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => element.childElementCount * 20 })
    Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 100 })
    document.body.append(element)
    return element
  }

  async function addRows(element: HTMLElement, count: number): Promise<void> {
    await act(async () => {
      for (let row = 0; row < count; row++) element.append(document.createElement('p'))
      await Promise.resolve()
    })
  }

  function personScrollsTo(element: HTMLElement, top: number): void {
    fireEvent.wheel(element)
    element.scrollTop = top
    fireEvent.scroll(element)
  }

  it('keeps a scroller at its end while 20 new rows arrive', async () => {
    const element = scroller(10)
    renderHook(() => useFollowEnd(element))
    expect(element.scrollTop).toBe(200)
    await addRows(element, 20)
    expect(element.scrollTop).toBe(600)
  })

  it('keeps the position after the person scrolls up 200 px, then resumes within 24 px of the end', async () => {
    const element = scroller(30)
    renderHook(() => useFollowEnd(element))
    personScrollsTo(element, 400)
    await addRows(element, 5)
    expect(element.scrollTop).toBe(400)

    personScrollsTo(element, 680)
    await addRows(element, 1)
    expect(element.scrollTop).toBe(720)
  })

  it('keeps following when a focus or another programmatic scroll moves the scroller away from the end', async () => {
    const element = scroller(30)
    renderHook(() => useFollowEnd(element))
    element.scrollTop = 100
    fireEvent.scroll(element)
    await addRows(element, 1)
    expect(element.scrollTop).toBe(620)
  })

  it('scrolls to the end when a part of the scroller is shown or expanded while following', async () => {
    const element = scroller(30)
    const toggle = element.firstElementChild!
    renderHook(() => useFollowEnd(element))
    element.scrollTop = 0
    await act(async () => {
      toggle.setAttribute('aria-expanded', 'true')
      await Promise.resolve()
    })
    expect(element.scrollTop).toBe(600)
  })

  it('opens a scroller that starts away from its end at the top until the person reaches the end', async () => {
    const element = scroller(30)
    renderHook(() => useFollowEnd(element, false))
    expect(element.scrollTop).toBe(0)
    await addRows(element, 1)
    expect(element.scrollTop).toBe(0)

    personScrollsTo(element, 520)
    await addRows(element, 1)
    expect(element.scrollTop).toBe(640)
  })
})
