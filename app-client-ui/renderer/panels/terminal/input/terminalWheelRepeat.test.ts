import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { TerminalWheelRepeat } from './terminalWheelRepeat'

describe('app-client-ui/renderer/panels/terminal/input/terminalWheelRepeat', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  /**
   * The screen the wheel is turned over, with xterm's listener on it: every wheel event that
   * reaches the screen is one xterm would encode - the turn itself, and each copy the repeat
   * dispatched after it - and xterm asks the handler about every one of them, copies included.
   */
  function screen(allow: (event: WheelEvent) => boolean): {
    element: HTMLElement
    seen: readonly WheelEvent[]
    answerTo: (event: WheelEvent) => boolean
  } {
    const element = document.createElement('div')
    document.body.append(element)
    const seen: WheelEvent[] = []
    const answers = new Map<WheelEvent, boolean>()
    element.addEventListener('wheel', (event) => {
      seen.push(event)
      answers.set(event, allow(event))
    })
    return {
      element,
      seen,
      answerTo: (event) => {
        const answer = answers.get(event)
        if (answer === undefined) throw new Error('The screen was never asked about that event')
        return answer
      },
    }
  }

  /**
   * xterm, as much of it as this file needs: the one hook it offers over the wheel, and the two
   * facts that say whether the wheel is going to the application. The default is the case the
   * repeat exists for - an agent reporting the mouse on the alternate screen.
   */
  function install(
    factorOf: () => number,
    scrolls: 'application' | 'viewport' = 'application',
  ): (event: WheelEvent) => boolean {
    let handler: ((event: WheelEvent) => boolean) | null = null
    const terminal = {
      modes: { mouseTrackingMode: scrolls === 'application' ? 'any' : 'none' },
      buffer: { active: { type: scrolls === 'application' ? 'alternate' : 'normal' } },
      attachCustomWheelEventHandler: (given: (event: WheelEvent) => boolean) => {
        handler = given
      },
    } as unknown as Terminal
    TerminalWheelRepeat.install(terminal, factorOf)
    if (handler === null) throw new Error('The repeat installed no handler')
    return handler
  }

  /** One turn of the wheel over the screen, answered by the handler xterm's listener asked. */
  function turn(
    view: { element: HTMLElement; answerTo: (event: WheelEvent) => boolean },
    init: WheelEventInit,
  ): boolean {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    view.element.dispatchEvent(event)
    return view.answerTo(event)
  }

  /*
   * The default is the case that must not change: an agent holding the mouse behaves exactly as it
   * did before the slider existed, so nothing is copied and nothing is dropped.
   */
  it('sends one notch per turn at 100 %', () => {
    const view = screen(install(() => 1))

    expect(turn(view, { deltaY: 100 })).toBe(true)

    expect(view.seen.length).toBe(1)
  })

  it('turns one notch into three at 300 %', () => {
    const view = screen(install(() => 3))

    expect(turn(view, { deltaY: 100 })).toBe(true)

    // The turn xterm goes on to encode, and the two copies that reached the same screen.
    expect(view.seen.length).toBe(3)
  })

  it('carries the pointer, because the mouse report encodes where the wheel turned', () => {
    const view = screen(install(() => 2))

    turn(view, { deltaY: 120, clientX: 40, clientY: 90 })

    const copy = view.seen[1]
    expect(copy?.clientX).toBe(40)
    expect(copy?.clientY).toBe(90)
    expect(copy?.deltaY).toBe(120)
  })

  /*
   * A copy has to pass straight through, or each one spawns copies of its own and one turn of the
   * wheel becomes a flood the agent never stops scrolling on.
   */
  it('multiplies the turn once, never the copies it made', () => {
    const view = screen(install(() => 4))

    turn(view, { deltaY: 100 })

    expect(view.seen.length).toBe(4)
  })

  /*
   * xterm asks about every wheel over the screen, the ones it scrolls itself included, and there
   * `scrollSensitivity` has already multiplied the distance. A copy on that path would multiply the
   * same setting twice - 250 % would scroll six and a quarter times as far.
   */
  it('copies nothing where xterm scrolls its own viewport', () => {
    const view = screen(install(() => 3, 'viewport'))

    expect(turn(view, { deltaY: 100 })).toBe(true)

    expect(view.seen.length).toBe(1)
  })

  it('drops notches below 100 %, which is the same slider going the other way', () => {
    const view = screen(install(() => 0.5))

    const answers = [turn(view, { deltaY: 100 }), turn(view, { deltaY: 100 })]

    // Half speed is every second turn refused: xterm neither reports nor translates a refused one.
    expect(answers).toEqual([false, true])
    expect(view.seen.length).toBe(2)
  })

  it('spends the fraction a speed like 250 % leaves behind', () => {
    const view = screen(install(() => 2.5))

    turn(view, { deltaY: 100 })
    const first = view.seen.length
    turn(view, { deltaY: 100 })

    expect(first).toBe(2)
    expect(view.seen.length - first).toBe(3)
  })

  /*
   * The fraction belongs to the direction it was earned in. Carried across, a turn back up would
   * arrive with somebody else's remainder and move one line further than it was asked to.
   */
  it('starts the count again when the wheel turns the other way', () => {
    const view = screen(install(() => 1.5))

    turn(view, { deltaY: 100 })
    const down = view.seen.length
    turn(view, { deltaY: -100 })

    expect(down).toBe(1)
    expect(view.seen.length - down).toBe(1)
  })
})
