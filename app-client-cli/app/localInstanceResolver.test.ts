import { describe, expect, it, vi } from 'vitest'

import type {
  RemoteControlDescriptor,
  RemoteControlHelloDto,
  RemoteControlStepResult,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { RemoteControlRejectedRegistration } from '../../lib-orchestrator/remoteControl/remoteControlDescriptorDiscovery'
import type { ConfigIdentityDocument } from '../../lib-orchestrator/shared/configIdentity.types'
import {
  LocalInstanceResolver,
  type LocalInstanceResolverDeps,
} from './localInstanceResolver'

describe('app-client-cli/app/localInstanceResolver', () => {
  it('returns unavailable, one exact descriptor, or a safe conflict without a tie-breaker', async () => {
    const none = new LocalInstanceResolverTest([])
    await expect(none.resolve({})).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })

    const oneDescriptor = LocalInstanceResolverTest.descriptor('one', 'development')
    const one = new LocalInstanceResolverTest([oneDescriptor])
    await expect(one.resolve({})).resolves.toEqual({ ok: true, value: oneDescriptor })

    const second = LocalInstanceResolverTest.descriptor('two', 'production')
    const many = new LocalInstanceResolverTest([oneDescriptor, second])
    const answer = await many.resolve({})
    expect(answer).toMatchObject({
      ok: false,
      error: { code: 'conflict', data: { candidates: [{ instanceId: 'one' }, { instanceId: 'two' }] } },
    })
    expect(JSON.stringify(answer)).not.toContain(oneDescriptor.token)
    for (const forbidden of ['port', 'descriptorFile', 'registrationFile'])
      expect(JSON.stringify(answer)).not.toContain(`"${forbidden}"`)
  })

  it('filters config identity and development or production before probing', async () => {
    const dev = LocalInstanceResolverTest.descriptor('dev', 'development', 'identity-a')
    const prod = LocalInstanceResolverTest.descriptor('prod', 'production', 'identity-a')
    const other = LocalInstanceResolverTest.descriptor('other', 'production', 'identity-b')
    const test = new LocalInstanceResolverTest([dev, prod, other])

    await expect(test.resolve({ configIdentity: 'identity-a', channel: 'production' }))
      .resolves.toEqual({ ok: true, value: prod })
    expect(test.probed).toEqual(['prod'])
    await expect(test.resolve({ configIdentity: 'missing' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
  })

  // The session pair is a filter: it picks its own controller among several, and never another one.
  it('selects the session pair\'s instance among two development instances, and names it when it is not registered', async () => {
    const own = LocalInstanceResolverTest.descriptor('37045054-own', 'development', '408862fc-own')
    const measuring = LocalInstanceResolverTest.descriptor('2a2a0f4b-measuring', 'development', '2a2a0f4b-private')
    const pair = { configIdentity: '408862fc-own', channel: 'development' as const }
    await expect(new LocalInstanceResolverTest([own, measuring]).resolve(pair)).resolves.toEqual({ ok: true, value: own })

    const alone = new LocalInstanceResolverTest([measuring])
    const answer = await alone.resolve(pair)
    expect(answer).toMatchObject({ ok: false, error: { code: 'unavailable', data: { rejections: [
      { instanceId: '2a2a0f4b-measuring', configIdentity: '2a2a0f4b-private', runtimeChannel: 'development', reason: 'filtered' },
    ] } } })
    expect(!answer.ok && answer.error.detail).toBe('No matching running AppClientUI instance was found for 408862fc (development); '
      + '2a2a0f4b (2a2a0f4b, development): not the selected controller')
    expect(alone.probed).toEqual([])
  })

  it('gives a pinned single candidate the whole discovery budget for its hello', async () => {
    vi.useFakeTimers()
    try {
      const pinned = LocalInstanceResolverTest.descriptor('pinned', 'development', 'identity-p')
      const other = LocalInstanceResolverTest.descriptor('other', 'development', 'identity-o')
      const timeouts: number[] = []
      // Answers after 3 s, unless the timeout the resolver hands it ends first, as the real client does.
      const resolver = new LocalInstanceResolver({
        candidates: () => [pinned, other].map((descriptor) => ({ descriptor, registration: null })),
        probe: (descriptor, _signal, timeoutMilliseconds) => {
          timeouts.push(timeoutMilliseconds)
          return new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, value: LocalInstanceResolverTest.hello(descriptor) }), 3_000)
            setTimeout(() => resolve({ ok: false, error: { code: 'timeout', detail: 'The AppClientUI control request timed out' } }), timeoutMilliseconds)
          })
        },
      })

      const pinnedAnswer = resolver.resolve({ configIdentity: 'identity-p', channel: 'development' })
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(pinnedAnswer).resolves.toEqual({ ok: true, value: pinned })
      expect(timeouts).toEqual([5_000])

      const discovered = resolver.resolve({ channel: 'development' })
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(discovered).resolves.toMatchObject({ ok: false, error: { code: 'unavailable', data: { rejections: [
        { instanceId: 'pinned', reason: 'hello-timeout', detail: '1.5' },
        { instanceId: 'other', reason: 'hello-timeout', detail: '1.5' },
      ] } } })
      expect(timeouts.slice(1)).toEqual([1_500, 1_500])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists every candidate and why it was rejected when none answers', async () => {
    const slow = LocalInstanceResolverTest.descriptor('37045054-slow', 'development', '408862fc-a')
    const stranger = LocalInstanceResolverTest.descriptor('99999999-stranger', 'development', '408862fc-a')
    const closed = LocalInstanceResolverTest.descriptor('11111111-closed', 'development', '408862fc-a')
    const test = new LocalInstanceResolverTest([slow, stranger, closed])
    test.rejectedRegistrations.push(
      { configIdentity: '408862fc-a', runtimeChannel: 'development', instanceId: '22222222-dead', reason: 'not-alive' },
      { configIdentity: '408862fc-a', runtimeChannel: 'development', instanceId: '33333333-torn', reason: 'descriptor' },
      { configIdentity: 'other-identity', runtimeChannel: 'production', instanceId: '44444444-elsewhere', reason: 'not-alive' },
    )
    test.answers.set('37045054-slow', { ok: false, error: { code: 'timeout', detail: 'The AppClientUI control request timed out' } })
    test.answers.set('99999999-stranger', { ok: true, value: { ...LocalInstanceResolverTest.hello(stranger), instanceId: 'wrong' } })
    test.answers.set('11111111-closed', { ok: false, error: { code: 'unavailable', detail: 'The AppClientUI control endpoint is unavailable' } })

    const answer = await test.resolve({ channel: 'development' })

    expect(answer).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(!answer.ok && answer.error.detail).toBe('No matching running AppClientUI instance was found for development; '
      + '22222222 (408862fc, development): its process is gone; '
      + '33333333 (408862fc, development): its control descriptor could not be read; '
      + '37045054 (408862fc, development): did not answer system.hello within 1.5 s; '
      + '99999999 (408862fc, development): answered system.hello with another identity; '
      + '11111111 (408862fc, development): refused system.hello (The AppClientUI control endpoint is unavailable)')
    expect(JSON.stringify(answer)).not.toContain(slow.token)
    expect(JSON.stringify(answer)).not.toContain('34567')
  })

  it('drops endpoint failures, timeouts and every hello identity or capability mismatch', async () => {
    const valid = LocalInstanceResolverTest.descriptor('valid', 'development')
    const endpoint = LocalInstanceResolverTest.descriptor('endpoint', 'development')
    const timeout = LocalInstanceResolverTest.descriptor('timeout', 'development')
    const identity = LocalInstanceResolverTest.descriptor('identity', 'development')
    const instance = LocalInstanceResolverTest.descriptor('instance', 'development')
    const capability = LocalInstanceResolverTest.descriptor('capability', 'development')
    const malformed = LocalInstanceResolverTest.descriptor('malformed', 'development')
    const thrown = LocalInstanceResolverTest.descriptor('thrown', 'development')
    const test = new LocalInstanceResolverTest([
      endpoint,
      timeout,
      identity,
      instance,
      capability,
      malformed,
      thrown,
      valid,
    ])
    test.answers.set('endpoint', { ok: false, error: { code: 'unavailable', detail: 'gone' } })
    test.answers.set('timeout', { ok: false, error: { code: 'timeout', detail: 'slow' } })
    test.answers.set('identity', { ok: true, value: {
      ...LocalInstanceResolverTest.hello(identity),
      configIdentity: 'wrong',
    } })
    test.answers.set('instance', { ok: true, value: {
      ...LocalInstanceResolverTest.hello(instance),
      instanceId: 'wrong',
    } })
    test.answers.set('capability', { ok: true, value: {
      ...LocalInstanceResolverTest.hello(capability),
      optionalOperations: RemoteControlConst.optionalOperations,
    } })
    test.answers.set('malformed', {
      ok: true,
      value: null as unknown as RemoteControlHelloDto,
    })
    test.thrown.add('thrown')

    await expect(test.resolve({})).resolves.toEqual({ ok: true, value: valid })
  })

  it('matches a newer client whose hello offers optional operations this build does not know', async () => {
    const newer = {
      ...LocalInstanceResolverTest.descriptor('newer', 'development'),
      optionalOperations: ['sessions.transcript'] as const,
    }
    const test = new LocalInstanceResolverTest([newer])
    test.answers.set('newer', { ok: true, value: {
      ...LocalInstanceResolverTest.hello(newer),
      optionalOperations: ['sessions.transcript', 'unknown.operation'] as unknown as RemoteControlHelloDto['optionalOperations'],
    } })

    await expect(test.resolve({})).resolves.toEqual({ ok: true, value: newer })
  })

  it('bounds concurrent identity probes', async () => {
    const descriptors = Array.from({ length: 40 }, (_, index) =>
      LocalInstanceResolverTest.descriptor(`instance-${index}`, 'development'))
    let active = 0
    let maximum = 0
    const resolver = new LocalInstanceResolver({
      candidates: () => descriptors.map((descriptor) => ({ descriptor, registration: null })),
      probe: async (descriptor) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return { ok: true, value: LocalInstanceResolverTest.hello(descriptor) }
      },
    })

    await expect(resolver.resolve({})).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    })
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(16)
  })

  it('returns a safe timeout instead of spending one timeout per probe batch', async () => {
    vi.useFakeTimers()
    try {
      const descriptors = Array.from({ length: 40 }, (_, index) =>
        LocalInstanceResolverTest.descriptor(`instance-${index}`, 'development'))
      let started = 0
      const signals: AbortSignal[] = []
      const resolver = new LocalInstanceResolver({
        candidates: () => descriptors.map((descriptor) => ({ descriptor, registration: null })),
        probe: (_descriptor, signal) => {
          started += 1
          signals.push(signal)
          return new Promise(() => {})
        },
      })

      const resolving = resolver.resolve({})
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(resolving).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout' },
      })
      expect(started).toBe(16)
      expect(signals).toHaveLength(16)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts synchronous candidate discovery against the overall deadline', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      let probes = 0
      const descriptor = LocalInstanceResolverTest.descriptor('late', 'development')
      const resolver = new LocalInstanceResolver({
        candidates: () => {
          vi.setSystemTime(5_001)
          return [{ descriptor, registration: null }]
        },
        probe: async () => {
          probes += 1
          return { ok: true, value: LocalInstanceResolverTest.hello(descriptor) }
        },
      })

      await expect(resolver.resolve({})).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout' },
      })
      expect(probes).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a config directory strict, reads its stored production channel and never scans', async () => {
    const descriptor = LocalInstanceResolverTest.descriptor('strict', 'production', 'identity-strict')
    const test = new LocalInstanceResolverTest([])
    test.strict = descriptor
    test.identityDocument = LocalInstanceResolverTest.identity('identity-strict', 'production')

    await expect(test.resolve({ configDir: 'Q:\\Strict' }))
      .resolves.toEqual({ ok: true, value: descriptor })
    expect(test.candidateReads).toBe(0)
    expect(test.identityCalls).toEqual([{ configDir: 'Q:\\Strict', channel: undefined }])
    expect(test.strictCalls).toEqual([{ configIdentity: 'identity-strict', channel: 'production' }])

    test.identityDocument = null
    await expect(test.resolve({ configDir: 'Q:\\Missing' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
    expect(test.candidateReads).toBe(0)
  })

  it('passes an explicit wrong channel to the strict identity reader as a mismatch', async () => {
    const test = new LocalInstanceResolverTest([])
    test.identityError = new Error('Config channel mismatch: identity is production, launch requested development')

    await expect(test.resolve({ configDir: 'Q:\\Strict', channel: 'development' }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'operation-failed', detail: expect.stringContaining('channel mismatch') },
      })
    expect(test.candidateReads).toBe(0)
  })
})

