import { describe, expect, it } from 'vitest'

import type {
  RemoteConnectionsSnapshot,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { SessionsSnapshot } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { TerminalTarget } from '../../../shared/terminalTarget'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import { FinalizeAwait } from './finalizeAwait'

describe('app-client-ui/renderer/views/sessionsTree/finalizeAwait', () => {
  const localTarget = { kind: 'local', sessionId: 's-dirty' } as const
  const remoteTarget = {
    kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-dirty',
  } as const

  function endpoint(
    sessions: SessionsSnapshot | null,
  ): RemoteConnectionsSnapshot['outbound'][number] {
    return {
      profileId: 'profile-a',
      remoteComputerId: 'computer-a',
      remoteEndpointId: 'endpoint-a',
      configIdentity: 'config-a',
      runtimeChannel: 'development',
      displayName: 'Office PC',
      endpoint: { host: '127.0.0.1', port: 47_150 },
      status: 'connected',
      error: null,
      lastConnectedAt: null,
      nextRetryAt: null,
      applicationVersion: null,
      optionalOperations: null,
      connectionId: 'connection-a',
      sessions,
    }
  }

  function remote(
    outbound: RemoteConnectionsSnapshot['outbound'],
  ): RemoteConnectionsSnapshot {
    return { revision: 1, outbound, inbound: [] }
  }

  it('distinguishes an unread local snapshot, a missing session and a found session', () => {
    const snapshot = SessionsFixtures.stoppedWorktree()

    expect(FinalizeAwait.findOf(localTarget, null, null)).toEqual({ state: 'unknown-yet' })
    expect(FinalizeAwait.findOf(localTarget, { ...snapshot, sessions: [] }, null))
      .toEqual({ state: 'gone' })
    expect(FinalizeAwait.findOf(localTarget, snapshot, null)).toEqual({
      state: 'found',
      info: snapshot.sessions[0],
      scope: 'local',
    })
  })

  it('distinguishes a missing remote reading, endpoint, connection, payload and session', () => {
    const snapshot = SessionsFixtures.stoppedWorktree()

    expect(FinalizeAwait.findOf(remoteTarget, null, null)).toEqual({ state: 'unknown-yet' })
    expect(FinalizeAwait.findOf(remoteTarget, null, remote([]))).toEqual({ state: 'gone' })
    expect(FinalizeAwait.findOf(remoteTarget, null, remote([{
      ...endpoint(snapshot), status: 'offline', connectionId: null,
    }]))).toEqual({ state: 'gone' })
    expect(FinalizeAwait.findOf(remoteTarget, null, remote([endpoint(null)])))
      .toEqual({ state: 'unknown-yet' })
    expect(FinalizeAwait.findOf(remoteTarget, null, remote([
      endpoint({ ...snapshot, sessions: [] }),
    ]))).toEqual({ state: 'gone' })
    expect(FinalizeAwait.findOf(remoteTarget, null, remote([endpoint(snapshot)]))).toEqual({
      state: 'found',
      info: snapshot.sessions[0],
      scope: 'remote',
    })
  })

  it('builds local and remote asks in their own scopes', () => {
    const snapshot = SessionsFixtures.stoppedWorktree()
    const local = FinalizeAwait.askOf(localTarget, snapshot, null)
    const distant = FinalizeAwait.askOf(remoteTarget, null, remote([endpoint(snapshot)]))

    expect(local?.questions[0].question.choices.map((choice) => choice.id))
      .toEqual(['merge', 'keep', 'discard'])
    expect(distant?.questions[0].question.choices.map((choice) => choice.id))
      .toEqual(['merge', 'keep'])
  })

  it('returns no ask when the target vanished or has no finalize question', () => {
    const snapshot = SessionsFixtures.mixed()
    const plain = { kind: 'local', sessionId: 's-ended' } as const

    expect(FinalizeAwait.askOf(localTarget, { ...snapshot, sessions: [] }, null)).toBeNull()
    expect(FinalizeAwait.askOf(plain, snapshot, null)).toBeNull()
  })

  it('settles against the current wait map without dropping a later accepted target', () => {
    const empty = new Map<string, TerminalTarget>()
    const withFirst = FinalizeAwait.reduce(empty, {
      kind: 'accepted', targetKey: 'local:first', target: localTarget,
    })
    const withBoth = FinalizeAwait.reduce(withFirst, {
      kind: 'accepted', targetKey: 'remote:second', target: remoteTarget,
    })

    const remaining = FinalizeAwait.reduce(withBoth, {
      kind: 'settled', targetKeys: ['local:first'],
    })

    expect([...remaining]).toEqual([['remote:second', remoteTarget]])
  })

  it('throws on a target kind it does not know', () => {
    const target = { kind: 'elsewhere', sessionId: 's-dirty' } as unknown as TerminalTarget

    expect(() => FinalizeAwait.findOf(target, null, null))
      .toThrow('Unknown terminal target')
  })

  it('throws on a wait action it does not know', () => {
    const action = { kind: 'elsewhere' } as unknown as Parameters<typeof FinalizeAwait.reduce>[1]

    expect(() => FinalizeAwait.reduce(new Map(), action))
      .toThrow('Unknown finalize await action')
  })
})
