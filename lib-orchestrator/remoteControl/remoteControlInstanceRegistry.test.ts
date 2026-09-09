import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RemoteControlDescriptor } from './remoteControlApi.types'
import {
  RemoteControlInstanceRegistration,
  RemoteControlInstanceRegistry,
} from './remoteControlInstanceRegistry'
import { RemoteControlConst } from './remoteControlProtocol'

describe('lib-orchestrator/remoteControl/remoteControlInstanceRegistry', () => {
  let root: string
  let registry: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-v3-control-registry-'))
    registry = join(root, 'control-registry')
    mkdirSync(registry)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('builds stable, distinct files for each controller instance', () => {
    const development = RemoteControlInstanceRegistry.fileOf(
      'config-1', 'development', 'instance-1', 1_000,
    )
    const production = RemoteControlInstanceRegistry.fileOf(
      'config-1', 'production', 'instance-1', 1_000,
    )
    const anotherIdentity = RemoteControlInstanceRegistry.fileOf(
      'config-2', 'development', 'instance-1', 1_000,
    )
    const anotherInstance = RemoteControlInstanceRegistry.fileOf(
      'config-1', 'development', 'instance-2', 1_000,
    )

    expect(dirname(development)).toBe(RemoteControlInstanceRegistry.directory())
    expect(new Set([development, production, anotherIdentity, anotherInstance]).size).toBe(4)
  })

  it('sorts newer instance filenames before stale crash entries', () => {
    const older = RemoteControlInstanceRegistry.fileOf(
      'config-1', 'development', 'instance-old', 1_000,
    )
    const newer = RemoteControlInstanceRegistry.fileOf(
      'config-1', 'development', 'instance-new', 2_000,
    )

    expect(newer.localeCompare(older)).toBeLessThan(0)
    expect(() => RemoteControlInstanceRegistry.fileOf(
      'config-1', 'development', 'instance-invalid', -1,
    )).toThrow('start time is invalid')
    expect(() => RemoteControlInstanceRegistry.fileOf(
      'config-1', 'development', 'instance-invalid', Number.NaN,
    )).toThrow('start time is invalid')
  })

  it('accepts only the exact secret-free registration contract', () => {
    const descriptorFile = join(root, 'private-state', 'remote-control.json')
    const registration = RemoteControlInstanceRegistration.of(
      RemoteControlInstanceRegistryTest.descriptor(),
      descriptorFile,
    )

    expect(RemoteControlInstanceRegistration.validate(registration)).toEqual(registration)
    expect(Object.keys(registration).sort()).toEqual([
      'applicationVersion',
      'configIdentity',
      'descriptorFile',
      'instanceId',
      'pid',
      'runtimeChannel',
      'schemaVersion',
      'startedAt',
    ])
    expect(() => RemoteControlInstanceRegistration.of(
      RemoteControlInstanceRegistryTest.descriptor(),
      'relative.json',
    )).toThrow('must be absolute')
    expect(RemoteControlInstanceRegistration.validate({ ...registration, token: 'secret' }))
      .toBeNull()
    expect(RemoteControlInstanceRegistration.validate({ ...registration, schemaVersion: 2 }))
      .toBeNull()
  })

  it('reads regular bounded entries and ignores every invalid file shape', () => {
    const valid = RemoteControlInstanceRegistration.of(
      RemoteControlInstanceRegistryTest.descriptor(),
      join(root, 'private-state', 'remote-control.json'),
    )
    RemoteControlInstanceRegistryTest.write(registry, 'valid.json', valid)
    RemoteControlInstanceRegistryTest.write(registry, 'malformed.json', '{')
    RemoteControlInstanceRegistryTest.write(
      registry,
      'oversized.json',
      'x'.repeat(RemoteControlInstanceRegistry.entryBytesMaximumConst + 1),
    )
    RemoteControlInstanceRegistryTest.write(registry, 'wrong-schema.json', {
      ...valid,
      schemaVersion: 2,
    })
    mkdirSync(join(registry, 'directory.json'))
    const target = join(root, 'linked-directory')
    mkdirSync(target)
    symlinkSync(target, join(registry, 'linked.json'), 'junction')

    expect(RemoteControlInstanceRegistry.read(registry)).toEqual([valid])
    expect(RemoteControlInstanceRegistry.read(join(root, 'missing'))).toEqual([])
  })

  it('processes at most the declared number of regular files', () => {
    const registration = RemoteControlInstanceRegistration.of(
      RemoteControlInstanceRegistryTest.descriptor(),
      join(root, 'private-state', 'remote-control.json'),
    )
    for (let index = 0; index <= RemoteControlInstanceRegistry.entriesMaximumConst; index += 1)
      RemoteControlInstanceRegistryTest.write(
        registry,
        `${index.toString().padStart(3, '0')}.json`,
        registration,
      )

    expect(RemoteControlInstanceRegistry.read(registry))
      .toHaveLength(RemoteControlInstanceRegistry.entriesMaximumConst)
  })
})

class RemoteControlInstanceRegistryTest {
  static descriptor(): RemoteControlDescriptor {
    return {
      schemaVersion: 1,
      protocol: RemoteControlConst.protocol,
      address: '127.0.0.1',
      port: 34_567,
      pid: process.pid,
      token: 'x'.repeat(32),
      operations: RemoteControlConst.operations,
      websocket: true,
      configIdentity: 'config-1',
      runtimeChannel: 'development',
      instanceId: 'instance-1',
      startedAt: 1_000,
      applicationVersion: '1.0.0',
    }
  }

  static write(directory: string, name: string, value: unknown): void {
    writeFileSync(
      join(directory, name),
      typeof value === 'string' ? value : JSON.stringify(value),
      'utf8',
    )
  }
}
