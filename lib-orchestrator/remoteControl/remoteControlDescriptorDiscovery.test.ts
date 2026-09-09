import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RemoteControlDescriptor } from './remoteControlApi.types'
import {
  RemoteControlInstanceRegistration,
  RemoteControlInstanceRegistry,
} from './remoteControlInstanceRegistry'
import { RemoteControlConst } from './remoteControlProtocol'
import {
  RemoteControlCandidate,
  RemoteControlDescriptorDiscovery,
} from './remoteControlDescriptorDiscovery'

describe('lib-orchestrator/remoteControl/remoteControlDescriptorDiscovery', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-v3-control-discovery-'))
    previousRoot = process.env.JAMAT_V3_LOCAL_STATE_DIR
    process.env.JAMAT_V3_LOCAL_STATE_DIR = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves the AppClientUI scope independently of cwd and accepts its exact identity', () => {
    const file = RemoteControlDescriptorDiscovery.descriptorFile('config-1', 'development')
    expect(file).toBe(join(
      root,
      'client-ui',
      'config-1',
      'development',
      'remote-control.json',
    ))
    expect(RemoteControlDescriptorDiscovery.instanceDescriptorFile(
      'config-1',
      'development',
      'instance/1',
      1_000,
    )).toBe(join(
      root,
      'client-ui',
      'config-1',
      'development',
      'control-descriptors',
      '1000-instance%2F1.json',
    ))
    const descriptor = RemoteControlDescriptorDiscoveryTest.descriptor()
    const explicit = join(root, 'explicit.json')
    writeFileSync(explicit, JSON.stringify(descriptor), 'utf8')

    expect(RemoteControlDescriptorDiscovery.read(
      'config-1',
      'development',
      explicit,
    )).toEqual({ ok: true, value: descriptor })
  })

  it('returns safe unavailable errors for missing, wrong-identity and malformed descriptors', () => {
    const missing = RemoteControlDescriptorDiscovery.read(
      'config-1',
      'development',
      join(root, 'missing.json'),
    )
    const wrong = join(root, 'wrong.json')
    writeFileSync(wrong, JSON.stringify(RemoteControlDescriptorDiscoveryTest.descriptor()), 'utf8')
    const wrongIdentity = RemoteControlDescriptorDiscovery.read('other', 'development', wrong)
    const malformed = join(root, 'malformed.json')
    writeFileSync(malformed, '{', 'utf8')
    const unreadable = RemoteControlDescriptorDiscovery.read('config-1', 'development', malformed)

    for (const answer of [missing, wrongIdentity, unreadable])
      expect(answer).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify([missing, wrongIdentity, unreadable])).not.toContain('x'.repeat(32))
  })

  it('accepts old and new capability shapes and rejects unknown or duplicate optional operations', () => {
    const oldFile = join(root, 'old.json')
    const newFile = join(root, 'new.json')
    const unknownFile = join(root, 'unknown.json')
    const duplicateFile = join(root, 'duplicate.json')
    const oldDescriptor = RemoteControlDescriptorDiscoveryTest.oldDescriptor()
    const newDescriptor = RemoteControlDescriptorDiscoveryTest.oldDescriptor({
      optionalOperations: RemoteControlConst.optionalOperations,
    })
    for (const [file, descriptor] of [[oldFile, oldDescriptor], [newFile, newDescriptor]] as const)
      writeFileSync(file, JSON.stringify(descriptor), 'utf8')
    writeFileSync(unknownFile, JSON.stringify({
      ...oldDescriptor,
      optionalOperations: ['unknown.operation'],
    }), 'utf8')
    writeFileSync(duplicateFile, JSON.stringify({
      ...oldDescriptor,
      optionalOperations: ['sessions.transcript', 'sessions.transcript'],
    }), 'utf8')

    expect(RemoteControlDescriptorDiscovery.read('config-1', 'development', oldFile))
      .toEqual({ ok: true, value: oldDescriptor })
    expect(RemoteControlDescriptorDiscovery.read('config-1', 'development', newFile))
      .toEqual({ ok: true, value: newDescriptor })
    expect(RemoteControlDescriptorDiscovery.read('config-1', 'development', unknownFile))
      .toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(RemoteControlDescriptorDiscovery.read('config-1', 'development', duplicateFile))
      .toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(oldDescriptor.operations).toEqual(RemoteControlConst.descriptorOperations)
    expect(RemoteControlDescriptorDiscoveryTest.oldDescriptorAccepts(oldDescriptor)).toBe(true)
    expect(RemoteControlDescriptorDiscoveryTest.oldDescriptorAccepts(newDescriptor)).toBe(true)
  })

  /*
   * The file outlives the process whenever AppClientUI is killed rather than stopped, and it carries
   * a bearer token. A client that trusts a stale one sends that token to whatever holds the port
   * now, so the token has to stay unread once the publisher is gone.
   */
  it('refuses a descriptor whose process is gone, without leaking its token', () => {
    const stale = join(root, 'stale.json')
    writeFileSync(stale, JSON.stringify({
      ...RemoteControlDescriptorDiscoveryTest.descriptor(),
      pid: 2_147_483_647,
    }), 'utf8')

    const answer = RemoteControlDescriptorDiscovery.read('config-1', 'development', stale)

    expect(answer).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify(answer)).not.toContain('x'.repeat(32))
  })

  it('discovers a registered descriptor outside the default state root', () => {
    const registry = join(root, 'registry')
    const descriptorFile = join(root, 'custom-state', 'private', 'remote-control.json')
    const descriptor = RemoteControlDescriptorDiscoveryTest.descriptor()
    RemoteControlDescriptorDiscoveryTest.writeDescriptor(descriptorFile, descriptor)
    RemoteControlDescriptorDiscoveryTest.writeRegistration(
      registry,
      RemoteControlInstanceRegistration.of(descriptor, descriptorFile),
    )

    expect(RemoteControlDescriptorDiscovery.registeredAndDefaultRootCandidates(
      registry,
      join(root, 'default-state'),
    )).toEqual([{
      descriptor,
      registration: RemoteControlInstanceRegistration.of(descriptor, descriptorFile),
    }])
  })

  it('ignores registrations whose descriptor is missing or disagrees with the entry', () => {
    const registry = join(root, 'registry')
    const descriptorFile = join(root, 'custom-state', 'remote-control.json')
    const descriptor = RemoteControlDescriptorDiscoveryTest.descriptor()
    RemoteControlDescriptorDiscoveryTest.writeDescriptor(descriptorFile, descriptor)
    RemoteControlDescriptorDiscoveryTest.writeRegistration(registry, {
      ...RemoteControlInstanceRegistration.of(descriptor, descriptorFile),
      instanceId: 'another-instance',
    }, 'mismatch.json')
    RemoteControlDescriptorDiscoveryTest.writeRegistration(registry, {
      ...RemoteControlInstanceRegistration.of(descriptor, descriptorFile),
      descriptorFile: join(root, 'missing.json'),
    }, 'missing.json')

    expect(RemoteControlDescriptorDiscovery.registeredAndDefaultRootCandidates(
      registry,
      join(root, 'default-state'),
    )).toEqual([])
  })

  it('scans the default descriptor tree and deduplicates a registered instance', () => {
    const registry = join(root, 'registry')
    const defaultRoot = join(root, 'default-state')
    const descriptor = RemoteControlDescriptorDiscoveryTest.descriptor()
    const descriptorFile = RemoteControlDescriptorDiscoveryTest.defaultDescriptorFile(
      defaultRoot,
      descriptor.configIdentity,
      descriptor.runtimeChannel,
    )
    RemoteControlDescriptorDiscoveryTest.writeDescriptor(descriptorFile, descriptor)
    const registration = RemoteControlInstanceRegistration.of(descriptor, descriptorFile)
    RemoteControlDescriptorDiscoveryTest.writeRegistration(registry, registration)

    expect(RemoteControlDescriptorDiscovery.registeredAndDefaultRootCandidates(
      registry,
      defaultRoot,
    )).toEqual([{ descriptor, registration }])
  })

  it('bounds the default descriptor scan and does not descend into links or extra levels', () => {
    const defaultRoot = join(root, 'default-state')
    const scope = join(defaultRoot, 'client-ui')
    const linkedTarget = join(root, 'linked-identity')
    const linkedDescriptor = RemoteControlDescriptorDiscoveryTest.descriptor({
      configIdentity: 'linked-config',
    })
    RemoteControlDescriptorDiscoveryTest.writeDescriptor(
      join(linkedTarget, 'development', 'remote-control.json'),
      linkedDescriptor,
    )
    mkdirSync(scope, { recursive: true })
    symlinkSync(linkedTarget, join(scope, 'linked-config'), 'junction')
    RemoteControlDescriptorDiscoveryTest.writeDescriptor(
      join(scope, 'nested', 'unexpected', 'development', 'remote-control.json'),
      RemoteControlDescriptorDiscoveryTest.descriptor({ configIdentity: 'nested' }),
    )

    for (let index = 0; index <= RemoteControlInstanceRegistry.entriesMaximumConst; index += 1) {
      const configIdentity = `config-${index.toString().padStart(3, '0')}`
      const descriptor = RemoteControlDescriptorDiscoveryTest.descriptor({
        configIdentity,
        instanceId: `instance-${index}`,
      })
      RemoteControlDescriptorDiscoveryTest.writeDescriptor(
        RemoteControlDescriptorDiscoveryTest.defaultDescriptorFile(
          defaultRoot,
          configIdentity,
          'development',
        ),
        descriptor,
      )
    }

    const candidates = RemoteControlDescriptorDiscovery.registeredAndDefaultRootCandidates(
      join(root, 'missing-registry'),
      defaultRoot,
    )
    expect(candidates).toHaveLength(RemoteControlInstanceRegistry.entriesMaximumConst)
    expect(candidates.some(({ descriptor }) => descriptor.configIdentity === 'linked-config'))
      .toBe(false)
  })

  it('projects only safe identity facts for conflicts', () => {
    const descriptor = RemoteControlDescriptorDiscoveryTest.descriptor()
    const candidate = RemoteControlCandidate.safeOf(descriptor)

    expect(candidate).toEqual({
      configIdentity: 'config-1',
      runtimeChannel: 'development',
      instanceId: 'instance-1',
      startedAt: 1_000,
      applicationVersion: '1.0.0',
    })
    expect(JSON.stringify(candidate)).not.toContain(descriptor.token)
    expect(candidate).not.toHaveProperty('port')
    expect(candidate).not.toHaveProperty('descriptorFile')
    expect(candidate).not.toHaveProperty('registrationFile')
  })
})

