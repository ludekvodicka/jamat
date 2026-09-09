import { describe, expect, it, vi } from 'vitest'

import type {
  RemoteControlDescriptor,
  RemoteControlHelloDto,
  RemoteControlStepResult,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
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
  candidateReads = 0
  strict: RemoteControlDescriptor | null = null
  identityDocument: ConfigIdentityDocument | null = null
  identityError: Error | null = null
  readonly resolver: LocalInstanceResolver

  constructor(descriptors: readonly RemoteControlDescriptor[]) {
    const deps: LocalInstanceResolverDeps = {
      candidates: () => {
        this.candidateReads += 1
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
      probe: async (descriptor) => {
        this.probed.push(descriptor.instanceId)
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
