import { createElement, Fragment } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VersioningCommitOpenSessions } from '../../shared/versioningCommit'
import { CommitOpenStore, useCommitOpen, useSessionCommitOpen } from './commitOpenStore'

afterEach(cleanup)

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

  it('keeps useCommitOpen Set reference stable when sessionIds are unchanged and scopes useSessionCommitOpen to its own session', async () => {
    vi.useFakeTimers()
    let snapshot: VersioningCommitOpenSessions = {
      revision: 1,
      sessionIds: ['s1'],
      reviews: [{ draftId: 'd1', sessionId: 's1', vcs: 'svn', scopeRoot: 'Q:/a', workflow: false }],
    }
    let emit = (): void => undefined
    const store = new CommitOpenStore({
      read: async () => ({ ok: true, value: snapshot }),
      subscribe: (fn) => { emit = fn; return () => { emit = () => undefined } },
      reportError: vi.fn(),
    })
    const stop = store.start()
    const seenSets: ReadonlySet<string>[] = []
    let s1Renders = 0
    let s2Renders = 0
    let remoteRenders = 0
    function TreeProbe() {
      seenSets.push(useCommitOpen(store))
      return null
    }
    function SessionProbe(props: { id: string; enabled: boolean; onRender: () => void }) {
      props.onRender()
      const state = useSessionCommitOpen(store, props.id, props.enabled)
      return createElement('span', { 'data-id': props.id }, `${String(state.open)}:${state.reviews.length}`)
    }
    try {
      await vi.advanceTimersByTimeAsync(1)
      render(createElement(
        Fragment,
        null,
        createElement(TreeProbe),
        createElement(SessionProbe, { id: 's1', enabled: true, onRender: () => { s1Renders += 1 } }),
        createElement(SessionProbe, { id: 's2', enabled: true, onRender: () => { s2Renders += 1 } }),
        createElement(SessionProbe, { id: 's1', enabled: false, onRender: () => { remoteRenders += 1 } }),
      ))
      expect(seenSets).toHaveLength(1)
      expect(s1Renders).toBe(1)
      expect(s2Renders).toBe(1)
      expect(remoteRenders).toBe(1)

      // Add a second review for s1: sessionIds set is unchanged, so TreeProbe keeps the same Set ref, and s2/remote do not re-render.
      snapshot = {
        revision: 2,
        sessionIds: ['s1'],
        reviews: [
          { draftId: 'd1', sessionId: 's1', vcs: 'svn', scopeRoot: 'Q:/a', workflow: false },
          { draftId: 'd2', sessionId: 's1', vcs: 'svn', scopeRoot: 'Q:/b', workflow: false },
        ],
      }
      await act(async () => { emit(); await vi.advanceTimersByTimeAsync(101) })
      expect(seenSets.at(-1)).toBe(seenSets[0])
      expect(s1Renders).toBe(2)
      expect(s2Renders).toBe(1)
      expect(remoteRenders).toBe(1)
    } finally { stop(); vi.useRealTimers() }
  })
})
