import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostEvent } from '../../app-host/app/wire/hostWire.js'
import { FakeHost } from './fixtures/fakeHost'
import { HostEventsSocket } from './hostEventsSocket'

describe('lib-orchestrator/hostClient/hostEventsSocket', () => {
  const hosts: FakeHost[] = []
  const sockets: HostEventsSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close()
    for (const host of hosts.splice(0)) await host.stop()
  })

  async function startHost(hostInstanceId?: string): Promise<FakeHost> {
    const host = await FakeHost.start({ hostInstanceId })
    hosts.push(host)
    return host
  }

  interface Harness {
    socket: HostEventsSocket
    events: HostEvent[]
    resyncs: number
    errors: string[]
  }

  function harness(): Harness {
    const state = {
      socket: null as unknown as HostEventsSocket,
      events: [] as HostEvent[],
      resyncs: 0,
      errors: [] as string[],
    }
    state.socket = new HostEventsSocket({
      onEvent: (event) => state.events.push(event),
      onResync: () => { state.resyncs += 1 },
      onConnected: () => {},
      onDisconnected: () => {},
      onError: (message) => state.errors.push(message),
    })
    sockets.push(state.socket)
    return state
  }

  it('subscribes on connect and delivers what the Host publishes', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    await vi.waitFor(() => expect(context.socket.connected()).toBe(true), { timeout: 2_000 })
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r1' })
    await vi.waitFor(() => expect(context.events).toHaveLength(1), { timeout: 2_000 })
    expect(context.events[0]).toMatchObject({ kind: 'runtime-removed', revision: 1 })
    expect(context.errors).toEqual([])
  })

  // What a reconnect loop looks like from outside is a cursor and a subscribe: without the last one
  // retained, a socket that is connected and one that has never subscribed read the same.
  it('remembers what its last subscribe answered', async () => {
    const host = await startHost()
    const context = harness()
    expect(context.socket.debugView()).toMatchObject({
      connected: false,
      cursor: null,
      reconnectAttempt: 0,
      lastSubscribed: null,
    })

    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r1' })
    context.socket.connect(host.descriptor())
    await vi.waitFor(() => expect(context.socket.connected()).toBe(true), { timeout: 2_000 })

    const view = context.socket.debugView()
    expect(view.cursor).toBe(1)
    expect(view.resyncOwed).toBe(false)
    expect(view.lastSubscribed).toMatchObject({ throughRevision: 1, replayed: 1, truncated: false })
    expect(context.errors).toEqual([])
  })

  // The first connect has no cursor to resume from, so the caller owes itself a full listing before
  // it believes anything an event says.
  it('owes a resync on the first connect, exactly once', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    await vi.waitFor(() => expect(context.resyncs).toBe(1), { timeout: 2_000 })
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r1' })
    await vi.waitFor(() => expect(context.events).toHaveLength(1), { timeout: 2_000 })
    expect(context.resyncs).toBe(1)
  })

  it('replays what it missed after a reconnect, from the cursor and only once', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    await vi.waitFor(() => expect(host.subscribes).toEqual([0]), { timeout: 2_000 })
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r1' })
    await vi.waitFor(() => expect(context.events).toHaveLength(1), { timeout: 2_000 })

    host.dropSockets()
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r2' })
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r3' })
    await vi.waitFor(() => expect(context.events).toHaveLength(3), { timeout: 5_000 })
    expect(host.subscribes).toEqual([0, 1])
    expect(context.events.map((event) => event.revision)).toEqual([1, 2, 3])
    // The replay carried them and the live broadcast did not repeat them.
    expect(context.resyncs).toBe(1)
  })

  it('forces a resync when the Host answers truncated', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    await vi.waitFor(() => expect(context.resyncs).toBe(1), { timeout: 2_000 })
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r1' })
    await vi.waitFor(() => expect(context.events).toHaveLength(1), { timeout: 2_000 })

    host.dropSockets()
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r2' })
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r3' })
    // The window no longer reaches the client's cursor, so resuming would leave a gap it cannot see.
    host.forgetEventsBefore(3)
    await vi.waitFor(() => expect(context.resyncs).toBe(2), { timeout: 5_000 })
  })

  // Revisions restart at zero in a new Host process, so a cursor from the old one would skip
  // everything the new Host has already published.
  it('drops the cursor for a new hostInstanceId and signals the resync exactly once', async () => {
    const first = await startHost('host-1')
    const context = harness()
    context.socket.connect(first.descriptor())
    await vi.waitFor(() => expect(context.resyncs).toBe(1), { timeout: 2_000 })
    first.publish({ kind: 'runtime-removed', runtimeSessionId: 'r1' })
    first.publish({ kind: 'runtime-removed', runtimeSessionId: 'r2' })
    await vi.waitFor(() => expect(context.events).toHaveLength(2), { timeout: 2_000 })

    const second = await startHost('host-2')
    context.socket.connect(second.descriptor())
    await vi.waitFor(() => expect(second.subscribes).toEqual([0]), { timeout: 2_000 })
    await vi.waitFor(() => expect(context.resyncs).toBe(2), { timeout: 2_000 })
    second.publish({ kind: 'runtime-removed', runtimeSessionId: 'r3' })
    await vi.waitFor(() => expect(context.events).toHaveLength(3), { timeout: 2_000 })
    expect(context.resyncs).toBe(2)
  })

  it('reconnecting to the same Host keeps the cursor and owes nothing', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    await vi.waitFor(() => expect(context.resyncs).toBe(1), { timeout: 2_000 })
    host.publish({ kind: 'runtime-removed', runtimeSessionId: 'r1' })
    await vi.waitFor(() => expect(context.events).toHaveLength(1), { timeout: 2_000 })
    context.socket.connect(host.descriptor())
    await vi.waitFor(() => expect(host.subscribes).toEqual([0, 1]), { timeout: 2_000 })
    expect(context.resyncs).toBe(1)
  })

  it('stops reconnecting once closed', async () => {
    const host = await startHost()
    const context = harness()
    context.socket.connect(host.descriptor())
    await vi.waitFor(() => expect(host.subscriberCount()).toBe(1), { timeout: 2_000 })
    context.socket.close()
    await vi.waitFor(() => expect(host.subscriberCount()).toBe(0), { timeout: 2_000 })
    expect(context.socket.connected()).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(host.subscribes).toEqual([0])
  })

  it('reports a Host that cannot be reached without throwing, and keeps trying', async () => {
    const host = await startHost()
    const descriptor = host.descriptor()
    await host.stop()
    hosts.splice(hosts.indexOf(host), 1)
    const context = harness()
    context.socket.connect(descriptor)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(context.socket.connected()).toBe(false)
    expect(context.resyncs).toBe(0)
  })
})
