import type { RemoteControlListenerSettings } from '../../../lib-orchestrator/remoteControl/remotePeerListener.types'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'


import type { RemoteControlPeerListenAddress } from './remoteControlPeerServer'
import {
  RemotePeerListenerManager,
  type RemotePeerListenerServer,
} from './remotePeerListenerManager'

describe('app-gateway/app/peers/remotePeerListenerManager', () => {
  /**
   * What the bundle names has to be what BOUND, so the fake answers with a port other than the one
   * the settings asked for: a manager that echoed its own settings would pass this by accident.
   */
  it('binds, reports the port it really took and publishes that endpoint once', async () => {
    const harness = new RemotePeerListenerManagerTest()
    harness.port = 47_151

    assert.deepEqual(await harness.manager.apply(RemotePeerListenerManagerTest.settings()), { ok: true })

    assert.deepEqual(harness.servers[0]?.requested, { host: '0.0.0.0', port: 47_150 })
    assert.deepEqual(harness.manager.runtime(), { status: 'listening', actualHost: '0.0.0.0', actualPort: 47_151 })
    assert.deepEqual(harness.bound, [{ host: '203.0.113.10', port: 47_151 }])
    assert.deepEqual(harness.changes, ['starting', 'listening'])
  })

  /**
   * `RemoteControlPeerServer` is one-shot, which is the whole reason this owner holds a factory. The
   * order is the other half: one port cannot be bound twice, so the old listener goes first.
   */
  it('builds a new server for the next bind and stops the old one before it starts', async () => {
    const harness = new RemotePeerListenerManagerTest()
    await harness.manager.apply(RemotePeerListenerManagerTest.settings())
    harness.port = 47_200

    assert.deepEqual(await harness.manager.apply(RemotePeerListenerManagerTest.settings({ port: 47_200 })), { ok: true })

    assert.equal(harness.servers.length, 2)
    assert.deepEqual(harness.events, ['start-1', 'stop-1', 'start-2'])
    assert.deepEqual(harness.manager.runtime(), { status: 'listening', actualHost: '0.0.0.0', actualPort: 47_200 })
    assert.deepEqual(harness.bound[1], { host: '203.0.113.10', port: 47_200 })
  })

  /** Two applies at once are two servers racing for one port, so the second is refused, not queued. */
  it('refuses a second apply while the first is still binding', async () => {
    const harness = new RemotePeerListenerManagerTest()
    harness.gated = true
    const first = harness.manager.apply(RemotePeerListenerManagerTest.settings())
    await harness.waitUntil(() => harness.servers.length === 1)

    assert.partialDeepStrictEqual(await harness.manager.apply(RemotePeerListenerManagerTest.settings({ port: 47_200 })), { ok: false, code: 'busy' })

    assert.equal(harness.servers.length, 1)
    assert.deepEqual(harness.manager.runtime(), { status: 'starting' })
    harness.servers[0]?.release()
    assert.deepEqual(await first, { ok: true })
    assert.deepEqual(harness.manager.runtime(), { status: 'listening', actualHost: '0.0.0.0', actualPort: 47_150 })
  })

  it('holds a refused bind as failed, publishes nothing, and binds again on the next apply', async () => {
    const harness = new RemotePeerListenerManagerTest()
    harness.failure = 'listen EADDRINUSE: address already in use 0.0.0.0:47150'

    assert.deepEqual(await harness.manager.apply(RemotePeerListenerManagerTest.settings()), {
      ok: false,
      code: 'bind-failed',
      detail: 'listen EADDRINUSE: address already in use 0.0.0.0:47150',
    })

    assert.deepEqual(harness.manager.runtime(), {
      status: 'failed',
      error: 'listen EADDRINUSE: address already in use 0.0.0.0:47150',
    })
    assert.deepEqual(harness.bound, [])

    harness.failure = null
    assert.deepEqual(await harness.manager.apply(RemotePeerListenerManagerTest.settings()), { ok: true })
    assert.deepEqual(harness.manager.runtime(), { status: 'listening', actualHost: '0.0.0.0', actualPort: 47_150 })
    assert.equal(harness.bound.length, 1)
  })

  it('turns the listener off at run time and says nothing is listening', async () => {
    const harness = new RemotePeerListenerManagerTest()
    await harness.manager.apply(RemotePeerListenerManagerTest.settings())

    assert.deepEqual(await harness.manager.apply(RemotePeerListenerManagerTest.settings({ enabled: false })), { ok: true })

    assert.equal(harness.servers.length, 1)
    assert.equal(harness.servers[0]?.stops, 1)
    assert.deepEqual(harness.manager.runtime(), { status: 'disabled' })
    // The endpoint that was published while it ran is not republished by turning it off.
    assert.equal(harness.bound.length, 1)
  })

  /** `beginQuit` starts the stop and `dispose` awaits it, so both reach the same one. */
  it('stops once however many times quitting asks, and binds nothing afterwards', async () => {
    const harness = new RemotePeerListenerManagerTest()
    await harness.manager.apply(RemotePeerListenerManagerTest.settings())

    await Promise.all([harness.manager.stop(), harness.manager.stop()])

    assert.equal(harness.servers[0]?.stops, 1)
    assert.deepEqual(harness.manager.runtime(), { status: 'disabled' })
    assert.partialDeepStrictEqual(await harness.manager.apply(RemotePeerListenerManagerTest.settings()), { ok: false, code: 'stopping' })
    assert.equal(harness.servers.length, 1)
  })

  /** A settings save landing between `beginQuit` and `dispose` must not leave a port behind. */
  it('binds nothing once quitting has begun', async () => {
    const harness = new RemotePeerListenerManagerTest()
    await harness.manager.apply(RemotePeerListenerManagerTest.settings())

    harness.manager.beginStop()

    assert.equal(harness.servers[0]?.beginStops, 1)
    assert.partialDeepStrictEqual(await harness.manager.apply(RemotePeerListenerManagerTest.settings({ port: 47_200 })), { ok: false, code: 'stopping' })
    assert.equal(harness.servers.length, 1)
    await harness.manager.stop()
    assert.equal(harness.servers[0]?.stops, 1)
  })
})

