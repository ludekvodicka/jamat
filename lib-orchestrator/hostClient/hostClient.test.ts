import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostEvent,
  RuntimeResult,
  RuntimeSessionInfo,
} from '../../app-host/app/wire/hostWire.js'
import { FakeHost } from './fixtures/fakeHost'
import { HostClient } from './hostClient'
import type { HostConnectionPresence } from './hostClient.types'

/**
 * Passthrough: every test here reads real descriptor files off a real temp directory, and one holds
 * a single read open to put a landing read on the far side of `stop()`.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

describe('lib-orchestrator/hostClient/hostClient', () => {
  const hosts: FakeHost[] = []
  const clients: HostClient[] = []
  const roots: string[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.stop()
    for (const host of hosts.splice(0)) await host.stop()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  interface Harness {
    client: HostClient
    descriptorFile: string
    presences: HostConnectionPresence[]
    events: HostEvent[]
    resyncs: number
    errors: string[]
    publish: (host: FakeHost) => void
    hide: () => void
  }

  async function startHost(hostInstanceId?: string): Promise<FakeHost> {
    const host = await FakeHost.start({ hostInstanceId })
    hosts.push(host)
    return host
  }

  function harness(): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-host-client-'))
    roots.push(root)
    const descriptorFile = join(root, 'descriptor.json')
    const state = {
      client: null as unknown as HostClient,
      descriptorFile,
      presences: [] as HostConnectionPresence[],
      events: [] as HostEvent[],
      resyncs: 0,
      errors: [] as string[],
      publish: (host: FakeHost) =>
        writeFileSync(descriptorFile, JSON.stringify(host.descriptor()), 'utf8'),
      hide: () => unlinkSync(descriptorFile),
    }
    state.client = new HostClient({
      descriptorFile,
      descriptorPollMilliseconds: 20,
      onEvent: (event) => state.events.push(event),
      onPresence: (presence) => state.presences.push(presence),
      onResync: () => { state.resyncs += 1 },
      onError: (message) => state.errors.push(message),
    })
    clients.push(state.client)
    return state
  }

  function session(runtimeSessionId: string): RuntimeSessionInfo {
    return {
      runtimeSessionId,
      generation: 1,
      alive: true,
      cols: 120,
      rows: 30,
      outputSeq: 0,
      outputEpoch: 1,
      lastOutputAt: null,
      startedAt: 1,
    }
  }

  /*
   * No sleep: there used to be a real 80 ms one here, so that the assertion below was not trivially
   * true at t=0. It was trivially true anyway - `presence()` starts `unreachable` - so the wait
   * proved nothing the two refusals below do not, and it was a real deadline in a suite that shares
   * a machine with three others.
   */
  it('is unreachable while no Host has published, and refuses both kinds of call', async () => {
    const context = harness()
    context.client.start()
    expect(context.client.presence()).toBe('unreachable')
    expect(context.client.descriptor()).toBeNull()
    expect(await context.client.runtimeList()).toMatchObject({ ok: false, code: 'host-unreachable' })
    expect(await context.client.runtimeStop({ hostInstanceId: 'h', runtimeSessionId: 'r', generation: 1 }))
      .toMatchObject({ ok: false, code: 'host-unreachable' })
    expect(context.errors).toEqual([])
  })

  it('connects, takes the lease and answers reads once the descriptor is there', async () => {
    const host = await startHost()
    const context = harness()
    context.publish(host)
    context.client.start()
    await vi.waitFor(() => expect(context.client.presence()).toBe('running'), { timeout: 3_000 })
    expect(context.presences).toEqual(['running'])
    await vi.waitFor(() => expect(host.currentLeaseId()).not.toBeNull(), { timeout: 3_000 })
    const listed = await context.client.runtimeList()
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.detail)
    expect(listed.value.hostInstanceId).toBe(host.descriptor().hostInstanceId)
    expect(context.client.descriptor()?.hostVersion).toBe('0.0.0-fake')
    expect(context.resyncs).toBe(1)
  })

  it('carries the lease the keeper holds into every mutation', async () => {
    const host = await startHost()
    host.handle('runtime.create', () => ({
      body: { session: session('r1'), hostInstanceId: host.descriptor().hostInstanceId } satisfies RuntimeResult,
    }))
    const context = harness()
    context.publish(host)
    context.client.start()
    // The CLIENT'''s authority, not the Host'''s grant: the Host records a lease before its answer
    // lands here, so a mutation started on the Host'''s view alone is refused with no-lease.
    await vi.waitFor(() => expect(context.client.controllerLeaseId()).not.toBeNull(), { timeout: 3_000 })
    const created = await context.client.runtimeCreate({
      operationId: 'op-1',
      runtimeSessionId: 'r1',
      launch: { command: 'cmd.exe', args: [], cwd: 'C:\\', env: {}, cols: 120, rows: 30 },
    })
    expect(created).toMatchObject({ ok: true })
    const call = host.calls.find((entry) => entry.name === 'runtime.create')
    expect(call?.body.controllerLeaseId).toBe(host.currentLeaseId())
    expect(call?.body.operationId).toBe('op-1')
  })

  // A mutation without authority is refused here rather than queued: the caller is told to try again,
  // it is not left believing the Host was asked.
  it('refuses a mutation with no-lease while the Host grants no lease', async () => {
    const host = await startHost()
    host.refuseLease(true)
    const context = harness()
    context.publish(host)
    context.client.start()
    await vi.waitFor(() => expect(context.client.presence()).toBe('running'), { timeout: 3_000 })
    expect(await context.client.runtimeStop({ hostInstanceId: 'h', runtimeSessionId: 'r1', generation: 1 }))
      .toMatchObject({ ok: false, code: 'no-lease' })
    // A read needs no authority at all, so it still goes through.
    expect(await context.client.runtimeList()).toMatchObject({ ok: true })
  })

  it('delivers the events the Host publishes', async () => {
    const host = await startHost()
    const context = harness()
    context.publish(host)
    context.client.start()
    await vi.waitFor(() => expect(context.client.presence()).toBe('running'), { timeout: 3_000 })
    host.publish({ kind: 'runtime-exited', session: { ...session('r1'), alive: false, exitCode: 0 } })
    await vi.waitFor(() => expect(context.events).toHaveLength(1), { timeout: 3_000 })
    expect(context.events[0].kind).toBe('runtime-exited')
  })

  it('goes unreachable when the descriptor disappears, and says nothing is knowable', async () => {
    const host = await startHost()
    const context = harness()
    context.publish(host)
    context.client.start()
    await vi.waitFor(() => expect(context.client.presence()).toBe('running'), { timeout: 3_000 })

    context.hide()
    await vi.waitFor(() => expect(context.client.presence()).toBe('unreachable'), { timeout: 3_000 })
    expect(context.presences).toEqual(['running', 'unreachable'])
    expect(await context.client.runtimeList()).toMatchObject({ ok: false, code: 'host-unreachable' })
    expect(await context.client.runtimeRemove({ hostInstanceId: 'h', runtimeSessionId: 'r1', generation: 1 }))
      .toMatchObject({ ok: false, code: 'host-unreachable' })
  })

  it('reconnects to the Host that comes back and owes one more resync', async () => {
    const first = await startHost('host-1')
    const context = harness()
    context.publish(first)
    context.client.start()
    await vi.waitFor(() => expect(context.client.presence()).toBe('running'), { timeout: 3_000 })
    expect(context.resyncs).toBe(1)

    context.hide()
    await first.stop()
    hosts.splice(hosts.indexOf(first), 1)
    await vi.waitFor(() => expect(context.client.presence()).toBe('unreachable'), { timeout: 3_000 })

    const second = await startHost('host-2')
    context.publish(second)
    await vi.waitFor(() => expect(context.client.presence()).toBe('running'), { timeout: 5_000 })
    await vi.waitFor(() => expect(context.resyncs).toBe(2), { timeout: 3_000 })
    await vi.waitFor(() => expect(second.currentLeaseId()).not.toBeNull(), { timeout: 3_000 })
    expect(context.client.descriptor()?.hostInstanceId).toBe('host-2')
  })

  // The debug view is the only way out for what the watcher, the socket and the lease hold, and the
  // token is the one thing in there that must never come with it.
  it('pings, and shows what it holds without ever carrying the token', async () => {
    const host = await startHost('host-debug')
    const context = harness()
    context.publish(host)
    context.client.start()
    await vi.waitFor(() => expect(host.currentLeaseId()).not.toBeNull(), { timeout: 3_000 })

    const pinged = await context.client.hello()
    expect(pinged.ok).toBe(true)
    if (!pinged.ok) throw new Error(pinged.detail)
    expect(pinged.value.hello.process.hostInstanceId).toBe('host-debug')

    const view = context.client.debugView()
    expect(view.watcher.descriptorFile).toBe(context.descriptorFile)
    expect(view.watcher.identity).toBe(`host-debug:${host.descriptor().port}`)
    expect(view.eventsSocket.connected).toBe(true)
    expect(view.eventsSocket.lastSubscribed).toMatchObject({ replayed: 0, truncated: false })
    expect(view.lease.leaseId).toBe(host.currentLeaseId())
    expect(view.lease.expiresAt).not.toBeNull()
    expect(JSON.stringify(view)).not.toContain(host.descriptor().token)
  })

  /**
   * `HostDescriptorWatcher.stop()` clears an interval; it cannot cancel a `readFile` already in
   * flight. That read lands here after the client stopped, and without the `started` guard it opens
   * a socket and takes a lease for a client that has gone.
   *
   * The negative assertion is made after a BOUNDED FLUSH - one `hello()` round trip on the same
   * Host - because the absence of a request that would travel over its own connection cannot be
   * ordered absolutely against one that did. It is a strong check, not a total one.
   */
  it('takes no lease and opens no socket when a descriptor read lands after stop', async () => {
    const host = await startHost()
    const context = harness()
    let landed = (): void => {}
    const held = new Promise<void>((resolve) => { landed = resolve })
    const published = JSON.stringify(host.descriptor())
    vi.mocked(readFile).mockImplementationOnce(async () => {
      await held
      return published
    })

    context.client.start()
    await context.client.stop()
    clients.splice(clients.indexOf(context.client), 1)
    landed()
    // The read really did land after the stop - that is the precondition, so it is asserted rather
    // than hoped for: the watcher settled the descriptor even though the client took nothing from it.
    await vi.waitFor(() => expect(context.client.descriptor()).not.toBeNull(), { timeout: 3_000 })

    const pinged = await context.client.hello()
    expect(pinged.ok).toBe(true)
    expect(host.calls.filter((call) => call.name === 'controller.acquire')).toEqual([])
    expect(host.subscriberCount()).toBe(0)
    expect(context.client.presence()).toBe('unreachable')
  })

  it('releases the lease and stops listening on stop', async () => {
    const host = await startHost()
    const context = harness()
    context.publish(host)
    context.client.start()
    await vi.waitFor(() => expect(host.currentLeaseId()).not.toBeNull(), { timeout: 3_000 })
    await context.client.stop()
    clients.splice(clients.indexOf(context.client), 1)
    expect(host.currentLeaseId()).toBeNull()
    await vi.waitFor(() => expect(host.subscriberCount()).toBe(0), { timeout: 3_000 })
    expect(context.client.presence()).toBe('unreachable')
  })
})