class RemoteControlDescriptorDiscoveryTest {
  private static readonly oldProtocolConst = 'appjamat-v3-control.v1' as const
  private static readonly oldDescriptorOperationsConst = [
    'system.hello',
    'system.status',
    'projects.list',
    'sessions.list',
    'sessions.create',
    'sessions.reopen',
    'sessions.finalize',
    'tabs.list',
    'tabs.open',
    'tabs.focus',
    'tabs.close',
    'terminal.peek',
    'terminal.send',
  ] as const
  private static readonly oldLocalOperationsConst = [
    'remote.computers.list',
    'remote.pairing.export',
    'remote.pairing.import',
  ] as const

  static oldDescriptorAccepts(input: unknown): boolean {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
    const value = input as Record<string, unknown>
    return value.schemaVersion === 1
      && value.protocol === RemoteControlDescriptorDiscoveryTest.oldProtocolConst
      && value.address === '127.0.0.1'
      && value.websocket === true
      && value.configIdentity === 'config-1'
      && value.runtimeChannel === 'development'
      && RemoteControlDescriptorDiscoveryTest.integer(value.port, 1, 65_535)
      && RemoteControlDescriptorDiscoveryTest.integer(value.pid, 1, Number.MAX_SAFE_INTEGER)
      && RemoteControlDescriptorDiscoveryTest.integer(value.startedAt, 0, Number.MAX_SAFE_INTEGER)
      && RemoteControlDescriptorDiscoveryTest.text(value.instanceId, 512)
      && RemoteControlDescriptorDiscoveryTest.text(value.applicationVersion, 512)
      && RemoteControlDescriptorDiscoveryTest.text(value.token, 512, 32)
      && Array.isArray(value.operations)
      && value.operations.length
        === RemoteControlDescriptorDiscoveryTest.oldDescriptorOperationsConst.length
      && value.operations.every((operation, index) =>
        operation === RemoteControlDescriptorDiscoveryTest.oldDescriptorOperationsConst[index])
      && (value.localOperations === undefined
        || (Array.isArray(value.localOperations)
          && value.localOperations.length
            === RemoteControlDescriptorDiscoveryTest.oldLocalOperationsConst.length
          && value.localOperations.every((operation, index) =>
            operation === RemoteControlDescriptorDiscoveryTest.oldLocalOperationsConst[index])))
      && RemoteControlDescriptorDiscoveryTest.alive(value.pid)
  }

