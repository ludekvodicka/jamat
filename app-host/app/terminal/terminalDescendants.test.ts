import { execFileSync, spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalDescendants } from './terminalDescendants.js'

const processQuery = vi.hoisted(() => ({
  child: { kill: vi.fn(), unref: vi.fn(), stdin: { destroy: vi.fn() }, stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } },
  callback: undefined as ((error: Error | null, stdout: string, stderr: string) => void) | undefined,
  real: false,
}))

// An exited Windows query can leave an inherited pipe open, delaying execFile's callback.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn((file, args, options, callback) => {
    if (processQuery.real) return actual.execFile(file, args, options, callback)
    processQuery.callback = callback
    return processQuery.child
  }) }
})

afterEach(() => { processQuery.real = false; vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

function creationOf(pid: number): number {
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `([DateTimeOffset](Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate).ToUnixTimeMilliseconds()`], { encoding: 'utf8' }).trim())
}

// Get-Process cannot read the start time of a protected process; a retained PID Windows gave to one is not ours.
it.runIf(process.platform === 'win32')('skips a retained PID now held by a protected process', async () => {
  processQuery.real = true
  await expect(TerminalDescendants.stop([{ pid: 4, startedAt: creationOf(4) - 60_000 }])).resolves.toBeUndefined()
}, 20_000)

it.runIf(process.platform === 'win32')('kills an owned child only when its start identity matches', async () => {
  processQuery.real = true
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    const born = creationOf(child.pid!)
    await TerminalDescendants.stop([{ pid: child.pid!, startedAt: born + 60_000 }])
    expect(child.exitCode === null && child.signalCode === null).toBe(true)
    await TerminalDescendants.stop([{ pid: child.pid!, startedAt: born }])
    await exited
  } finally {
    child.kill()
  }
}, 20_000)

it('refuses with the failed identities only, not the query command line', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const stopped = TerminalDescendants.stop([{ pid: 123, startedAt: 456 }])
  processQuery.callback!(new Error('Command failed: powershell.exe -NoProfile -NonInteractive -Command $ErrorActionPreference=...'), '', 'PID 123: Access is denied\r\n')
  await expect(stopped).rejects.toThrow(/^PID 123: Access is denied$/)
})

it('refuses a process query at its deadline even when no close callback arrives', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.useFakeTimers()
  let result = 'pending'
  void TerminalDescendants.capture(123, 456).then(() => { result = 'accepted' }, (error: Error) => { result = error.message })
  await vi.advanceTimersByTimeAsync(10_001)
  expect(result).toMatch(/timed out/)
  expect(processQuery.child.kill).toHaveBeenCalledOnce()
  expect(processQuery.child.stdout.destroy).toHaveBeenCalledOnce()
  expect(processQuery.child.stderr.destroy).toHaveBeenCalledOnce()
})

it('also bounds descendant termination when the query callback never arrives', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.useFakeTimers()
  const stopped = TerminalDescendants.stop([{ pid: 123, startedAt: 456 }])
  const refused = expect(stopped).rejects.toThrow(/timed out after 10000 ms/)
  await vi.advanceTimersByTimeAsync(9999)
  expect(processQuery.child.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2)
  await refused
  expect(processQuery.child.kill).toHaveBeenCalledOnce()
})

it('cancels the deadline after a completed inspection', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.useFakeTimers()
  const captured = TerminalDescendants.capture(123, 456)
  processQuery.callback!(null, JSON.stringify([
    { pid: 123, parent: 1, startedAt: 456 }, { pid: 789, parent: 123, startedAt: 457 },
  ]), '')
  expect(await captured).toEqual([{ pid: 789, parent: 123, startedAt: 457 }])
  await vi.advanceTimersByTimeAsync(5000)
  expect(processQuery.child.kill).not.toHaveBeenCalled()
})
