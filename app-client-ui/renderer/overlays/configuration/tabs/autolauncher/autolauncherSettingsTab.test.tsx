import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge, IpcResult } from '../../../../../shared/appClientUiIpc'
import type { AutolauncherResult, AutolauncherSnapshot } from '../../../../../shared/autolauncher'
import { AutolauncherSettingsTab } from './autolauncherSettingsTab'

function snapshot(change: Partial<AutolauncherSnapshot> = {}): AutolauncherSnapshot {
  return {
    supported: true,
    target: {
      configDir: 'C:/Users/Alex/.jamat-v3',
      configIdentity: 'alex-profile',
      runtimeChannel: 'production',
      mode: 'executable',
      path: 'C:/Program Files/Jamat/Jamat.exe',
    },
    installed: false,
    installedForThisProfile: false,
    installedConfigDir: null,
    running: false,
    connectionReady: false,
    launcherUrl: null,
    operation: 'idle',
    problem: null,
    ...change,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(initial = snapshot()) {
  let current = initial
  const listeners = new Set<(value: AutolauncherSnapshot) => void>()
  const bridge = {
    autolauncher: {
      get: vi.fn<AppClientUiBridge['autolauncher']['get']>(async () => ({ ok: true, value: current })),
      enable: vi.fn<AppClientUiBridge['autolauncher']['enable']>(async () => {
        current = {
          ...current, installed: true, installedForThisProfile: true,
          installedConfigDir: current.target.configDir, running: true, connectionReady: true,
          problem: null,
        }
        return { ok: true, value: { ok: true, snapshot: current } }
      }),
      disable: vi.fn<AppClientUiBridge['autolauncher']['disable']>(async () => {
        current = { ...current, installed: false, installedForThisProfile: false, running: false }
        return { ok: true, value: { ok: true, snapshot: current } }
      }),
    },
    onAutolauncherChanged: vi.fn<AppClientUiBridge['onAutolauncherChanged']>((listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
  } satisfies Pick<AppClientUiBridge, 'autolauncher' | 'onAutolauncherChanged'>
  Object.assign(window, { appClient: bridge })
  return {
    bridge,
    listeners,
    push: (value: AutolauncherSnapshot): void => {
      current = value
      for (const listener of listeners) listener(value)
    },
    setCurrent: (value: AutolauncherSnapshot): void => { current = value },
    mount: async (strict = false) => {
      const onDirtyChange = vi.fn()
      const component = <AutolauncherSettingsTab onDirtyChange={onDirtyChange} />
      const view = render(strict ? <StrictMode>{component}</StrictMode> : component)
      await act(async () => undefined)
      const invitation = view.getByLabelText('MiniWol invitation')
      if (!(invitation instanceof HTMLInputElement)) throw new Error('The tab drew no invitation input')
      return { view, invitation, onDirtyChange }
    },
  }
}

describe('app-client-ui/renderer/overlays/configuration/tabs/autolauncher/autolauncherSettingsTab', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('shows the captured profile and EXE without starting setup on open', async () => {
    const { bridge, mount } = fixture()
    const { view, invitation } = await mount()

    expect(view.getByText('C:/Users/Alex/.jamat-v3')).toBeTruthy()
    expect(view.getByText('alex-profile')).toBeTruthy()
    expect(view.getByText('Production')).toBeTruthy()
    expect(view.getByText('C:/Program Files/Jamat/Jamat.exe')).toBeTruthy()
    expect(view.container.textContent).toContain('remain signed in to Windows')
    expect(view.container.textContent).toContain('UAC')
    expect(view.getByRole('button', { name: 'Enable for this Jamat' })).toBeDisabled()
    expect(invitation.type).toBe('password')
    expect(view.container.querySelectorAll('input')).toHaveLength(1)
    expect(bridge.autolauncher.enable).not.toHaveBeenCalled()
    expect(bridge.autolauncher.disable).not.toHaveBeenCalled()
  })

  it('shows a source checkout and development channel from the captured target', async () => {
    const value = snapshot()
    value.target = { ...value.target, mode: 'source', runtimeChannel: 'development', path: 'Q:/Projects/Jamat' }
    const { view } = await fixture(value).mount()

    expect(view.getByText('Source checkout')).toBeTruthy()
    expect(view.getByText('Q:/Projects/Jamat')).toBeTruthy()
    expect(view.getByText('Development')).toBeTruthy()
  })

  it('forwards an opaque invitation unchanged and clears it only after enabling', async () => {
    const { bridge, mount } = fixture()
    const { view, invitation, onDirtyChange } = await mount()
    const text = '  opaque:invitation/{not-ui-json}  '
    fireEvent.change(invitation, { target: { value: text } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Enable for this Jamat' })) })

    expect(bridge.autolauncher.enable).toHaveBeenCalledExactlyOnceWith(text)
    expect(invitation.value).toBe('')
    expect(view.getByText('Installed for this Jamat')).toBeTruthy()
    expect(view.getByText('Running')).toBeTruthy()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('reuses the stored connection when updating and can disable the installation', async () => {
    const { bridge, mount } = fixture(snapshot({
      installed: true, installedForThisProfile: true, connectionReady: true,
    }))
    const { view } = await mount()

    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Update for this Jamat' })) })
    expect(bridge.autolauncher.enable).toHaveBeenCalledExactlyOnceWith(null)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Disable' })) })
    expect(bridge.autolauncher.disable).toHaveBeenCalledExactlyOnceWith()
    expect(view.getByText('Not installed')).toBeTruthy()
    expect(view.getByText('Stopped')).toBeTruthy()
  })

  it('names the other configured profile and requires its explicit replacement action', async () => {
    const { bridge, mount } = fixture(snapshot({
      installed: true, installedConfigDir: 'C:/Other/Profile', connectionReady: true,
    }))
    const { view } = await mount()

    expect(view.getByRole('note').textContent).toContain('C:/Other/Profile')
    expect(view.getByRole('note').textContent).toContain('Jamat profile that owns this installation')
    expect(view.getByRole('button', { name: 'Disable' })).toBeDisabled()
    fireEvent.click(view.getByRole('button', { name: 'Disable' }))
    expect(bridge.autolauncher.disable).not.toHaveBeenCalled()
    expect(bridge.autolauncher.enable).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Replace other profile with this Jamat' }))
    })
    expect(bridge.autolauncher.enable).toHaveBeenCalledExactlyOnceWith(null)
    expect(view.queryByRole('note')).toBeNull()
  })

  it('blocks duplicate clicks and input changes while Windows setup is pending', async () => {
    const setup = deferred<IpcResult<AutolauncherResult>>()
    const { bridge, mount, setCurrent } = fixture()
    bridge.autolauncher.enable.mockReturnValue(setup.promise)
    const { view, invitation } = await mount()
    fireEvent.change(invitation, { target: { value: 'invitation' } })
    const enable = view.getByRole('button', { name: 'Enable for this Jamat' })

    act(() => {
      fireEvent.click(enable)
      fireEvent.click(enable)
    })
    expect(bridge.autolauncher.enable).toHaveBeenCalledTimes(1)
    expect(invitation.disabled).toBe(true)
    expect(view.getByRole('button', { name: 'Refresh status' })).toBeDisabled()
    expect(view.getByRole('status').textContent).toContain('Windows permission prompt')
    const enabled = snapshot({ installed: true, installedForThisProfile: true, connectionReady: true })
    setCurrent(enabled)
    await act(async () => { setup.resolve({ ok: true, value: { ok: true, snapshot: enabled } }) })
    expect(invitation.disabled).toBe(false)
    expect(invitation.value).toBe('')
  })

  it('keeps the invitation after a cancelled Windows permission prompt and permits retry', async () => {
    const { bridge, mount } = fixture()
    bridge.autolauncher.enable.mockResolvedValueOnce({
      ok: true, value: { ok: false, problem: 'Windows permission was cancelled.' },
    })
    const { view, invitation } = await mount()
    fireEvent.change(invitation, { target: { value: 'invitation' } })

    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Enable for this Jamat' })) })
    expect(view.getByRole('alert').textContent).toContain('Windows permission was cancelled')
    expect(invitation.value).toBe('invitation')
    expect(invitation.disabled).toBe(false)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Enable for this Jamat' })) })
    expect(bridge.autolauncher.enable).toHaveBeenCalledTimes(2)
    expect(invitation.value).toBe('')
  })

  it('retries with the saved connection after pairing consumed the invitation before UAC cancellation', async () => {
    const { bridge, mount, setCurrent } = fixture()
    bridge.autolauncher.enable.mockImplementationOnce(async () => {
      setCurrent(snapshot({ connectionReady: true, problem: 'Windows permission was cancelled.' }))
      return { ok: true, value: { ok: false, problem: 'Windows permission was cancelled.' } }
    })
    const { view, invitation } = await mount()
    fireEvent.change(invitation, { target: { value: 'one-time-invitation' } })

    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Enable for this Jamat' })) })
    expect(invitation.value).toBe('one-time-invitation')
    expect(view.getByRole('alert').textContent).toContain('Windows permission was cancelled')
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Retry with saved connection' })) })

    expect(bridge.autolauncher.enable.mock.calls).toEqual([['one-time-invitation'], [null]])
    expect(invitation.value).toBe('')
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByText('Installed for this Jamat')).toBeTruthy()
  })

  it.each(['transport', 'rejection', 'domain'] as const)('does not echo an invitation from a %s failure', async (failure) => {
    const { bridge, mount } = fixture()
    const secret = 'secret-invitation-value'
    if (failure === 'transport')
      bridge.autolauncher.enable.mockResolvedValueOnce({ ok: false, error: secret })
    else if (failure === 'rejection')
      bridge.autolauncher.enable.mockRejectedValueOnce(new Error(secret))
    else if (failure === 'domain')
      bridge.autolauncher.enable.mockResolvedValueOnce({ ok: true, value: { ok: false, problem: `Invalid ${secret}` } })
    else throw new Error('Unknown test failure mode')
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { view, invitation } = await mount()
    fireEvent.change(invitation, { target: { value: secret } })

    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Enable for this Jamat' })) })

    expect(view.getByRole('alert').textContent).not.toContain(secret)
    expect(log).not.toHaveBeenCalled()
    expect(invitation.disabled).toBe(false)
    expect(invitation.value).toBe(secret)
  })

  it('applies status pushes immediately, coalesces reads and ignores an older read', async () => {
    const oldRead = deferred<IpcResult<AutolauncherSnapshot>>()
    const { bridge, mount, push } = fixture()
    bridge.autolauncher.get.mockReturnValueOnce(oldRead.promise)
    const { view } = await mount()
    const installed = snapshot({ installed: true, installedForThisProfile: true, connectionReady: true, running: true })

    act(() => {
      push(installed)
      push(installed)
      push(installed)
      vi.advanceTimersByTime(100)
    })
    expect(view.getByText('Installed for this Jamat')).toBeTruthy()
    expect(bridge.autolauncher.get).toHaveBeenCalledTimes(1)
    await act(async () => { oldRead.resolve({ ok: true, value: snapshot() }) })
    expect(bridge.autolauncher.get).toHaveBeenCalledTimes(2)
    expect(view.getByText('Installed for this Jamat')).toBeTruthy()
    expect(view.queryByText('Not installed')).toBeNull()
  })

  it('does not let an outstanding refresh restore the pre-install state', async () => {
    const { bridge, mount } = fixture(snapshot({ connectionReady: true }))
    const { view } = await mount()
    const stale = deferred<IpcResult<AutolauncherSnapshot>>()
    bridge.autolauncher.get.mockReturnValueOnce(stale.promise)
    act(() => { fireEvent.click(view.getByRole('button', { name: 'Refresh status' })) })

    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Enable for this Jamat' })) })
    expect(view.getByText('Installed for this Jamat')).toBeTruthy()
    await act(async () => { stale.resolve({ ok: true, value: snapshot() }) })
    expect(view.getByText('Installed for this Jamat')).toBeTruthy()
    expect(bridge.autolauncher.get).toHaveBeenCalledTimes(3)
  })

  it('locks commands during setup in another window and on unsupported platforms', async () => {
    const { bridge, mount, push } = fixture(snapshot({ connectionReady: true, operation: 'installing' }))
    const { view, invitation } = await mount()
    expect(invitation.disabled).toBe(true)
    expect(view.getByRole('button', { name: 'Enable for this Jamat' })).toBeDisabled()

    act(() => { push(snapshot({ supported: false, connectionReady: true })) })
    expect(view.getByText('Autolauncher is available on Windows only.')).toBeTruthy()
    expect(invitation.disabled).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'Enable for this Jamat' }))
    expect(bridge.autolauncher.enable).not.toHaveBeenCalled()
  })

  it('unsubscribes and ignores a setup result after the settings tab is closed', async () => {
    const setup = deferred<IpcResult<AutolauncherResult>>()
    const { bridge, mount, listeners } = fixture(snapshot({ connectionReady: true }))
    bridge.autolauncher.enable.mockReturnValue(setup.promise)
    const { view, onDirtyChange } = await mount(true)
    expect(listeners.size).toBe(1)
    act(() => { fireEvent.click(view.getByRole('button', { name: 'Enable for this Jamat' })) })
    view.unmount()
    onDirtyChange.mockClear()
    const readsBeforeResult = bridge.autolauncher.get.mock.calls.length

    await act(async () => { setup.resolve({ ok: true, value: { ok: true, snapshot: snapshot() } }) })
    expect(listeners.size).toBe(0)
    expect(onDirtyChange).not.toHaveBeenCalled()
    expect(bridge.autolauncher.get).toHaveBeenCalledTimes(readsBeforeResult)
  })

  it('bounds failed status reads, keeps raw errors out of logs, and recovers on refresh', async () => {
    const { bridge, mount } = fixture()
    bridge.autolauncher.get.mockRejectedValue(new Error('private-invitation-data'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { view } = await mount()

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(bridge.autolauncher.get).toHaveBeenCalledTimes(5)
    expect(view.getByRole('alert').textContent).toContain('stopped refreshing')
    expect(log.mock.calls.flat().join(' ')).not.toContain('private-invitation-data')
    bridge.autolauncher.get.mockResolvedValue({ ok: true, value: snapshot() })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Refresh status' })) })
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByText('Not installed')).toBeTruthy()
  })

  it('cancels queued snapshot work when the tab closes during a read', async () => {
    const read = deferred<IpcResult<AutolauncherSnapshot>>()
    const { bridge, mount, push, listeners } = fixture()
    bridge.autolauncher.get.mockReturnValue(read.promise)
    const { view, onDirtyChange } = await mount()
    act(() => { push(snapshot()) })
    view.unmount()
    onDirtyChange.mockClear()

    await act(async () => {
      read.resolve({ ok: true, value: snapshot() })
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(listeners.size).toBe(0)
    expect(bridge.autolauncher.get).toHaveBeenCalledTimes(1)
    expect(onDirtyChange).not.toHaveBeenCalled()
  })
})