class LocalInstanceResolverTest {
  readonly probed: string[] = []
  readonly answers = new Map<string, RemoteControlStepResult<RemoteControlHelloDto>>()
  readonly thrown = new Set<string>()
  readonly identityCalls: { configDir: string; channel: 'development' | 'production' | undefined }[] = []
  readonly strictCalls: { configIdentity: string; channel: 'development' | 'production' }[] = []
  readonly timeouts: number[] = []
  readonly rejectedRegistrations: RemoteControlRejectedRegistration[] = []
  candidateReads = 0
  strict: RemoteControlDescriptor | null = null
  identityDocument: ConfigIdentityDocument | null = null
  identityError: Error | null = null
  readonly resolver: LocalInstanceResolver

  constructor(descriptors: readonly RemoteControlDescriptor[]) {
    const deps: LocalInstanceResolverDeps = {
      candidates: (rejected) => {
        this.candidateReads += 1
        for (const registration of this.rejectedRegistrations) rejected(registration)
        return descriptors.map((descriptor) => ({ descriptor, registration: null }))
      },
      strictDescriptor: (configIdentity, channel) => {
        this.strictCalls.push({ configIdentity, channel })
        return this.strict === null
          ? { ok: false, error: { code: 'unavailable', detail: 'missing' } }
          : { ok: true, value: this.strict }
      },
      identity: (configDir, channel) => {
        this.identityCalls.push({ configDir, channel })
        if (this.identityError) throw this.identityError
        return this.identityDocument
      },
      probe: async (descriptor, _signal, timeoutMilliseconds) => {
        this.probed.push(descriptor.instanceId)
        this.timeouts.push(timeoutMilliseconds)
        if (this.thrown.has(descriptor.instanceId)) throw new Error('probe failed')
        return this.answers.get(descriptor.instanceId)
          ?? { ok: true, value: LocalInstanceResolverTest.hello(descriptor) }
      },
    }
    this.resolver = new LocalInstanceResolver(deps)
  }

