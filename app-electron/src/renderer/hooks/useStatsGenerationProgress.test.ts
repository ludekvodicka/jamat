import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { StatsGenerationProgress } from '../../../../core/types/stats'
import { formatStatsGenerationProgress, useStatsGenerationProgress } from './useStatsGenerationProgress'

afterEach(() => {
  vi.useRealTimers()
  delete (window as any).electronAPI
})

describe('formatStatsGenerationProgress', () => {
  it('formats file counts and every terminal phase', () => {
    expect(formatStatsGenerationProgress({ phase: 'claudeCheck', current: 820, total: 3076 })).toBe('Claude: checking JSONL files 820 / 3,076')
    expect(formatStatsGenerationProgress({ phase: 'claudeParse', current: 3, total: 7 })).toBe('Claude: parsing changed files 3 / 7')
    expect(formatStatsGenerationProgress({ phase: 'codexParse', current: 12400, total: 25215 })).toBe('Codex: indexing rollouts 12,400 / 25,215')
    expect(formatStatsGenerationProgress({ phase: 'complete' })).toBe('Statistics loaded')
  })

  it('correlates progress, counts elapsed seconds, and unsubscribes', () => {
    vi.useFakeTimers()
    let callback: ((progress: StatsGenerationProgress) => void) | null = null
    const unsubscribe = vi.fn()
    ;(window as any).electronAPI = {
      onStatsProgress: (next: (progress: StatsGenerationProgress) => void) => { callback = next; return unsubscribe },
    }
    const { result, unmount } = renderHook(() => useStatsGenerationProgress())
    let requestId = ''
    act(() => { requestId = result.current.begin() })
    act(() => { vi.advanceTimersByTime(2100) })
    expect(result.current.elapsedSeconds).toBe(2)
    act(() => callback?.({ requestId: 'other', phase: 'codexParse', current: 1, total: 2 }))
    expect(result.current.progress?.phase).toBe('starting')
    act(() => callback?.({ requestId, phase: 'codexParse', current: 1, total: 2 }))
    expect(result.current.progress?.phase).toBe('codexParse')
    act(() => result.current.finish())
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
