import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionUncommittedSnapshot } from '../../../lib-orchestrator/sessionUncommitted/sessionUncommitted.types'
import { UncommittedStore, useSessionUncommitted } from './uncommittedStore'

function storeOf(first: SessionUncommittedSnapshot) {
  let snapshot = first
  let changed = (): void => undefined
  const store = new UncommittedStore({
    read: async () => ({ ok: true, value: snapshot }),
    subscribe: (fire) => { changed = fire; return () => { changed = () => undefined } },
    reportError: vi.fn(),
  })
  return { store, push: (next: SessionUncommittedSnapshot) => { snapshot = next; changed() } }
}

describe('app-client-ui/renderer/versioning/uncommittedStore', () => {
  afterEach(() => { vi.useRealTimers() })

  it('names the file count and the sample paths in the title', () => {
    expect(UncommittedStore.titleOf({ files: 2, sample: ['app/a.ts', 'docs/b.md'] }))
      .toBe('Uncommitted session changes: 2 files\napp/a.ts\ndocs/b.md')
    expect(UncommittedStore.titleOf({ files: 1, sample: ['a.ts'] })).toBe('Uncommitted session changes: 1 file\na.ts')
  })

  it('publishes nothing for an unchanged revision pushed twice', async () => {
    vi.useFakeTimers()
    const { store, push } = storeOf({ revision: 1, sessions: { s1: { files: 1, sample: ['a.ts'] } } })
    const published = vi.fn()
    store.subscribe(published)
    const stop = store.start()
    try {
      await vi.advanceTimersByTimeAsync(1)
      expect(published).toHaveBeenCalledTimes(1)
      push({ revision: 1, sessions: { s1: { files: 1, sample: ['a.ts'] } } })
      await vi.advanceTimersByTimeAsync(101)
      push({ revision: 1, sessions: { s1: { files: 1, sample: ['a.ts'] } } })
      await vi.advanceTimersByTimeAsync(101)
      expect(published).toHaveBeenCalledTimes(1)
      push({ revision: 2, sessions: {} })
      await vi.advanceTimersByTimeAsync(101)
      expect(published).toHaveBeenCalledTimes(2)
      expect(store.current().snapshot?.sessions).toEqual({})
    } finally { stop() }
  })

  it('hands one session the same entry while only another session changed', async () => {
    vi.useFakeTimers()
    const { store, push } = storeOf({ revision: 1, sessions: { a: { files: 1, sample: ['a.ts'] }, b: { files: 1, sample: ['b.ts'] } } })
    const stop = store.start()
    try {
      await vi.advanceTimersByTimeAsync(1)
      let renders = 0
      const { result } = renderHook(() => {
        renders += 1
        return useSessionUncommitted(store, 'b')
      })
      const first = result.current
      expect(first).toEqual({ files: 1, sample: ['b.ts'] })
      const rendered = renders
      await act(async () => {
        push({ revision: 2, sessions: { a: { files: 2, sample: ['a.ts', 'c.ts'] }, b: { files: 1, sample: ['b.ts'] } } })
        await vi.advanceTimersByTimeAsync(101)
      })
      expect(store.current().snapshot?.revision).toBe(2)
      expect(result.current).toBe(first)
      expect(renders).toBe(rendered)
      await act(async () => {
        push({ revision: 3, sessions: { a: { files: 2, sample: ['a.ts', 'c.ts'] } } })
        await vi.advanceTimersByTimeAsync(101)
      })
      expect(result.current).toBeNull()
    } finally { stop() }
  })
})
