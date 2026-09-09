import { describe, expect, it } from 'vitest'

import type {
  RemoteConnectionsSnapshot,
  RemoteOutboundEndpointDto,
} from '../../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { ComputersScreenModel, type ComputersScreenState } from './computersScreenModel'

describe('app-client-ui/renderer/overlays/launcher/computers/computersScreenModel', () => {
  function endpoint(
    remoteEndpointId: string,
    displayName: string,
    status: RemoteOutboundEndpointDto['status'],
    sessions: number | null = null,
  ): RemoteOutboundEndpointDto {
    return {
      profileId: `profile-${remoteEndpointId}`,
      remoteComputerId: `computer-${displayName}`,
      remoteEndpointId,
      configIdentity: 'identity',
      runtimeChannel: 'development',
      displayName,
      endpoint: { host: '203.0.113.10', port: 47_150 },
      status,
      error: null,
      lastConnectedAt: null,
      nextRetryAt: null,
      applicationVersion: null,
      optionalOperations: null,
      connectionId: status === 'connected' ? 'connection' : null,
      sessions: sessions === null
        ? null
        : {
            revision: 1,
            reconciled: true,
            host: {
              presence: 'unreachable',
              hostVersion: null,
              hostInstanceId: null,
              liveCount: 0,
              lastStartError: null,
            },
            categories: [],
            sessions: Array.from({ length: sessions }, () => null) as never,
            orphans: [],
          },
    }
  }

  function snapshotOf(...outbound: RemoteOutboundEndpointDto[]): RemoteConnectionsSnapshot {
    return { revision: 1, outbound, inbound: [] }
  }

  function loaded(...outbound: RemoteOutboundEndpointDto[]): ComputersScreenState {
    return ComputersScreenModel.transition(ComputersScreenModel.initial().state, {
      input: 'snapshotLoaded',
      rows: ComputersScreenModel.rowsOf(snapshotOf(...outbound)),
    }).state
  }

  it('asks for the connected computers as its first act', () => {
    expect(ComputersScreenModel.initial().effects).toEqual([{ effect: 'fetchComputers' }])
    expect(ComputersScreenModel.initial().state.loaded).toBe(false)
  })

  /*
   * The same rule the sessions tree is pinned to, and the reason it is pinned in two places: a card
   * that offered a computer this one cannot reach would take a project, a name and an agent before
   * saying so. Everything left out here is listed in Settings -> Remote Control with its reason.
   */
  it('draws the connected computers and none of the other three states', () => {
    const rows = ComputersScreenModel.rowsOf(snapshotOf(
      endpoint('a', 'Studio', 'connected', 2),
      endpoint('b', 'Laptop', 'offline'),
      endpoint('c', 'Bench', 'connecting'),
      endpoint('d', 'Attic', 'idle'),
    ))

    expect(rows).toEqual([{
      remoteEndpointId: 'a',
      displayName: 'Studio',
      endpointLabel: '203.0.113.10:47150',
      sessionCount: 2,
    }])
  })

  it('throws on a status nobody has decided about here', () => {
    expect(() => ComputersScreenModel.rowsOf(
      snapshotOf(endpoint('a', 'Studio', 'paused' as never))))
      .toThrow(/Unknown remote endpoint status/)
  })

  // "Nobody has looked yet" and "nothing is connected" are the same empty list otherwise.
  it('says it is still reading before the first snapshot, and offers the settings after it', () => {
    expect(ComputersScreenModel.emptyRefusal(ComputersScreenModel.initial().state))
      .toBe('Reading the connected computers…')
    expect(ComputersScreenModel.emptyRefusal(loaded()))
      .toBe('No connected computers. Pair one and connect it in Settings → Remote Control.')
    expect(ComputersScreenModel.emptyRefusal(loaded(endpoint('a', 'Studio', 'connected'))))
      .toBeNull()
  })

  // By name, so the order does not follow whatever the snapshot happened to list first.
  it('draws the computers by name', () => {
    const state = loaded(endpoint('a', 'Studio', 'connected'), endpoint('b', 'Bench', 'connected'))

    expect(state.rows.map((row) => row.displayName)).toEqual(['Bench', 'Studio'])
  })

  it('hands the chosen computer on, and answers an empty list with nothing at all', () => {
    const state = loaded(endpoint('a', 'Studio', 'connected'), endpoint('b', 'Bench', 'connected'))

    expect(ComputersScreenModel.transition(state, { input: 'activate' }).effects).toEqual([{
      effect: 'chosen',
      target: { remoteEndpointId: 'b', displayName: 'Bench' },
    }])
    const moved = ComputersScreenModel.transition(state, { input: 'moveCursor', delta: 1 }).state
    expect(ComputersScreenModel.transition(moved, { input: 'activate' }).effects).toEqual([{
      effect: 'chosen',
      target: { remoteEndpointId: 'a', displayName: 'Studio' },
    }])
    expect(ComputersScreenModel.transition(loaded(), { input: 'activate' }).effects).toEqual([])
  })

  it('opens the row the mouse named rather than the one the cursor was on', () => {
    const state = loaded(endpoint('a', 'Studio', 'connected'), endpoint('b', 'Bench', 'connected'))

    expect(ComputersScreenModel.transition(state, { input: 'openRow', index: 1 }).effects)
      .toEqual([{ effect: 'chosen', target: { remoteEndpointId: 'a', displayName: 'Studio' } }])
  })

  /*
   * A computer dropping off mid-flow is a normal state. The cursor follows the row it was standing
   * on rather than the index it was standing at, so a computer that went away above the cursor does
   * not silently move the choice onto its neighbour.
   */
  it('keeps the cursor on the same computer when another one disappears', () => {
    const three = loaded(
      endpoint('a', 'Attic', 'connected'),
      endpoint('b', 'Bench', 'connected'),
      endpoint('c', 'Studio', 'connected'),
    )
    const onStudio = ComputersScreenModel.transition(three, { input: 'moveCursor', delta: 2 }).state
    expect(onStudio.rows[onStudio.cursor]?.displayName).toBe('Studio')

    const withoutAttic = ComputersScreenModel.transition(onStudio, {
      input: 'snapshotLoaded',
      rows: ComputersScreenModel.rowsOf(snapshotOf(
        endpoint('b', 'Bench', 'connected'),
        endpoint('c', 'Studio', 'connected'),
      )),
    }).state

    expect(withoutAttic.rows[withoutAttic.cursor]?.displayName).toBe('Studio')
  })

  it('clamps the cursor onto what is left when the computer it stood on is the one that went', () => {
    const two = loaded(endpoint('a', 'Attic', 'connected'), endpoint('b', 'Bench', 'connected'))
    const onBench = ComputersScreenModel.transition(two, { input: 'moveCursor', delta: 1 }).state

    const alone = ComputersScreenModel.transition(onBench, {
      input: 'snapshotLoaded',
      rows: ComputersScreenModel.rowsOf(snapshotOf(endpoint('a', 'Attic', 'connected'))),
    }).state

    expect(alone.cursor).toBe(0)
    expect(alone.rows).toHaveLength(1)
  })

  it('sends Escape and the settings request out as their own effects', () => {
    expect(ComputersScreenModel.transition(loaded(), { input: 'escape' }).effects)
      .toEqual([{ effect: 'close' }])
    expect(ComputersScreenModel.transition(loaded(), { input: 'openSettings' }).effects)
      .toEqual([{ effect: 'openSettings' }])
  })

  it('throws on an input it does not know', () => {
    expect(() => ComputersScreenModel.transition(loaded(), { input: 'teleport' } as never))
      .toThrow(/Unknown computers screen input/)
  })
})
