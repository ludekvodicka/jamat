import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCliUpdates } from './agentCliUpdates'
import type { AgentCliUpdateSource, CliInstallation } from './agentCliUpdateSource'

function installation(version = '1.0.0'): CliInstallation {
  return { version, command: { path: '/bin/agent', command: '/bin/agent', prefixArgs: [] }, channel: 'latest', updateSupported: true }
}

function fixture() {
  let installed: CliInstallation | null = installation()
  const source = {
    id: 'test', label: 'Test CLI',
    inspect: vi.fn(async (_signal: AbortSignal) => installed),
    latest: vi.fn(async () => '1.1.0'),
    update: vi.fn(async (_installation: CliInstallation, _signal: AbortSignal, output: (text: string) => void) => {
      output('Updated CLI\n')
      installed = installation('1.1.0')
    }),
  } satisfies AgentCliUpdateSource
  const changed = vi.fn()
  const updates = new AgentCliUpdates([source], changed)
  return { source, updates, changed, setInstalled: (value: CliInstallation | null) => { installed = value } }
}

afterEach(() => vi.useRealTimers())

describe('AgentCliUpdates', () => {
  it('checks once after startup and every hour, never installs on its timer, and stops its timer', async () => {
    vi.useFakeTimers()
    const { updates, source } = fixture()
    updates.start()
    updates.start()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(source.inspect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(source.inspect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(source.inspect).toHaveBeenCalledTimes(2)
    expect(source.update).not.toHaveBeenCalled()
    await updates.stop()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(source.inspect).toHaveBeenCalledTimes(2)
  })

  it('refreshes a stale offer before installing, then verifies the actually installed version', async () => {
    const { updates, source } = fixture()
    await updates.check()
    expect(updates.snapshot().agents[0]).toMatchObject({ available: true, installedVersion: '1.0.0' })
    await updates.install('test')
    expect(source.inspect).toHaveBeenCalledTimes(3)
    expect(updates.snapshot().agents[0]).toMatchObject({ available: false, installedVersion: '1.1.0', error: null, output: 'Updated CLI\n' })
  })

  it('skips installation if the native auto-updater already installed the release', async () => {
    const { updates, source, setInstalled } = fixture()
    await updates.check()
    setInstalled(installation('1.1.0'))
    await updates.install('test')
    expect(source.update).not.toHaveBeenCalled()
    expect(updates.snapshot().agents[0].available).toBe(false)
  })

  it('does not call a successful process a successful update without version evidence', async () => {
    const { updates, source } = fixture()
    source.update.mockImplementation(async () => {})
    await updates.install('test')
    expect(updates.snapshot().agents[0]).toMatchObject({ available: true, activity: 'idle' })
    expect(updates.snapshot().agents[0].error).toContain('1.0.0 is still installed')
  })

  it('retains the last release on network failure and does not install from stale data', async () => {
    const { updates, source } = fixture()
    await updates.check()
    source.latest.mockRejectedValue(new Error('Offline'))
    await updates.install('test')
    expect(updates.snapshot().agents[0]).toMatchObject({ available: true, latestVersion: '1.1.0', error: 'Offline' })
    expect(source.update).not.toHaveBeenCalled()
  })

  it('coalesces checks and rejects duplicate installation from another window', async () => {
    const { updates, source } = fixture()
    let finish!: (value: CliInstallation) => void
    source.inspect.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = updates.check()
    const second = updates.check()
    await Promise.resolve()
    await expect(updates.install('test')).rejects.toThrow('operation in progress')
    expect(source.inspect).toHaveBeenCalledTimes(1)
    finish(installation())
    await Promise.all([first, second])
  })

  it('handles absent and older CLIs without running an unsupported updater', async () => {
    const { updates, source, setInstalled } = fixture()
    setInstalled(null)
    await updates.check()
    expect(source.latest).not.toHaveBeenCalled()
    expect(updates.snapshot().agents[0]).toMatchObject({ available: false, canUpdate: false })
    setInstalled({ ...installation(), updateSupported: false })
    await updates.install('test')
    expect(source.update).not.toHaveBeenCalled()
    expect(updates.snapshot().agents[0].error).toContain('package manager')
    await expect(updates.install('untrusted-command')).rejects.toThrow('Unknown CLI')
  })

  it('aborts an active operation on shutdown without publishing after stop', async () => {
    const { updates, source, changed } = fixture()
    source.inspect.mockImplementation(signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })
    }))
    const checking = updates.check()
    await Promise.resolve()
    const notifications = changed.mock.calls.length
    await updates.stop()
    await checking
    expect(changed).toHaveBeenCalledTimes(notifications)
  })
})
