import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  RemoteConnectionsSnapshot,
} from '../../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SnapshotStore } from '../../../ipc/snapshotStore'
import { useTerminalSessionInfo } from './useTerminalSessionInfo'

describe('app-client-ui/renderer/panels/terminal/attach/useTerminalSessionInfo', () => {
  afterEach(cleanup)

  function infoOf(sessionId: string, activity: SessionInfo['activity']): SessionInfo {
    return {
      sessionId,
      kind: 'agent',
      title: '001 - work',
      titleParts: { number: '001', name: 'work' },
      tabTitle: 'Project - 001 - work',
      directory: { mode: 'default' },
      project: { kind: 'none' },
      life: 'live',
      activity,
      admits: [],
    }
  }

  function snapshotOf(sessions: readonly SessionInfo[], revision: number): SessionsSnapshot {
    return {
      revision,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: null,
        hostInstanceId: null,
        liveCount: sessions.length,
        lastStartError: null,
      },
      categories: [],
      // Deserialized afresh on every read, which is what the hook exists to absorb.
      sessions: structuredClone(sessions) as SessionInfo[],
      orphans: [],
    }
  }

  /**
   * The snapshot's revision moves whenever ANY session's activity does, and every read hands back
   * freshly deserialized objects. Without this the panel drawing session one re-rendered every time
   * session two blinked.
   */
  it('keeps one record while its content holds and replaces it when the content moves', async () => {
    let sessions: readonly SessionInfo[] = [infoOf('one', 'working'), infoOf('two', 'idle')]
    let revision = 1
    const local = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', {
      read: async () => ({ ok: true as const, value: snapshotOf(sessions, revision) }),
      subscribe: () => () => undefined,
      reportError: () => undefined,
    })
    const remote = new SnapshotStore<RemoteConnectionsSnapshot>('The remote connections', {
      read: async () => ({ ok: true as const, value: { revision: 1, outbound: [], inbound: [] } }),
      subscribe: () => () => undefined,
      reportError: () => undefined,
    })
    const stop = local.start()
    const stopRemote = remote.start()
    await act(async () => { await Promise.resolve() })

    const { result, rerender } = renderHook(() => useTerminalSessionInfo(
      local, remote, { kind: 'local', sessionId: 'one' }))
    const first = result.current
    expect(first?.activity).toBe('working')

    // Another session moved: a new snapshot, a new revision, and nothing about session one.
    sessions = [infoOf('one', 'working'), infoOf('two', 'working')]
    revision = 2
    await act(async () => { await local.refresh() })
    rerender()
    expect(result.current).toBe(first)

    sessions = [infoOf('one', 'idle'), infoOf('two', 'working')]
    revision = 3
    await act(async () => { await local.refresh() })
    rerender()
    expect(result.current).not.toBe(first)
    expect(result.current?.activity).toBe('idle')

    stop()
    stopRemote()
  })
})
