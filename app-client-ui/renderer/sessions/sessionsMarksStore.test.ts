import { describe, expect, it } from 'vitest'

import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteConnectionsSnapshot,
} from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import type { SnapshotStore } from '../ipc/snapshotStore'
import { SessionsMarksStore } from './sessionsMarksStore'

describe('app-client-ui/renderer/sessions/sessionsMarksStore', () => {
  /** Only the two members the store actually reads, so the real store's ports stay out of this. */
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

  class RemoteSnapshots {
    private readonly listeners = new Set<() => void>()
    private value: RemoteConnectionsSnapshot | null = null
    private revision = 0

    current(): { snapshot: RemoteConnectionsSnapshot | null } {
      return { snapshot: this.value }
    }

    subscribe(listener: () => void): () => void {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    }

    push(endpoints: readonly { remoteEndpointId: string; sessions: readonly SessionInfo[] }[]): void {
      this.value = {
        revision: ++this.revision,
        outbound: endpoints.map((entry) => ({
          profileId: `profile-${entry.remoteEndpointId}`,
          remoteComputerId: `computer-${entry.remoteEndpointId}`,
          remoteEndpointId: entry.remoteEndpointId,
          configIdentity: `config-${entry.remoteEndpointId}`,
          runtimeChannel: 'development',
          displayName: entry.remoteEndpointId,
          endpoint: { host: '127.0.0.1', port: 47_150 },
          status: 'connected',
          lastConnectedAt: null,
          nextRetryAt: null,
          applicationVersion: null,
          optionalOperations: null,
          error: null,
          connectionId: `connection-${entry.remoteEndpointId}`,
          sessions: { sessions: entry.sessions } as unknown as SessionsSnapshot,
        })),
        inbound: [],
      }
      for (const listener of [...this.listeners]) listener()
    }
  }

  function sessionOf(over: Partial<SessionInfo> = {}): SessionInfo {
    return {
      sessionId: 's-1',
      kind: 'agent',
      title: 'Alpha',
      titleParts: { number: null, name: 'Alpha' },
      tabTitle: 'Terminal - Alpha',
      directory: { mode: 'default' },
      project: { kind: 'none' },
      agent: { agentId: 'claude' },
      life: 'live',
      activity: 'working',
      admits: ['newBeside', 'compact'],
      ...over,
    }
  }

  function storeOf(): { snapshots: Snapshots; store: SessionsMarksStore; notified: () => number } {
    const snapshots = new Snapshots()
    const store = new SessionsMarksStore(snapshots as unknown as SnapshotStore<SessionsSnapshot>)
    store.start()
    let count = 0
    store.subscribe(() => { count += 1 })
    return { snapshots, store, notified: () => count }
  }

  it('marks a session whose turn settled while it was not on screen', () => {
    const { snapshots, store } = storeOf()
    snapshots.push([sessionOf()])
    expect(store.markedOf('s-1')).toBe(false)

    snapshots.push([sessionOf({ activity: 'idle' })])
    expect(store.markedOf('s-1')).toBe(true)
  })

  it('puts the mark out when that session comes to the front', () => {
    const { snapshots, store } = storeOf()
    snapshots.push([sessionOf()])
    snapshots.push([sessionOf({ activity: 'idle' })])

    store.setActiveTargets(new Set(['s-1']))
    expect(store.markedOf('s-1')).toBe(false)
    expect(store.current().activeTargetKeys.has('s-1')).toBe(true)
  })

  /** The rule survives the move out of the tree: a first sighting is a baseline, not news. */
  it('raises nothing from the first snapshot it ever sees', () => {
    const { snapshots, store } = storeOf()
    snapshots.push([sessionOf({ activity: 'idle'})])

    expect(store.markedOf('s-1')).toBe(false)
  })

  /**
   * The model builds fresh maps on every call, so without a gate every poll would re-render every
   * subscriber. A snapshot that moved nothing must keep the previous view object.
   */
  it('keeps the old view and notifies nobody when nothing moved', () => {
    const { snapshots, store, notified } = storeOf()
    snapshots.push([sessionOf()])
    const first = store.current()
    const after = notified()

    snapshots.push([sessionOf()])
    expect(store.current()).toBe(first)
    expect(notified()).toBe(after)
  })

  it('notifies when the set of sessions on screen changes, so the Attention filter follows it', () => {
    const { snapshots, store, notified } = storeOf()
    snapshots.push([sessionOf()])
    const before = notified()

    store.setActiveTargets(new Set(['s-1']))
    expect(notified()).toBeGreaterThan(before)
    expect(store.current().activeTargetKeys.has('s-1')).toBe(true)
  })

  /**
   * The visibility event can arrive before the first snapshot - a Host that is down, or simply the
   * boot order - and that branch used to assign a fresh view and return without telling anybody.
   * `current()` is the `getSnapshot` of a `useSyncExternalStore`, so a subscriber kept the old
   * active set until something else happened to re-render it.
   */
  it('publishes the sessions on screen even before the first snapshot', () => {
    const { store, notified } = storeOf()

    store.setActiveTargets(new Set(['s-1']))

    expect(notified()).toBe(1)
    expect(store.current().activeTargetKeys.has('s-1')).toBe(true)
    // And an unchanged set is still silent, exactly as it is once a snapshot exists.
    store.setActiveTargets(new Set(['s-1']))
    expect(notified()).toBe(1)
  })

  it('answers false for a session it has never heard of', () => {
    const { snapshots, store } = storeOf()
    snapshots.push([sessionOf()])

    expect(store.markedOf('s-missing')).toBe(false)
  })

  it('keeps attention distinct for the same remote session id on two endpoints', () => {
    const local = new Snapshots()
    const remote = new RemoteSnapshots()
    const store = new SessionsMarksStore(
      local as unknown as SnapshotStore<SessionsSnapshot>,
      remote as unknown as SnapshotStore<RemoteConnectionsSnapshot>,
    )
    store.start()
    const firstKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-1',
    })
    const secondKey = TerminalTargetCodec.key({
      kind: 'remote', remoteEndpointId: 'endpoint-b', sessionId: 's-1',
    })
    remote.push([
      { remoteEndpointId: 'endpoint-a', sessions: [sessionOf()] },
      { remoteEndpointId: 'endpoint-b', sessions: [sessionOf()] },
    ])
    remote.push([
      { remoteEndpointId: 'endpoint-a', sessions: [sessionOf({ activity: 'idle' })] },
      { remoteEndpointId: 'endpoint-b', sessions: [sessionOf()] },
    ])

    expect(store.markedOf(firstKey)).toBe(true)
    expect(store.markedOf(secondKey)).toBe(false)
    store.setActiveTargets(new Set([firstKey]))
    expect(store.markedOf(firstKey)).toBe(false)
    expect(store.current().activeTargetKeys).toEqual(new Set([firstKey]))
  })
})
