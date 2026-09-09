import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RemoteControlDescriptor } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlDescriptorStore } from './remoteControlDescriptorStore'

describe('app-client-ui/app/remoteControl/remoteControlDescriptorStore', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('removes only the per-instance descriptor owned by this store', () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-control-descriptor-'))
    roots.push(root)
    const oldFile = join(root, 'instance-old.json')
    const newFile = join(root, 'instance-new.json')
    const oldStore = new RemoteControlDescriptorStore(oldFile)
    const newStore = new RemoteControlDescriptorStore(newFile)
    oldStore.write(RemoteControlDescriptorStoreTest.descriptor('instance-old'))
    newStore.write(RemoteControlDescriptorStoreTest.descriptor('instance-new'))

    oldStore.remove()
    oldStore.remove()

    expect(existsSync(oldFile)).toBe(false)
    expect(JSON.parse(readFileSync(newFile, 'utf8')).instanceId).toBe('instance-new')
  })
})

class RemoteControlDescriptorStoreTest {
  static descriptor(instanceId: string): RemoteControlDescriptor {
    return {
      schemaVersion: 1,
      protocol: RemoteControlConst.protocol,
      address: '127.0.0.1',
      port: 34_567,
      pid: process.pid,
      token: 'private-bearer-token'.padEnd(32, 'x'),
      operations: RemoteControlConst.descriptorOperations,
      websocket: true,
      configIdentity: 'config-test',
      runtimeChannel: 'development',
      instanceId,
      startedAt: 1_000,
      applicationVersion: '3.0.0-test',
    }
  }
}
