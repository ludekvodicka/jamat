import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionStepInfo } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionStepRow, SessionStepRows } from './sessionStepRow'

describe('app-client-ui/renderer/views/sessionsTree/sessionStepRow', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function step(fields: Partial<SessionStepInfo> = {}): SessionStepInfo {
    return {
      text: 'Removing the worktree',
      detail: '12,000 of 48,000 files',
      progress: { done: 12000, total: 48000 },
      startedAt: 1754600400000,
      ...fields,
    }
  }

  it('draws the text, the muted detail and a running glyph as the library sent them', () => {
    const { container } = render(<SessionStepRow step={step()} />)
    const row = container.querySelector('.jamat-sessions__step')!

    expect(row.querySelector('.jamat-sessions__step-text')?.textContent).toBe('Removing the worktree')
    expect(row.querySelector('.jamat-sessions__step-detail')?.textContent).toBe('12,000 of 48,000 files')
    expect(row.querySelector('[data-paint]')?.getAttribute('data-paint')).toBe('accent')
    expect(row.getAttribute('title')).toBe('Removing the worktree\n12,000 of 48,000 files')
  })

  it('sets the bar width from the counted share', () => {
    const { container } = render(<SessionStepRow step={step()} />)

    expect(container.querySelector<HTMLElement>('.jamat-sessions__step-fill')?.style.getPropertyValue('--step-fraction'))
      .toBe('0.25')
  })

  it('draws no bar without a total, with a zero total or without progress, and no detail when there is none', () => {
    for (const progress of [{ done: 12000, total: null }, { done: 0, total: 0 }, null]) {
      const { container, unmount } = render(<SessionStepRow step={step({ progress, detail: null })} />)
      expect(container.querySelector('.jamat-sessions__step-bar')).toBeNull()
      expect(container.querySelector('.jamat-sessions__step-detail')).toBeNull()
      expect(container.querySelector('.jamat-sessions__step')?.getAttribute('title')).toBe('Removing the worktree')
      unmount()
    }
  })

  it('keeps the share between none and all', () => {
    expect(SessionStepRows.fractionOf(step({ progress: { done: 60000, total: 48000 } }))).toBe(1)
    expect(SessionStepRows.fractionOf(step({ progress: { done: 48000, total: 48000 } }))).toBe(1)
    expect(SessionStepRows.fractionOf(step({ progress: { done: 0, total: 48000 } }))).toBe(0)
    expect(SessionStepRows.fractionOf(step({ progress: { done: 5, total: 0 } }))).toBeNull()
  })

  describe('elapsed seconds', () => {
    const startedAt = 1754600400000

    function elapsedOf(container: HTMLElement): string | null | undefined {
      return container.querySelector('.jamat-sessions__step-elapsed')?.textContent
    }

    it('counts whole seconds from the fixed start, once a second', () => {
      vi.useFakeTimers({ now: startedAt + 3_000 })
      const { container } = render(<SessionStepRow step={step()} />)
      expect(elapsedOf(container)).toBe('3 s')

      act(() => vi.advanceTimersByTime(1_000))
      expect(elapsedOf(container)).toBe('4 s')
    })

    it('counts again from 0 s when a new step begins', () => {
      vi.useFakeTimers({ now: startedAt + 3_000 })
      const { container, rerender } = render(<SessionStepRow step={step()} />)
      expect(elapsedOf(container)).toBe('3 s')

      rerender(<SessionStepRow step={step({ text: 'Recording the result', startedAt: startedAt + 3_000 })} />)
      expect(elapsedOf(container)).toBe('0 s')
      act(() => vi.advanceTimersByTime(1_000))
      expect(elapsedOf(container)).toBe('1 s')
    })

    it('clears its interval on unmount', () => {
      vi.useFakeTimers({ now: startedAt })
      const { unmount } = render(<SessionStepRow step={step()} />)
      expect(vi.getTimerCount()).toBe(1)

      unmount()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('draws no seconds and starts no clock for a step without a start', () => {
      vi.useFakeTimers({ now: startedAt })
      const { container } = render(<SessionStepRow step={step({ startedAt: null })} />)

      expect(container.querySelector('.jamat-sessions__step-elapsed')).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('ticks inside its span alone: the parent does not render again and the node is not rebuilt', () => {
      vi.useFakeTimers({ now: startedAt })
      const node = Object.freeze(step())
      let parentRenders = 0
      function Parent(): React.JSX.Element {
        parentRenders += 1
        return <SessionStepRow step={node} />
      }
      const { container } = render(<Parent />)
      const row = container.querySelector('.jamat-sessions__step')

      act(() => vi.advanceTimersByTime(2_000))

      expect(elapsedOf(container)).toBe('2 s')
      expect(parentRenders).toBe(1)
      expect(container.querySelector('.jamat-sessions__step')).toBe(row)
      expect(node).toEqual(step())
    })
  })
})
