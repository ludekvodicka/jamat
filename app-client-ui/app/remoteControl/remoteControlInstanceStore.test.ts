import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlDescriptor } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import {
  RemoteControlInstanceRegistration,
  RemoteControlInstanceRegistry,
} from '../../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlInstanceStore } from './remoteControlInstanceStore'

describe('app-client-ui/app/remoteControl/remoteControlInstanceStore', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('atomically writes only the strict secret-free registration contract', () => {
    const root = RemoteControlInstanceStoreTest.root(roots)
    const file = join(root, 'registry', 'entry.json')
    const descriptor = RemoteControlInstanceStoreTest.descriptor('instance-1')
    const store = new RemoteControlInstanceStore(file)

    store.write(RemoteControlInstanceRegistration.of(descriptor, join(root, 'descriptor.json')))

    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored).toEqual({
      schemaVersion: 1,
      configIdentity: descriptor.configIdentity,
      runtimeChannel: descriptor.runtimeChannel,
      instanceId: descriptor.instanceId,
      startedAt: descriptor.startedAt,
      applicationVersion: descriptor.applicationVersion,
      pid: descriptor.pid,
      descriptorFile: join(root, 'descriptor.json'),
    })
    expect(JSON.stringify(stored)).not.toContain(descriptor.token)
    for (const forbidden of ['token', 'address', 'port', 'operations'])
      expect(stored).not.toHaveProperty(forbidden)
  })

  it('refuses an entry carrying an extra secret-bearing field', () => {
    const root = RemoteControlInstanceStoreTest.root(roots)
    const store = new RemoteControlInstanceStore(join(root, 'entry.json'))
    const registration = RemoteControlInstanceRegistration.of(
      RemoteControlInstanceStoreTest.descriptor('instance-1'),
      join(root, 'descriptor.json'),
    )

    expect(() => store.write({ ...registration, token: 'secret' } as typeof registration))
      .toThrow('registration is invalid')
  })

  it('removes only its own entry', () => {
    const root = RemoteControlInstanceStoreTest.root(roots)
    const file = join(root, 'entry.json')
    const descriptorFile = join(root, 'descriptor.json')
    const store = new RemoteControlInstanceStore(file)
    store.write(RemoteControlInstanceRegistration.of(
      RemoteControlInstanceStoreTest.descriptor('instance-old'),
      descriptorFile,
    ))
    store.removeIfOwned('another-instance')
    expect(JSON.parse(readFileSync(file, 'utf8')).instanceId).toBe('instance-old')
    store.removeIfOwned('instance-old')
    store.removeIfOwned('instance-old')
    expect(existsSync(file)).toBe(false)
  })

  it('keeps a newer instance registration when an older instance cleans up', () => {
    const root = RemoteControlInstanceStoreTest.root(roots)
    const oldFile = join(root, 'registry', 'instance-old.json')
    const newFile = join(root, 'registry', 'instance-new.json')
    const descriptorFile = join(root, 'descriptor.json')
    const oldStore = new RemoteControlInstanceStore(oldFile)
    const newStore = new RemoteControlInstanceStore(newFile)
    oldStore.write(RemoteControlInstanceRegistration.of(
      RemoteControlInstanceStoreTest.descriptor('instance-old'),
      descriptorFile,
    ))
    newStore.write(RemoteControlInstanceRegistration.of(
      RemoteControlInstanceStoreTest.descriptor('instance-new'),
      descriptorFile,
    ))

    oldStore.removeIfOwned('instance-old')

    expect(existsSync(oldFile)).toBe(false)
    expect(JSON.parse(readFileSync(newFile, 'utf8')).instanceId).toBe('instance-new')
  })

  it('does not read or remove an oversized registry file', () => {
    const root = RemoteControlInstanceStoreTest.root(roots)
    const file = join(root, 'entry.json')
    writeFileSync(
      file,
      'x'.repeat(RemoteControlInstanceRegistry.entryBytesMaximumConst + 1),
      'utf8',
    )

    new RemoteControlInstanceStore(file).removeIfOwned('instance-1')

    expect(existsSync(file)).toBe(true)
  })

  it('keys identities and channels to different registry files', () => {
    expect(RemoteControlInstanceRegistry.fileOf('identity-a', 'development', 'instance-a', 1_000))
      .not.toBe(RemoteControlInstanceRegistry.fileOf(
        'identity-a', 'production', 'instance-a', 1_000,
      ))
    expect(RemoteControlInstanceRegistry.fileOf('identity-a', 'development', 'instance-a', 1_000))
      .not.toBe(RemoteControlInstanceRegistry.fileOf(
        'identity-b', 'development', 'instance-a', 1_000,
      ))
    expect(RemoteControlInstanceRegistry.fileOf('identity-a', 'development', 'instance-a', 1_000))
      .not.toBe(RemoteControlInstanceRegistry.fileOf(
        'identity-a', 'development', 'instance-b', 1_000,
      ))
  })

  it('prunes more than 256 crash registrations while retaining live, uncertain and foreign entries', () => {
    const root = RemoteControlInstanceStoreTest.root(roots)
    const registration = (id: string, pid: number) => RemoteControlInstanceRegistration.of(
      { ...RemoteControlInstanceStoreTest.descriptor(id), pid }, join(root, `${id}.descriptor.json`))
    const fileOf = (value: ReturnType<typeof registration>) => join(root,
      RemoteControlInstanceRegistry.fileOf(value.configIdentity, value.runtimeChannel, value.instanceId, value.startedAt).split(/[\\/]/).at(-1)!)
    for (let index = 0; index < 300; index++) {
      const value = registration(`dead-${index}`, 100)
      writeFileSync(fileOf(value), JSON.stringify(value))
    }
    const live = registration('live', 101), uncertain = registration('uncertain', 102)
    writeFileSync(fileOf(live), JSON.stringify(live))
    writeFileSync(fileOf(uncertain), JSON.stringify(uncertain))
    writeFileSync(join(root, 'foreign.json'), JSON.stringify(registration('foreign', 100)))
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 100) throw Object.assign(new Error('dead'), { code: 'ESRCH' })
      if (pid === 102) throw Object.assign(new Error('unknown'), { code: 'EPERM' })
      return true
    })
    const current = registration('current', 103)
    new RemoteControlInstanceStore(fileOf(current)).write(current)
    expect(RemoteControlInstanceRegistry.readComplete(root).map((entry) => entry.instanceId).sort())
      .toEqual(['current', 'foreign', 'live', 'uncertain'])
    expect(existsSync(live.descriptorFile)).toBe(false)
  })
})

class RemoteControlInstanceStoreTest {
  static root(roots: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-instance-store-'))
    roots.push(root)
    return root
  }

  static descriptor(instanceId: string): RemoteControlDescriptor {
    return {
      schemaVersion: 1,
      protocol: RemoteControlConst.protocol,
      address: '127.0.0.1',
      port: 34_567,
      pid: process.pid,
      token: 'private-bearer-token',
      operations: RemoteControlConst.operations,
      websocket: true,
      configIdentity: 'config-test',
      runtimeChannel: 'development',
      instanceId,
      startedAt: 1_000,
      applicationVersion: '3.0.0-test',
    }
  }
}