  static text(input: unknown, maximum: number, minimum = 1): input is string {
    return typeof input === 'string' && input.length >= minimum && input.length <= maximum
  }

  static integer(input: unknown, minimum: number, maximum: number): input is number {
    return typeof input === 'number'
      && Number.isSafeInteger(input)
      && input >= minimum
      && input <= maximum
  }

  static alive(pid: unknown): boolean {
    if (typeof pid !== 'number') return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  static descriptor(
    overrides: Partial<RemoteControlDescriptor> = {},
  ): RemoteControlDescriptor {
    return {
      schemaVersion: 1,
      protocol: RemoteControlConst.protocol,
      address: '127.0.0.1',
      port: 34567,
      pid: process.pid,
      token: 'x'.repeat(32),
      operations: RemoteControlConst.operations,
      websocket: true,
      configIdentity: 'config-1',
      runtimeChannel: 'development',
      instanceId: 'instance-1',
      startedAt: 1_000,
      applicationVersion: '1.0.0',
      ...overrides,
    }
  }

  static oldDescriptor(
    overrides: Partial<RemoteControlDescriptor> = {},
  ): RemoteControlDescriptor {
    return RemoteControlDescriptorDiscoveryTest.descriptor({
      protocol: RemoteControlDescriptorDiscoveryTest.oldProtocolConst,
      operations: RemoteControlDescriptorDiscoveryTest.oldDescriptorOperationsConst,
      localOperations: RemoteControlDescriptorDiscoveryTest.oldLocalOperationsConst,
      ...overrides,
    })
  }

  static defaultDescriptorFile(
    root: string,
    configIdentity: string,
    channel: 'development' | 'production',
  ): string {
    return join(root, 'client-ui', configIdentity, channel, 'remote-control.json')
  }

  static writeDescriptor(file: string, descriptor: RemoteControlDescriptor): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(descriptor), 'utf8')
  }

  static writeRegistration(
    directory: string,
    registration: RemoteControlInstanceRegistration,
    name = 'registration.json',
  ): void {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, name), JSON.stringify(registration), 'utf8')
  }
}
