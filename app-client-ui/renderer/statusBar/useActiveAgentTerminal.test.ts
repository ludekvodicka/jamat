import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { SnapshotStore, type SnapshotStorePorts } from '../ipc/snapshotStore'
import { type ActiveTerminalReading, ActiveTerminalStore } from '../shell/activeTerminalStore'
import { SessionsFixtures } from '../sessions/fixtures/sessionsFixtures'
import { useActiveAgentTerminal } from './useActiveAgentTerminal'

describe('app-client-ui/renderer/statusBar/useActiveAgentTerminal', () => {
  class Ports implements SnapshotStorePorts<SessionsSnapshot> {
    snapshot: SessionsSnapshot = SessionsFixtures.mixed()

    read(): Promise<IpcResult<SessionsSnapshot>> {
      return Promise.resolve({ ok: true, value: this.snapshot })
    }

    subscribe(): () => void {
      return () => undefined
    }

    reportError(): void {}
  }

  const stops: (() => void)[] = []

  afterEach(() => {
    cleanup()
    for (const stop of stops.splice(0)) stop()
  })

  function terminalOf(sessionId: string): ActiveTerminalReading {
    return {
      panelId: `terminal:{"sessionId":"${sessionId}"}`,
      target: { kind: 'local', sessionId },
    }
  }

  /** A document with the recorded sessions already in it, the way a mounted window has one. */
  async function sessionsStore(ports: Ports): Promise<SnapshotStore<SessionsSnapshot>> {
    const store = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', ports)
    stops.push(store.start())
    await act(async () => {
      await Promise.resolve()
    })
    return store
  }

  async function push(
    store: SnapshotStore<SessionsSnapshot>,
    ports: Ports,
    snapshot: SessionsSnapshot,
  ): Promise<void> {
    ports.snapshot = snapshot
    await act(async () => {
      store.refresh()
      await Promise.resolve()
    })
  }

  function withLife(
    snapshot: SessionsSnapshot,
    sessionId: string,
    life: SessionInfo['life'],
  ): SessionsSnapshot {
    return {
      ...snapshot,
      revision: snapshot.revision + 1,
      sessions: snapshot.sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, life } : session),
    }
  }

  it('says nothing while no tab of this window is a terminal', async () => {
    const store = await sessionsStore(new Ports())
    const active = new ActiveTerminalStore()

    const view = renderHook(() => useActiveAgentTerminal(active, store))

    expect(view.result.current).toBeNull()
  })

  it('says nothing before the sessions document has arrived', () => {
    const store = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', new Ports())
    const active = new ActiveTerminalStore()
    active.set(terminalOf('s-working'))

    const view = renderHook(() => useActiveAgentTerminal(active, store))

    expect(view.result.current).toBeNull()
  })

  it('joins the active terminal with what the document says about its session', async () => {
    const store = await sessionsStore(new Ports())
    const active = new ActiveTerminalStore()
    const view = renderHook(() => useActiveAgentTerminal(active, store))

    act(() => active.set(terminalOf('s-working')))

    expect(view.result.current).toEqual({
      sessionId: 's-working',
      agentId: 'claude',
      life: 'live',
    })
  })

  // The gate both widgets get for free: a shell has no agent, so there is nothing to draw about it.
  it('says nothing for a shell session', async () => {
    const store = await sessionsStore(new Ports())
    const active = new ActiveTerminalStore()
    active.set(terminalOf('s-shell'))

    const view = renderHook(() => useActiveAgentTerminal(active, store))

    expect(view.result.current).toBeNull()
  })

  it('says nothing for a session this document has no record of', async () => {
    const store = await sessionsStore(new Ports())
    const active = new ActiveTerminalStore()
    active.set(terminalOf('s-gone'))

    const view = renderHook(() => useActiveAgentTerminal(active, store))

    expect(view.result.current).toBeNull()
  })

  it('does not join a remote target to a local session with the same id', async () => {
    const store = await sessionsStore(new Ports())
    const active = new ActiveTerminalStore()
    active.set({
      panelId: 'terminal:{"target":{"kind":"remote","remoteEndpointId":"office","sessionId":"s-working"}}',
      target: { kind: 'remote', remoteEndpointId: 'office', sessionId: 's-working' },
    })

    const view = renderHook(() => useActiveAgentTerminal(active, store))

    expect(view.result.current).toBeNull()
  })

  it('follows the tab, agent and all', async () => {
    const store = await sessionsStore(new Ports())
    const active = new ActiveTerminalStore()
    const view = renderHook(() => useActiveAgentTerminal(active, store))
    act(() => active.set(terminalOf('s-working')))

    act(() => active.set(terminalOf('s-ended')))

    expect(view.result.current).toEqual({
      sessionId: 's-ended',
      agentId: 'codex',
      life: 'ended',
    })
  })

  /**
   * The whole reason the join is a hook over two stores rather than a field on the snapshot: a busy
   * agent moves the sessions document several times a second, and none of those revisions say
   * anything about the tab in front. The reading has to stay the SAME object, or every one of them
   * re-renders the bar.
   */
  it('holds one reading across a revision that moved another session', async () => {
    const ports = new Ports()
    const store = await sessionsStore(ports)
    const active = new ActiveTerminalStore()
    active.set(terminalOf('s-working'))
    const view = renderHook(() => useActiveAgentTerminal(active, store))
    const held = view.result.current

    await push(store, ports, withLife(SessionsFixtures.mixed(), 's-waiting', 'ended'))

    expect(view.result.current).toBe(held)
  })

  it('publishes a new reading when the active session itself moves', async () => {
    const ports = new Ports()
    const store = await sessionsStore(ports)
    const active = new ActiveTerminalStore()
    active.set(terminalOf('s-working'))
    const view = renderHook(() => useActiveAgentTerminal(active, store))

    await push(store, ports, withLife(SessionsFixtures.mixed(), 's-working', 'ended'))

    expect(view.result.current).toEqual({
      sessionId: 's-working',
      agentId: 'claude',
      life: 'ended',
    })
  })
})
