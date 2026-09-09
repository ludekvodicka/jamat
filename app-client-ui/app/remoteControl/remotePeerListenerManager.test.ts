import { describe, expect, it } from 'vitest'

import type { RemoteControlListenerSettings } from '../../shared/remoteControlSettings'
import type { RemoteControlPeerListenAddress } from './remoteControlPeerServer'
import {
  RemotePeerListenerManager,
  type RemotePeerListenerServer,
} from './remotePeerListenerManager'

describe('app-client-ui/app/remoteControl/remotePeerListenerManager', () => {
  /**
   * What the bundle names has to be what BOUND, so the fake answers with a port other than the one
   * the settings asked for: a manager that echoed its own settings would pass this by accident.
   */
  it('binds, reports the port it really took and publishes that endpoint once', async () => {
    const harness = new RemotePeerListenerManagerTest()
    harness.port = 47_151

    expect(await harness.manager.apply(RemotePeerListenerManagerTest.settings())).toEqual({ ok: true })

    expect(harness.servers[0]?.requested).toEqual({ host: '0.0.0.0', port: 47_150 })
    expect(harness.manager.runtime())
      .toEqual({ status: 'listening', actualHost: '0.0.0.0', actualPort: 47_151 })
    expect(harness.bound).toEqual([{ host: '203.0.113.10', port: 47_151 }])
    expect(harness.changes).toEqual(['starting', 'listening'])
  })

  /**
   * `RemoteControlPeerServer` is one-shot, which is the whole reason this owner holds a factory. The
   * order is the other half: one port cannot be bound twice, so the old listener goes first.
   */
  it('builds a new server for the next bind and stops the old one before it starts', async () => {
    const harness = new RemotePeerListenerManagerTest()
    await harness.manager.apply(RemotePeerListenerManagerTest.settings())
    harness.port = 47_200

    expect(await harness.manager.apply(RemotePeerListenerManagerTest.settings({ port: 47_200 })))
      .toEqual({ ok: true })

    expect(harness.servers.length).toBe(2)
    expect(harness.events).toEqual(['start-1', 'stop-1', 'start-2'])
    expect(harness.manager.runtime())
      .toEqual({ status: 'listening', actualHost: '0.0.0.0', actualPort: 47_200 })
    expect(harness.bound[1]).toEqual({ host: '203.0.113.10', port: 47_200 })
  })

  /** Two applies at once are two servers racing for one port, so the second is refused, not queued. */
  it('refuses a second apply while the first is still binding', async () => {
    const harness = new RemotePeerListenerManagerTest()
    harness.gated = true
    const first = harness.manager.apply(RemotePeerListenerManagerTest.settings())
    await harness.waitUntil(() => harness.servers.length === 1)

    expect(await harness.manager.apply(RemotePeerListenerManagerTest.settings({ port: 47_200 })))
      .toMatchObject({ ok: false, code: 'busy' })

    expect(harness.servers.length).toBe(1)
    expect(harness.manager.runtime()).toEqual({ status: 'starting' })
    harness.servers[0]?.release()
    expect(await first).toEqual({ ok: true })
    expect(harness.manager.runtime())
      .toEqual({ status: 'listening', actualHost: '0.0.0.0', actualPort: 47_150 })
  })

  it('holds a refused bind as failed, publishes nothing, and binds again on the next apply', async () => {
    const harness = new RemotePeerListenerManagerTest()
    harness.failure = 'listen EADDRINUSE: address already in use 0.0.0.0:47150'

    expect(await harness.manager.apply(RemotePeerListenerManagerTest.settings())).toEqual({
      ok: false,
      code: 'bind-failed',
      detail: 'listen EADDRINUSE: address already in use 0.0.0.0:47150',
    })

    expect(harness.manager.runtime()).toEqual({
      status: 'failed',
      error: 'listen EADDRINUSE: address already in use 0.0.0.0:47150',
    })
    expect(harness.bound).toEqual([])

    harness.failure = null
    expect(await harness.manager.apply(RemotePeerListenerManagerTest.settings())).toEqual({ ok: true })
    expect(harness.manager.runtime())
      .toEqual({ status: 'listening', actualHost: '0.0.0.0', actualPort: 47_150 })
    expect(harness.bound.length).toBe(1)
  })

  it('turns the listener off at run time and says nothing is listening', async () => {
    const harness = new RemotePeerListenerManagerTest()
    await harness.manager.apply(RemotePeerListenerManagerTest.settings())

    expect(await harness.manager.apply(RemotePeerListenerManagerTest.settings({ enabled: false })))
      .toEqual({ ok: true })

    expect(harness.servers.length).toBe(1)
    expect(harness.servers[0]?.stops).toBe(1)
    expect(harness.manager.runtime()).toEqual({ status: 'disabled' })
    // The endpoint that was published while it ran is not republished by turning it off.
    expect(harness.bound.length).toBe(1)
  })

  /** `beginQuit` starts the stop and `dispose` awaits it, so both reach the same one. */
  it('stops once however many times quitting asks, and binds nothing afterwards', async () => {
    const harness = new RemotePeerListenerManagerTest()
    await harness.manager.apply(RemotePeerListenerManagerTest.settings())

    await Promise.all([harness.manager.stop(), harness.manager.stop()])

    expect(harness.servers[0]?.stops).toBe(1)
    expect(harness.manager.runtime()).toEqual({ status: 'disabled' })
    expect(await harness.manager.apply(RemotePeerListenerManagerTest.settings()))
      .toMatchObject({ ok: false, code: 'stopping' })
    expect(harness.servers.length).toBe(1)
  })

  /** A settings save landing between `beginQuit` and `dispose` must not leave a port behind. */
  it('binds nothing once quitting has begun', async () => {
    const harness = new RemotePeerListenerManagerTest()
    await harness.manager.apply(RemotePeerListenerManagerTest.settings())

    harness.manager.beginStop()

    expect(harness.servers[0]?.beginStops).toBe(1)
    expect(await harness.manager.apply(RemotePeerListenerManagerTest.settings({ port: 47_200 })))
      .toMatchObject({ ok: false, code: 'stopping' })
    expect(harness.servers.length).toBe(1)
    await harness.manager.stop()
    expect(harness.servers[0]?.stops).toBe(1)
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
      onBound: (advertisedHost, port) => this.bound.push({ host: advertisedHost, port }),
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
