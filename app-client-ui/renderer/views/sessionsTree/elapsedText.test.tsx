import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ElapsedText } from './elapsedText'

describe('app-client-ui/renderer/views/sessionsTree/elapsedText', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('counts whole seconds on the shared clock and shares one interval across mounted rows', () => {
    vi.useFakeTimers()
    const base = 1_754_400_000_000
    vi.setSystemTime(base)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    const view = render(
      <>
        <ElapsedText startedAt={base} />
        <ElapsedText startedAt={base - 5_000} />
      </>,
    )

    const spans = (): string[] => [...view.container.querySelectorAll('.jamat-sessions__elapsed')]
      .map((node) => node.textContent ?? '')

    expect(spans()).toEqual(['0 s', '5 s'])
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)

    act(() => { vi.advanceTimersByTime(60_000) })
    expect(spans()).toEqual(['1 min 0 s', '1 min 5 s'])

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(spans()).toEqual(['1 min 1 s', '1 min 6 s'])
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })
})
