import { afterEach, describe, expect, it } from 'vitest'

import type {
  RateMonitorDebugStatus,
  RateMonitorSnapshot,
} from '../../../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { AppClientUiBridge, IpcResult } from '../../../../shared/appClientUiIpc'
import { RateDebugFixtures } from './fixtures/rateDebugFixtures'
import { RateDebugEffects, type RateDebugPorts } from './rateDebugEffects'
import type { RateDebugEffect, RateDebugInput } from './rateDebugModel'

describe('app-client-ui/renderer/debugWindow/sections/rate/rateDebugEffects', () => {
  const snapshotConst: RateMonitorSnapshot = {
    revision: 4,
    providers: { claude: { kind: 'never-read' }, codex: { kind: 'never-read' } },
  }

  interface Bridge {
    debugStatus: IpcResult<RateMonitorDebugStatus>
    refresh: IpcResult<RateMonitorSnapshot>
  }

  function installBridge(answers: Partial<Bridge>): RateDebugInput[] {
    const bridge = {
      rateMonitor: {
        debugStatus: () => Promise.resolve(
          answers.debugStatus ?? { ok: true as const, value: RateDebugFixtures.status() },
        ),
        refresh: () => Promise.resolve(
          answers.refresh ?? { ok: true as const, value: snapshotConst },
        ),
      },
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
      Pick<AppClientUiBridge, 'rateMonitor'>
    return []
  }

  /** What the section hands the effects: the dispatch, and the one way back to its reader. */
  function ports(dispatched: RateDebugInput[], reads: string[] = []): RateDebugPorts {
    return {
      dispatch: (input) => dispatched.push(input),
      readAgain: () => reads.push('read'),
    }
  }

  afterEach(() => {
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  /*
   * A load asks the section's READER, rather than reaching for the channel itself: the coalescing,
   * the single-flight and the give-up all live in the reader, and a second path into
   * `rate:debug-status` would carry none of them - one full read of both providers' raw payloads per
   * push.
   */
  it('asks the reader to read again rather than reading itself', async () => {
    const dispatched = installBridge({ debugStatus: { ok: true, value: RateDebugFixtures.status() } })
    const reads: string[] = []

    await RateDebugEffects.run({ effect: 'load' }, ports(dispatched, reads))

    expect(reads).toEqual(['read'])
    expect(dispatched).toEqual([])
  })

  /*
   * The refresh answers with a snapshot, and this screen is about the attempt times, which a snapshot
   * does not carry. So the only thing said here is that it came back; the machine turns that into a
   * read of the status.
   */
  it('says a refresh came back rather than drawing the snapshot it came back with', async () => {
    const dispatched = installBridge({})

    await RateDebugEffects.run({ effect: 'refresh' }, ports(dispatched))

    expect(dispatched).toEqual([{ input: 'refresh-answered' }])
  })

  it('reports a refresh the channel never carried', async () => {
    const dispatched = installBridge({ refresh: { ok: false, error: 'the channel is gone' } })

    await RateDebugEffects.run({ effect: 'refresh' }, ports(dispatched))

    expect(dispatched).toEqual([
      { input: 'failed', detail: 'The main process did not answer: the channel is gone' },
    ])
  })

  it('throws on an effect it does not know', async () => {
    const dispatched = installBridge({})
    await expect(RateDebugEffects.run(
      { effect: 'stop-monitor' } as unknown as RateDebugEffect,
      ports(dispatched),
    )).rejects.toThrow(/Unknown rate debug effect/)
  })
})
