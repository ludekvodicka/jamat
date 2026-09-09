import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionModelInfo,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { SessionCompact } from '../contextCompaction/sessionCompact'
import { TerminalInputRegistry } from '../shell/terminalInputRegistry'
import { SessionModelItem } from './sessionModelItem'
import type { SessionModelCurrent } from '../sessionModel/sessionModelStore'
import type { ActiveAgentTerminal } from './useActiveAgentTerminal'

describe('app-client-ui/renderer/statusBar/sessionModelItem', () => {
  let inputs: TerminalInputRegistry
  let sessionCompact: SessionCompact
  /** Every submit the button made, so the session it named is read rather than assumed. */
  let submitted: { sessionId: string; text: string }[]
  /** What the registry answers: false is the state where no live terminal holds that session. */
  let accepts = true
  function infoOf(overrides: Partial<SessionModelInfo> = {}): SessionModelInfo {
    return {
      model: 'claude-sonnet-4-5-20260101',
      modelLabel: 'Sonnet 4.5',
      effortLevel: 'high',
      contextTokens: 90_000,
      contextWindow: 1_000_000,
      ...overrides,
    }
  }

  /** The clock the widget is drawn against, so a reading can be aged without waiting for one. */
  const nowConst = 1_700_000_000_000

  function readingOf(
    info: SessionModelInfo,
    focus: Partial<ActiveAgentTerminal> = {},
    readAt = nowConst,
  ): SessionModelCurrent {
    return {
      focus: { sessionId: 's-a', agentId: 'claude', life: 'live', ...focus },
      info,
      readAt,
    }
  }

  function widget(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-session-model')
    if (!(found instanceof HTMLElement))
      throw new Error(`The bar drew no session model widget: ${container.textContent}`)
    return found
  }

  function draw(reading: SessionModelCurrent): HTMLElement {
    return render(
      <SessionModelItem reading={reading} compact={sessionCompact} now={nowConst} />,
    ).container
  }

  function compact(container: HTMLElement): HTMLButtonElement | null {
    const found = container.querySelector('.jamat-session-model__compact')
    return found instanceof HTMLButtonElement ? found : null
  }

  /**
   * The line alone. The button sits INSIDE the widget - it travels with the line it is about - so
   * the widget's own text carries it, and since the button no longer waits for a threshold it is
   * there in nearly every reading.
   */
  function line(container: HTMLElement): string {
    const text = widget(container).textContent ?? ''
    const button = compact(container)?.textContent ?? ''
    return button === '' ? text : text.slice(0, -button.length)
  }

  beforeEach(() => {
    submitted = []
    accepts = true
    inputs = new TerminalInputRegistry()
    vi.spyOn(inputs, 'submit').mockImplementation((sessionId: string, text: string) => {
      submitted.push({ sessionId, text })
      return accepts
    })
    sessionCompact = new SessionCompact(inputs, {
      claimAutomatic: () => Promise.resolve({ ok: true, value: true }),
      cooldown: () => Promise.resolve({ ok: true, value: null }),
      noteManual: () => Promise.resolve({ ok: true, value: undefined }),
      reportError: (message) => AppClientUiReport.error(message),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('draws the model, the effort and how full the context is', () => {
    const container = draw(readingOf(infoOf()))

    expect(line(container)).toBe('Sonnet 4.5 · high · 90k / 1M · 9%')
    expect(widget(container).classList).toContain('jamat-session-model--none')
  })

  it('carries the level of the fill as a class rather than a colour of its own', () => {
    const levels = [
      { contextTokens: 450_000, level: 'notice' },
      { contextTokens: 750_000, level: 'warn' },
      { contextTokens: 850_000, level: 'danger' },
    ]

    for (const { contextTokens, level } of levels) {
      const container = draw(readingOf(infoOf({ contextTokens })))
      expect(widget(container).classList).toContain(`jamat-session-model--${level}`)
      cleanup()
    }
  })

  /** Answer 5: what it says is still true - it is what the conversation ended on. */
  it('draws a session that has ended', () => {
    const container = draw(readingOf(infoOf(), { life: 'ended' }))

    expect(line(container)).toBe('Sonnet 4.5 · high · 90k / 1M · 9%')
  })

  // Answer 2: the model and the tokens still stand, and without a percentage there is no colour.
  it('draws what it knows about a model with no known window, and no colour', () => {
    const container = draw(readingOf(infoOf({ contextWindow: null })))

    expect(line(container)).toBe('Sonnet 4.5 · high · 90k')
    expect(widget(container).classList).toContain('jamat-session-model--none')
  })

  /** R6: the asymmetry between the two agents is said where a user can read it. */
  it('says in the tooltip that a Claude effort is the project setting', () => {
    const container = draw(readingOf(infoOf()))

    expect(widget(container).getAttribute('title'))
      .toContain("the project's setting, not the running agent's live state")
  })

  it('carries no such caveat for a Codex session', () => {
    const container = draw(
      readingOf(infoOf({ model: 'gpt-5-codex', modelLabel: 'gpt-5-codex' }), { agentId: 'codex' }),
    )

    const title = widget(container).getAttribute('title') ?? ''
    expect(title).toContain('Effort: high')
    expect(title).not.toContain('project')
  })

  /**
   * The only thing in the whole bar that writes to a session, and the third of the three things
   * that keep it off the wrong one: the session it names is the one the line beside it is drawn
   * from, so what is on screen and what is written to are the same reading.
   */
  describe('the Compact button', () => {
    it('appears for a session that is still running, however empty its context is', () => {
      const container = draw(readingOf(infoOf({ contextTokens: 12_000 })))

      expect(compact(container)?.textContent).toBe('Compact')
      expect(line(container)).toContain('1%')
    })

    // Answer 5: the line still says what the conversation ended on, and there is nothing to compact.
    it('stays away for a session that has ended, however full it is', () => {
      const reading = readingOf(infoOf({ contextTokens: 900_000 }), { life: 'ended' })
      expect(compact(draw(reading))).toBeNull()
    })

    it('stays away for a session that was lost, and for one still starting', () => {
      const full = infoOf({ contextTokens: 900_000 })
      expect(compact(draw(readingOf(full, { life: 'lost' })))).toBeNull()
      cleanup()
      expect(compact(draw(readingOf(full, { life: 'starting' })))).toBeNull()
    })

    // No percentage, so no colour - and since 2026-08-27 that no longer takes the button too: the
    // session runs, so compacting it is something the user is allowed to ask for.
    it('appears for a model whose window is unknown', () => {
      const reading = readingOf(infoOf({ contextTokens: 900_000, contextWindow: null }))
      expect(compact(draw(reading))).not.toBeNull()
    })

    it('writes the command into the session the line is about, and no other', () => {
      const reading = readingOf(infoOf(), { sessionId: 's-in-front' })
      const button = compact(draw(reading))
      if (button === null) throw new Error('the widget drew no Compact button')

      fireEvent.click(button)

      expect(submitted).toEqual([{ sessionId: 's-in-front', text: '/compact' }])
    })

    /** A click that reaches nobody is a line in the console: the bar has no room for a sentence. */
    it('says so in the console when no live terminal holds that session, and does not throw', () => {
      accepts = false
      const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const button = compact(draw(readingOf(infoOf())))
      if (button === null) throw new Error('the widget drew no Compact button')

      expect(() => fireEvent.click(button)).not.toThrow()

      expect(reported.mock.calls[0][0]).toContain('no live terminal is attached for session s-a')
    })
  })

  /*
   * A reading is kept when a later read answers nothing - a session with nothing to say yet and one
   * that has ended answer the same way, and the last true reading is the truest thing this window
   * knows. What was missing is any sign of its AGE: a live session whose transcript stopped being
   * readable went on drawing the same numbers in the same colour, with the same Compact button, for
   * hours.
   */
  it('dims a reading that stopped being refreshed, and says how old it is', () => {
    const fresh = widget(draw(readingOf(infoOf())))
    expect(fresh.className).not.toContain('jamat-session-model--stale')
    expect(fresh.getAttribute('title')).not.toContain('stopped answering')

    const old = widget(draw(readingOf(infoOf(), {}, nowConst - 5 * 60_000)))

    expect(old.className).toContain('jamat-session-model--stale')
    expect(old.getAttribute('title')).toContain('Last read 5min ago')
    // Still drawn: the numbers are the last true ones, and blanking them says less than dimming.
    expect(old.textContent).toContain('Sonnet 4.5')
  })

  it('takes the Compact button away once the numbers cannot be refreshed', () => {
    const nearlyFull = infoOf({ contextTokens: 900_000 })

    expect(compact(draw(readingOf(nearlyFull)))).not.toBeNull()
    expect(compact(draw(readingOf(nearlyFull, {}, nowConst - 5 * 60_000)))).toBeNull()
  })

  it('says nothing about age while the poll is merely between ticks', () => {
    const betweenTicks = widget(draw(readingOf(infoOf(), {}, nowConst - 25_000)))

    expect(betweenTicks.className).not.toContain('jamat-session-model--stale')
    expect(betweenTicks.getAttribute('title')).not.toContain('Last read')
  })
})
