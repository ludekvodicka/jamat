import { describe, expect, it, vi } from 'vitest'
import { CommitOpenStore } from './commitOpenStore'

describe('app-client-ui/renderer/versioning/commitOpenStore', () => {
  it('coalesces commit events and publishes only a new revision', async () => {
    vi.useFakeTimers()
    let revision = 1
    let changed = (): void => undefined
    const store = new CommitOpenStore({ read: async () => ({ ok: true, value: { revision, sessionIds: ['session'] } }),
      subscribe: (fn) => { changed = fn; return () => { changed = () => undefined } }, reportError: vi.fn() })
    const published = vi.fn()
    store.subscribe(published)
    const stop = store.start()
    try {
      await vi.advanceTimersByTimeAsync(1)
      expect(published).toHaveBeenCalledTimes(1)
      changed(); changed()
      await vi.advanceTimersByTimeAsync(101)
      expect(published).toHaveBeenCalledTimes(1)
      revision++
      changed()
      await vi.advanceTimersByTimeAsync(101)
      expect(published).toHaveBeenCalledTimes(2)
      expect(store.current().snapshot?.sessionIds).toEqual(['session'])
    } finally { stop(); vi.useRealTimers() }
  })
})
