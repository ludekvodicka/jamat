import { afterEach, describe, expect, it } from 'vitest'

import type { HostPingResult } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge, IpcResult } from '../../../../shared/appClientUiIpc'
import { HostDebugEffects } from './hostDebugEffects'
import type { HostDebugEffect, HostDebugInput } from './hostDebugModel'

describe('app-client-ui/renderer/debugWindow/sections/host/hostDebugEffects', () => {
  const pingedConst: HostPingResult = {
    at: 5,
    ok: true,
    latencyMilliseconds: 3,
    hello: {
      protocol: { major: 1, minor: 0 },
      buildVersion: '2026.08.10.1',
      sourceRevision: 'source-tree',
      platform: 'win32',
      arch: 'x64',
      hostGeneration: 'generation-1',
      pid: 4_242,
      runtimesLive: 2,
      runtimesDead: 1,
      eventRevision: 12,
    },
  }

  interface Bridge {
    ping: IpcResult<HostPingResult>
    startHost: IpcResult<{ ok: boolean; code?: string; detail?: string }>
  }

  function installBridge(answers: Partial<Bridge>): HostDebugInput[] {
    const bridge = {
      debug: {
        pingHost: () => Promise.resolve(answers.ping ?? { ok: true as const, value: pingedConst }),
      },
      sessions: {
        startHost: () =>
          Promise.resolve(answers.startHost ?? { ok: true as const, value: { ok: true } }),
      },
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
      Pick<AppClientUiBridge, 'debug' | 'sessions'>
    return []
  }

  function ports(dispatched: HostDebugInput[]): { dispatch(input: HostDebugInput): void } {
    return { dispatch: (input) => dispatched.push(input) }
  }

  afterEach(() => {
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('carries the ping the main process answered with', async () => {
    const dispatched = installBridge({})
    await HostDebugEffects.run({ effect: 'ping' }, ports(dispatched))
    // `mine`, because this is the answer to the ping the SECTION asked for: it is the only
    // ping allowed to clear the section's own flag.
    expect(dispatched).toEqual([{ input: 'ping-answered', mine: true, result: pingedConst }])
  })

  // A ping that never reached the main process is still a ping that did not answer - and it says
  // whose fault it was, so it cannot be mistaken for the Host being gone.
  it('turns a channel that never answered into a failed ping', async () => {
    const dispatched = installBridge({ ping: { ok: false, error: 'the main process is gone' } })
    await HostDebugEffects.run({ effect: 'ping' }, ports(dispatched))

    const [first] = dispatched
    if (first?.input !== 'ping-answered' || first.result.ok)
      throw new Error('a failed channel was read as a ping that answered')
    expect(first.result.detail)
      .toBe('The main process did not answer: the main process is gone')
  })

  it('says nothing when a Host starts, and everything when it does not', async () => {
    const started = installBridge({})
    await HostDebugEffects.run({ effect: 'start-host' }, ports(started))
    expect(started).toEqual([])

    const refused = installBridge({
      startHost: { ok: true, value: { ok: false, code: 'spawn-failed', detail: 'no entry point' } },
    })
    await HostDebugEffects.run({ effect: 'start-host' }, ports(refused))
    expect(refused).toEqual([{ input: 'failed', detail: 'spawn-failed: no entry point' }])

    const silent = installBridge({ startHost: { ok: false, error: 'the channel is gone' } })
    await HostDebugEffects.run({ effect: 'start-host' }, ports(silent))
    expect(silent).toEqual([
      { input: 'failed', detail: 'The main process did not answer: the channel is gone' },
    ])
  })

  it('throws on an effect it does not know', async () => {
    const dispatched = installBridge({})
    await expect(HostDebugEffects.run(
      { effect: 'stop-host' } as unknown as HostDebugEffect,
      ports(dispatched),
    )).rejects.toThrow(/Unknown host debug effect/)
  })
})
