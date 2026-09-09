import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AppClientUiBridgeCallsConst,
  AppClientUiBridgeEventsConst,
  type AppClientUiBridgeCallTable,
  type AppClientUiChannelsOffTheBridge,
  type AppClientUiEventsOffTheBridge,
} from '../shared/appClientUiIpc'
import { AppHub } from '../app/appHub'

/**
 * The one gate over the preload. It was written when the preload WAS over a hundred hand-written bindings from
 * a bridge method to a channel name, two of which the compiler could not tell apart: swapping
 * `sessions.reopen` onto `sessions:remove` - Reopen deleting the session instead of reopening it -
 * passed `pnpm typecheck`, every test and `smoke:ui`, because nothing compared the names.
 *
 * The preload now BUILDS itself from `AppClientUiBridgeCallsConst`, so that swap is no longer
 * expressible, and neither is the one measured on 2026-08-24: a member that forwarded the channel
 * but dropped its second argument. This file is what says so - each member is called on its own,
 * with arguments, and the channel and the arguments are both read back.
 */
type Assert<T extends true> = T

/**
 * Compile-time, not run-time: a channel in the map that no member of the table reaches would be
 * unreachable from every renderer, and `Assert<false>` is a type error rather than a red test.
 */
const everyChannelReachesTheRendererConst:
  Assert<[AppClientUiChannelsOffTheBridge] extends [never] ? true : false> = true
const everyEventReachesTheRendererConst:
  Assert<[AppClientUiEventsOffTheBridge] extends [never] ? true : false> = true

/** More than the widest channel takes, so a member that drops a trailing argument shows up. */
const argumentsConst: readonly string[] = ['one', 'two', 'three', 'four', 'five']

const { invoked, subscribed } = vi.hoisted(() => ({
  invoked: [] as [string, unknown[]][],
  subscribed: [] as [string, unknown][],
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, _value: unknown) => undefined },
}))

vi.mock('../shared/typedIpc', () => ({
  invokeAppClientUi: (channel: string, ...args: unknown[]) => {
    invoked.push([channel, args])
    return Promise.resolve({ ok: true, value: undefined })
  },
  onAppClientUiEvent: (channel: string, callback: unknown) => {
    subscribed.push([channel, callback])
    return () => undefined
  },
}))

describe('app-client-ui/preload/index', () => {
  /** Every leaf of the table, as the path a renderer types and the channel it should reach. */
  function membersOf(
    table: AppClientUiBridgeCallTable,
    path: readonly string[] = [],
  ): [string[], string][] {
    const found: [string[], string][] = []
    for (const [member, entry] of Object.entries(table)) {
      const here = [...path, member]
      if (typeof entry === 'string') found.push([here, entry])
      else found.push(...membersOf(entry, here))
    }
    return found
  }

  function memberAt(bridge: unknown, path: readonly string[]): (...args: unknown[]) => unknown {
    let value: unknown = bridge
    for (const step of path) {
      if (value === null || typeof value !== 'object')
        throw new Error(`The bridge holds nothing at ${path.join('.')}`)
      value = (value as Record<string, unknown>)[step]
    }
    if (typeof value !== 'function')
      throw new Error(`The bridge holds no member at ${path.join('.')}`)
    return value as (...args: unknown[]) => unknown
  }

  async function bridgeUnderTest(): Promise<unknown> {
    return (await import('./index')).appClientUiBridge
  }

  beforeEach(() => {
    invoked.length = 0
    subscribed.length = 0
  })

  it('states at compile time that no channel is off the bridge', () => {
    expect(everyChannelReachesTheRendererConst).toBe(true)
    expect(everyEventReachesTheRendererConst).toBe(true)
  })

  it('exposes all sixteen reMarkable calls as one derived bridge group', () => {
    expect(AppClientUiBridgeCallsConst.remarkable).toEqual({
      getSettings: 'remarkable:settings-get',
      saveSettings: 'remarkable:settings-save',
      getStorage: 'remarkable:storage-get',
      saveStorage: 'remarkable:storage-save',
      saveImport: 'remarkable:import-save',
      setPassword: 'remarkable:password-set',
      clearPassword: 'remarkable:password-clear',
      detectFingerprint: 'remarkable:fingerprint-detect',
      testConnection: 'remarkable:connection-test',
      dependenciesStatus: 'remarkable:dependencies-status',
      installDependencies: 'remarkable:dependencies-install',
      startOperation: 'remarkable:operation-start',
      pages: 'remarkable:operation-pages',
      render: 'remarkable:operation-render',
      preview: 'remarkable:operation-preview',
      release: 'remarkable:operation-release',
    })
  })

  it('covers every channel the main process handles, exactly once and nothing else', async () => {
    const bridge = await bridgeUnderTest()
    for (const [path] of membersOf(AppClientUiBridgeCallsConst)) void memberAt(bridge, path)()

    const reached = invoked.map(([channel]) => channel)

    expect([...reached].sort()).toEqual(Object.keys(AppHub.ipcChannelsConst).sort())
    expect(reached).toHaveLength(new Set(reached).size)
  })

  /*
   * The half a set comparison cannot see. A member reaching a channel of the same signature as its
   * own leaves both sets whole, and so does a member that forwards the channel and drops an
   * argument - which is what a mutant on `sessions:retry-setup` did with every test still green.
   */
  it('reaches from each member its own channel, carrying every argument in order', async () => {
    const bridge = await bridgeUnderTest()

    for (const [path, channel] of membersOf(AppClientUiBridgeCallsConst)) {
      invoked.length = 0

      void memberAt(bridge, path)(...argumentsConst)

      expect(invoked, path.join('.')).toEqual([[channel, [...argumentsConst]]])
    }
  })

  it('subscribes each listener to its own channel, with the callback it was given', async () => {
    const bridge = await bridgeUnderTest()

    for (const [member, channel] of Object.entries(AppClientUiBridgeEventsConst)) {
      subscribed.length = 0
      const callback = (): void => undefined

      void memberAt(bridge, [member])(callback)

      expect(subscribed, member).toEqual([[channel, callback]])
    }
  })
})
