import { afterEach, expect, it, vi } from 'vitest'
import { MachineLoadSampler } from './machineLoadSampler'

const child = vi.hoisted(() => ({ kill: vi.fn(), unref: vi.fn(), stdin: { destroy: vi.fn() },
  stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } }))
vi.mock('node:child_process', () => ({ execFile: vi.fn(() => child) }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('bounds CIM completion even when inherited pipes prevent a close callback', async () => {
  vi.useFakeTimers()
  const result = expect(MachineLoadSampler.query()).rejects.toThrow('Process CPU query timed out')
  await vi.advanceTimersByTimeAsync(10_000)
  await result
  expect(child.kill).toHaveBeenCalledOnce()
  expect(child.stdin.destroy).toHaveBeenCalledOnce()
  expect(child.stdout.destroy).toHaveBeenCalledOnce()
  expect(child.stderr.destroy).toHaveBeenCalledOnce()
  expect(child.unref).toHaveBeenCalledOnce()
})
