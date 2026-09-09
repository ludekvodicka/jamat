import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SnapshotStore } from '../ipc/snapshotStore'
import { SessionsMarksStore } from './sessionsMarksStore'
import { useSessionMarked } from './useSessionMarked'

describe('app-client-ui/renderer/sessions/useSessionMarked', () => {
  afterEach(cleanup)

  /** Only the two members the store reads, the same stand-in its own tests use. */
  class Snapshots {
    private readonly listeners = new Set<() => void>()
    private value: SessionsSnapshot | null = null

    current(): { snapshot: SessionsSnapshot | null } {
      return { snapshot: this.value }
    }

    subscribe(listener: () => void): () => void {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    }

    push(sessions: readonly SessionInfo[]): void {
      this.value = { sessions } as unknown as SessionsSnapshot
      for (const listener of [...this.listeners]) listener()
    }
  }

  function sessionOf(sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo {
    return {
      sessionId,
      kind: 'agent',
      title: sessionId,
      titleParts: { number: null, name: sessionId },
      tabTitle: `Terminal - ${sessionId}`,
      directory: { mode: 'default' },
      project: { kind: 'none' },
      agent: { agentId: 'claude' },
      life: 'live',
      activity: 'working',
      admits: [],
      ...over,
    }
  }

  /**
   * The hook's whole reason for existing, and the thing nothing tested: it hands back a BOOLEAN, so
   * React compares by value and a mark that moved on some OTHER session re-renders nothing here. A
   * component holding the view itself would redraw on every snapshot tick instead.
   */
  it('does not re-render when a mark moves on another session', () => {
    const snapshots = new Snapshots()
    const store = new SessionsMarksStore(snapshots as unknown as SnapshotStore<SessionsSnapshot>)
    store.start()
    let renders = 0
    function Subject(): React.JSX.Element {
      renders += 1
      return <span>{useSessionMarked(store, 's-1') ? 'marked' : 'clear'}</span>
    }

    // A baseline snapshot raises nothing: a mark needs a turn to settle.
    snapshots.push([sessionOf('s-1'), sessionOf('s-2')])
    const view = render(<Subject />)
    expect(view.container.textContent).toBe('clear')
    const before = renders

    // s-2 finishes its turn, so ITS mark goes up. Nothing about s-1 moved.
    act(() => { snapshots.push([sessionOf('s-1'), sessionOf('s-2', { activity: 'idle' })]) })

    expect(store.markedOf('s-2')).toBe(true)
    expect(renders).toBe(before)
    expect(view.container.textContent).toBe('clear')

    // And the session it IS about still reaches it.
    act(() => {
      snapshots.push([sessionOf('s-1', { activity: 'idle' }), sessionOf('s-2', { activity: 'idle' })])
    })

    expect(view.container.textContent).toBe('marked')
    expect(renders).toBeGreaterThan(before)
  })
})
