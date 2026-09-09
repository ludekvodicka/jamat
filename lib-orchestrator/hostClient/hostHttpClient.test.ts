import { afterEach, describe, expect, it } from 'vitest'

import type { HostDescriptor, RuntimeListResult } from '../../app-host/app/wire/hostWire.js'
import { FakeHost } from './fixtures/fakeHost'
import { HostHttpClient } from './hostHttpClient'

describe('lib-orchestrator/hostClient/hostHttpClient', () => {
  const hosts: FakeHost[] = []

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop()
  })

  async function startHost(): Promise<FakeHost> {
    const host = await FakeHost.start()
    hosts.push(host)
    return host
  }

  it('calls an op with the descriptor token and hands back the parsed answer', async () => {
    const host = await startHost()
    const client = new HostHttpClient(() => host.descriptor())
    const listed = await client.call<RuntimeListResult>('runtime.list', {})
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.detail)
    expect(listed.value.hostInstanceId).toBe(host.descriptor().hostInstanceId)
    expect(host.calls.map((call) => call.name)).toEqual(['runtime.list'])
  })

  it('sends the body the caller gave it', async () => {
    const host = await startHost()
    host.handle('runtime.inspect', (body) => ({ body: { echo: body } }))
    const client = new HostHttpClient(() => host.descriptor())
    await client.call('runtime.inspect', { target: { runtimeSessionId: 'r1' } })
    expect(host.calls[0].body).toEqual({ target: { runtimeSessionId: 'r1' } })
  })

  it('answers host-unreachable while no descriptor is published', async () => {
    const client = new HostHttpClient(() => null)
    const result = await client.call('runtime.list', {})
    expect(result).toEqual({
      ok: false,
      code: 'host-unreachable',
      detail: 'runtime.list: no Host descriptor is published',
    })
  })

  // A closed loopback port is the Host being gone, not the op being wrong: the difference decides
  // whether the caller re-labels its records or leaves them alone.
  it('answers host-unreachable when the port refuses the connection', async () => {
    const host = await startHost()
    const descriptor = host.descriptor()
    await host.stop()
    hosts.splice(hosts.indexOf(host), 1)
    const client = new HostHttpClient(() => descriptor)
    const result = await client.call('runtime.list', {})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a stopped Host answered')
    expect(result.code).toBe('host-unreachable')
  })

  /*
   * The status travels as a field and not only inside the sentence. What a refusal means is not
   * knowable from the code alone - 429 is a ceiling that lifts, 409 a state that changes, 400 a
   * request that never becomes valid - and the caller deciding whether a record is finished has to
   * be able to tell them apart without reading the Host's prose.
   */
  it('answers op-rejected with the Host status and message when the Host refuses', async () => {
    const host = await startHost()
    host.handle('runtime.stop', () => ({ status: 409, body: { error: 'Controller lease does not match' } }))
    host.handle('runtime.create', () => ({ status: 429, body: { error: '64 live runtimes is the limit' } }))
    const client = new HostHttpClient(() => host.descriptor())

    const stopped = await client.call('runtime.stop', {})
    expect(stopped.ok).toBe(false)
    if (stopped.ok || stopped.code !== 'op-rejected') throw new Error('a refused op answered ok')
    expect(stopped.status).toBe(409)
    expect(stopped.detail).toBe('runtime.stop answered 409: Controller lease does not match')

    const created = await client.call('runtime.create', {})
    if (created.ok || created.code !== 'op-rejected') throw new Error('a refused op answered ok')
    expect(created.status).toBe(429)
  })

  // A success this client cannot read is not a refusal: the status says the operation may well have
  // run, which is a completely different thing to do with a record than a Host that judged it.
  it('carries the status of an answer it could not parse', async () => {
    const host = await startHost()
    host.handle('runtime.list', () => ({ body: null, raw: '{ half a listing' }))
    const client = new HostHttpClient(() => host.descriptor())
    const result = await client.call('runtime.list', {})
    expect(result.ok).toBe(false)
    if (result.ok || result.code !== 'op-rejected') throw new Error('an unreadable answer parsed')
    expect(result.status).toBe(200)
    expect(result.detail).toContain('unreadable JSON')
  })

  it('answers op-rejected when the token is not the Host token', async () => {
    const host = await startHost()
    const wrong: HostDescriptor = { ...host.descriptor(), token: 'not-the-token' }
    const client = new HostHttpClient(() => wrong)
    const result = await client.call('runtime.list', {})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an unauthorized op answered ok')
    expect(result.code).toBe('op-rejected')
    expect(result.detail).toContain('401')
  })

  it('pings the Host and measures how long the answer took', async () => {
    const host = await startHost()
    host.setHello({ eventRevision: 7 })
    const client = new HostHttpClient(() => host.descriptor())
    const pinged = await client.hello()
    expect(pinged.ok).toBe(true)
    if (!pinged.ok) throw new Error(pinged.detail)
    expect(pinged.value.hello.buildInfo.buildVersion).toBe('0.0.0-fake')
    expect(pinged.value.hello.eventRevision).toBe(7)
    expect(pinged.value.latencyMilliseconds).toBeGreaterThanOrEqual(0)
    expect(host.helloCount()).toBe(1)
    // A ping is not an operation and must not be counted as one.
    expect(host.calls).toEqual([])
  })

  it('answers host-unreachable for a ping while no descriptor is published', async () => {
    const client = new HostHttpClient(() => null)
    const result = await client.hello()
    expect(result).toEqual({
      ok: false,
      code: 'host-unreachable',
      detail: 'hello: no Host descriptor is published',
    })
  })

  it('answers op-rejected when the ping is not authorized', async () => {
    const host = await startHost()
    const client = new HostHttpClient(() => ({ ...host.descriptor(), token: 'not-the-token' }))
    const result = await client.hello()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an unauthorized ping answered ok')
    expect(result.code).toBe('op-rejected')
    expect(result.detail).toContain('401')
  })

  /*
   * The one slow test here, and it is the point of the timeout: a Host that takes the request and
   * says nothing is exactly what an operation's fifteen seconds would sit through. Without the
   * shorter deadline wired in, this test would not fail - it would hang.
   */
  it('gives up on a ping the Host accepts and never answers', async () => {
    const host = await startHost()
    host.hangHello(true)
    const client = new HostHttpClient(() => host.descriptor())
    const result = await client.hello()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a Host that never answered was read as reachable')
    expect(result.code).toBe('host-unreachable')
    expect(result.detail).toContain('hello:')
  }, 10_000)

  it('reads the descriptor again on every call, so a restarted Host is reached', async () => {
    const first = await startHost()
    let current = first.descriptor()
    const client = new HostHttpClient(() => current)
    await client.call('runtime.list', {})
    const second = await startHost()
    current = second.descriptor()
    const listed = await client.call<RuntimeListResult>('runtime.list', {})
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.detail)
    expect(listed.value.hostInstanceId).toBe(second.descriptor().hostInstanceId)
  })
})