class RemotePeerListenerManagerTest {
  readonly servers: RemotePeerListenerManagerTestServer[] = []
  readonly bound: RemoteControlPeerListenAddress[] = []
  readonly changes: string[] = []
  readonly events: string[] = []
  readonly manager: RemotePeerListenerManager
  /** What the next server reports as the address it took, and how it gets there. */
  port = 47_150
  failure: string | null = null
  gated = false

  constructor() {
    this.manager = new RemotePeerListenerManager({
      serverFactory: () => {
        const server = new RemotePeerListenerManagerTestServer(
          this.servers.length + 1,
          { port: this.port, failure: this.failure, gated: this.gated },
          this.events,
        )
        this.servers.push(server)
        return server
      },
      onBound: (advertisedHost, port) => { this.bound.push({ host: advertisedHost, port }) },
      onChanged: () => this.changes.push(this.manager.runtime().status),
    })
  }

  async waitUntil(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (condition()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`Remote listener test timed out: ${JSON.stringify(this.manager.runtime())}`)
  }

  static settings(
    overrides: Partial<RemoteControlListenerSettings> = {},
  ): RemoteControlListenerSettings {
    return {
      enabled: true,
      bindHost: '0.0.0.0',
      port: 47_150,
      advertisedHost: '203.0.113.10',
      ...overrides,
    }
  }
}

class RemotePeerListenerManagerTestServer implements RemotePeerListenerServer {
  requested: RemoteControlPeerListenAddress | null = null
  stops = 0
  beginStops = 0
  private open: (() => void) | null = null

  constructor(
    private readonly index: number,
    private readonly plan: { port: number; failure: string | null; gated: boolean },
    private readonly events: string[],
  ) {}

  async start(host: string, port: number): Promise<RemoteControlPeerListenAddress> {
    this.requested = { host, port }
    this.events.push(`start-${this.index}`)
    if (this.plan.gated) await new Promise<void>((resolve) => { this.open = resolve })
    if (this.plan.failure !== null) throw new Error(this.plan.failure)
    return { host, port: this.plan.port }
  }

  /** Lets a gated bind finish, which is how a second apply gets to arrive during the first. */
  release(): void {
    this.open?.()
  }

  beginStop(): void {
    this.beginStops += 1
  }

  stop(): Promise<void> {
    this.stops += 1
    this.events.push(`stop-${this.index}`)
    return Promise.resolve()
  }
}
