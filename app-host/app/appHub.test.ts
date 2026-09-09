import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AppHub } from './appHub.js'
import type { AppContext } from './appContext.js'
import { HostOperationRouter } from './hostTransport/hostOperationRouter.js'
import { HostWireConst, type HostOpName } from './wire/hostWire.js'

describe('app-host/app/appHub', () => {
  const directories: string[] = []
  const saved = process.env.JAMAT_V3_LOCAL_STATE_DIR

  beforeEach(() => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-hub-state-'))
    directories.push(directory)
    process.env.JAMAT_V3_LOCAL_STATE_DIR = directory
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = saved
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function hub(): AppHub {
    const context = {
      hostInstanceId: 'host-1',
      config: {
        identity: { configIdentity: 'identity-1' },
        runtimeChannel: 'development',
      },
      log: () => undefined,
    } as unknown as AppContext
    return new AppHub(context)
  }

  /**
   * The split moved controller.* and runtime.* into two services. Only both halves plus host.stop
   * cover the wire, and assertComplete at boot is what turns a missing handler into a failed start
   * instead of a 500 hours later.
   */
  it('covers every wire operation once host.stop is registered alongside it', () => {
    const router = new HostOperationRouter()
    hub().registerOperations(router)

    expect(() => router.assertComplete()).toThrow(/host\.stop/)

    router.register('host.stop', () => ({ stopping: true, live: 0 }))
    expect(() => router.assertComplete()).not.toThrow()
  })

  it('registers each operation exactly once, so neither service shadows the other', () => {
    const router = new HostOperationRouter()
    const theHub = hub()
    theHub.registerOperations(router)

    for (const name of Object.keys(HostWireConst.ops) as HostOpName[]) {
      if (name === 'host.stop') continue
      expect(() => router.register(name, () => undefined))
        .toThrow(/already registered/)
    }
  })

  it('starts with no runtimes and revision zero', () => {
    const theHub = hub()
    expect(theHub.runtimeCounts()).toEqual({ live: 0, dead: 0 })
    expect(theHub.liveRuntimeCount()).toBe(0)
    expect(theHub.eventRevision()).toBe(0)
  })

  it('advances the event revision when it publishes', () => {
    const theHub = hub()
    theHub.publish({ kind: 'host-stopping' })
    expect(theHub.eventRevision()).toBe(1)
  })

  it('refuses an unknown controller lease', () => {
    expect(() => hub().requireController('not-a-lease')).toThrow(/lease/i)
  })
})
