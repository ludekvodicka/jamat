import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostDescriptor } from '../../app-host/app/wire/hostWire.js'
import { HostGate } from './hostGate'

describe('HostGate', () => {
  it('refuses managed runs on a reachable old Host before a run record is created', () => {
    const host = { hostInstanceId: 'old', capabilities: ['pty.release.v2'] } as unknown as HostDescriptor
    const gate = new HostGate(() => host, () => true)
    expect(gate.problemOf()).toBeNull()
    expect(gate.problemOf(true)).toContain('Restart the Host')
    host.capabilities.push('runtime.managed-descendants.v1')
    expect(gate.problemOf(true)).toBeNull()
  })
  it('persists an OOM for the launched instance when the Host is replaced during the call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-host-gate-'))
    try {
      const host = { hostInstanceId: 'old', capabilities: ['pty.release.v2'] } as unknown as HostDescriptor
      const file = join(directory, 'host-gate.json')
      const gate = new HostGate(() => host, () => true, file)
      await gate.launch(async () => {
        host.hostInstanceId = 'replacement'
        return { ok: false, code: 'op-rejected', status: 500, detail: 'ERR_WORKER_OUT_OF_MEMORY' }
      })
      expect(gate.problemOf()).toBeNull()
      const restartedClient = new HostGate(() => host, () => true, file)
      expect(restartedClient.problemOf()).toBeNull()
      host.hostInstanceId = 'old'
      expect(restartedClient.problemOf()).toContain('ERR_WORKER_OUT_OF_MEMORY')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('refuses an old or unreachable Host before launching', async () => {
    let reachable = true
    const host = { hostInstanceId: 'one', capabilities: [] } as unknown as HostDescriptor
    const gate = new HostGate(() => host, () => reachable)
    const launch = vi.fn(async () => ({ ok: true as const, value: 1 }))
    expect(await gate.launch(launch)).toMatchObject({ ok: false, detail: expect.stringContaining('old build') })
    expect(launch).not.toHaveBeenCalled()
    host.capabilities.push('pty.release.v2')
    expect(await gate.launch(launch)).toMatchObject({ ok: true })
    reachable = false
    expect(gate.problemOf()).toContain('cannot be reached')
  })

  it('closes after one OOM and reopens only for another Host instance', async () => {
    const host = { hostInstanceId: 'one', capabilities: ['pty.release.v2'] } as unknown as HostDescriptor
    const gate = new HostGate(() => host, () => true)
    await gate.launch(async () => ({ ok: false, code: 'op-rejected', status: 500, detail: 'ERR_WORKER_OUT_OF_MEMORY' }))
    expect(gate.problemOf()).toContain('ERR_WORKER_OUT_OF_MEMORY')
    host.hostInstanceId = 'two'
    expect(gate.problemOf()).toBeNull()
  })
})