  resolve(selection: Parameters<LocalInstanceResolver['resolve']>[0]) {
    return this.resolver.resolve(selection)
  }

  static descriptor(
    instanceId: string,
    runtimeChannel: 'development' | 'production',
    configIdentity = 'identity-a',
  ): RemoteControlDescriptor {
    return {
      schemaVersion: 1,
      protocol: RemoteControlConst.protocol,
      address: '127.0.0.1',
      port: 34_567,
      pid: process.pid,
      token: `token-${instanceId}`.padEnd(32, 'x'),
      operations: RemoteControlConst.descriptorOperations,
      websocket: true,
      configIdentity,
      runtimeChannel,
      instanceId,
      startedAt: 1_000,
      applicationVersion: '3.0.0',
    }
  }

  static hello(descriptor: RemoteControlDescriptor): RemoteControlHelloDto {
    return {
      protocol: descriptor.protocol,
      operations: descriptor.operations,
      ...(descriptor.optionalOperations === undefined
        ? {}
        : { optionalOperations: descriptor.optionalOperations }),
      configIdentity: descriptor.configIdentity,
      runtimeChannel: descriptor.runtimeChannel,
      instanceId: descriptor.instanceId,
      startedAt: descriptor.startedAt,
      applicationVersion: descriptor.applicationVersion,
    }
  }

  static identity(
    configIdentity: string,
    runtimeChannel: 'development' | 'production',
  ): ConfigIdentityDocument {
    return {
      schemaVersion: 1,
      configIdentity,
      runtimeChannel,
      createdAt: '2026-08-30T00:00:00.000Z',
    }
  }
}
