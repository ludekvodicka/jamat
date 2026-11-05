import { bindService } from '../shared/serviceIpcTestHarness'
import { describe, expect, it, vi } from 'vitest'
import { ServicePerfIpc } from './servicePerfIpc'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

describe('renderer performance boundary', () => {
  it('refuses unknown kinds, names, identity injection and unsupported renderer measurements', () => {
    const record = vi.fn()
    const build = { version: '1.0.0', inputHash: 'a'.repeat(64), builtAt: new Date().toISOString() }
    const service = bindService(new ServicePerfIpc({ record }, build))
    const at = Date.now()
    const valid = { kind: 'inputToFrame', at, p50: 30, p99: 30, count: 1 }
    service.accept(42, [valid, { ...valid, kind: 'unknown' }, { ...valid, process: 'main' },
      { kind: 'stall', at, ms: 150, covered: ['unknown'] },
      { kind: 'span', at, name: 'other', ms: 100, selfMs: 100, blocking: true, depth: 0 },
      { kind: 'sample', at, elu: 1, heapMb: null, loopP50: null, loopP99: null, loopMax: null },
      { ...valid, terminalContent: 'private' }])
    expect(record).toHaveBeenCalledWith([{ ...valid, v: 1, process: 'renderer', pid: 42, build }])
  })
})
