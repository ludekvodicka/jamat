import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  RemarkableDependencyStatus,
  RemarkableResult,
  RemarkableSettingsSnapshot,
} from '../../../../../shared/remarkableApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import type { RemarkableSettingsValue } from '../../../../../shared/remarkableSettings'
import { RemarkableSettingsTab } from './remarkableSettingsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/remarkable/remarkableSettingsTab', () => {
  const fingerprintConst = `SHA256:${'A'.repeat(43)}`
  const candidateConst = `SHA256:${'B'.repeat(43)}`
  const readyConst: RemarkableDependencyStatus = {
    kind: 'ready',
    bundleId: 'bundle-1',
    nodeVersion: '22.23.2',
    cliVersion: '1.4.0',
  }

  class BridgeStub {
    readonly saved: RemarkableSettingsValue[] = []
    readonly passwords: string[] = []
    snapshot: RemarkableSettingsSnapshot = {
      value: {
        host: '10.0.0.25',
        fingerprint: fingerprintConst,
        timeoutMilliseconds: 180_000,
      },
      passwordConfigured: true,
    }
    dependencyStatus: RemarkableDependencyStatus = readyConst
    saveResult: RemarkableResult = { ok: true, value: undefined }
    installResult: RemarkableResult<RemarkableDependencyStatus> = {
      ok: true,
      value: readyConst,
    }
    detectResult: RemarkableResult<{ host: string; fingerprint: string }> = {
      ok: true,
      value: { host: '10.0.0.25', fingerprint: candidateConst },
    }
    setResult: RemarkableResult = { ok: true, value: undefined }
    clearResult: RemarkableResult = { ok: true, value: undefined }
    testResult: RemarkableResult = { ok: true, value: undefined }

    install(): void {
      const bridge = {
        remarkable: {
          getSettings: () => Promise.resolve({ ok: true as const, value: this.snapshot }),
          saveSettings: (value: RemarkableSettingsValue) => {
            this.saved.push(value)
            if (this.saveResult.ok) this.snapshot = { ...this.snapshot, value }
            return Promise.resolve({ ok: true as const, value: this.saveResult })
          },
          dependenciesStatus: () => Promise.resolve({
            ok: true as const,
            value: this.dependencyStatus,
          }),
          installDependencies: () => {
            if (this.installResult.ok) this.dependencyStatus = this.installResult.value
            return Promise.resolve({ ok: true as const, value: this.installResult })
          },
          detectFingerprint: () => Promise.resolve({
            ok: true as const,
            value: this.detectResult,
          }),
          setPassword: (_host: string, password: string) => {
            this.passwords.push(password)
            if (this.setResult.ok)
              this.snapshot = { ...this.snapshot, passwordConfigured: true }
            return Promise.resolve({ ok: true as const, value: this.setResult })
          },
          clearPassword: (_host: string) => {
            if (this.clearResult.ok)
              this.snapshot = { ...this.snapshot, passwordConfigured: false }
            return Promise.resolve({ ok: true as const, value: this.clearResult })
          },
          testConnection: () => Promise.resolve({
            ok: true as const,
            value: this.testResult,
          }),
        },
      }
      ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
        Pick<AppClientUiBridge, 'remarkable'>
    }
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(stub = new BridgeStub()) {
    stub.install()
    const onDirtyChange = vi.fn()
    const view = render(<RemarkableSettingsTab onDirtyChange={onDirtyChange} />)
    await waitFor(() => expect(view.getByLabelText('Tablet host or IP address')).toBeTruthy())
    await waitFor(() => expect(view.container.textContent).not.toContain('Checking dependencies…'))
    return { onDirtyChange, stub, view }
  }

  it('loads connection settings and exposes the secret only as configured state', async () => {
    const { view } = await mount()
    const host = view.getByLabelText('Tablet host or IP address') as HTMLInputElement
    const timeout = view.getByLabelText('Connection timeout') as HTMLInputElement

    expect(host.value).toBe('10.0.0.25')
    expect(timeout.value).toBe('180000')
    expect([timeout.min, timeout.max, timeout.step]).toEqual(['1000', '600000', '1'])

    const fingerprint = view.getByLabelText('Pinned SSH fingerprint') as HTMLInputElement
    expect(fingerprint.value).toBe(fingerprintConst)
    expect(fingerprint.readOnly).toBe(true)

    const password = view.getByLabelText('Tablet password') as HTMLInputElement
    expect(password.type).toBe('password')
    expect(password.value).toBe('')
    expect(view.container.textContent).toContain('Configured for 10.0.0.25.')
  })

  /**
   * The card used to run Device, Password, Dependencies, Connection, which is nearly the reverse of
   * the only order that works, and a blocked button said nothing until it was pressed. A user typed a
   * host, pressed Detect and was answered with a missing password "for the saved host" - state the
   * card had never shown. The order is the fix; hiding four of the five steps behind a strip of tabs
   * was not, so every step is on screen at once and carries its own state.
   */
  it('numbers the setup in the order it has to be done and shows every step at once', async () => {
    const stub = new BridgeStub()
    stub.snapshot = { value: { timeoutMilliseconds: 180_000 }, passwordConfigured: false }
    const { view } = await mount(stub)
    const titles = Array.from(
      view.container.querySelectorAll('.jamat-configuration-remarkable__title'),
    ).map((title) => (title.textContent ?? '').trim())

    expect(titles).toEqual([
      '1Dependencies',
      '2Tablet host or IP address',
      'Connection timeout',
      '3Tablet password',
      '4Pinned SSH fingerprint',
      '5Connection',
    ])
    expect(view.queryAllByRole('tab')).toEqual([])
  })

  /** The mark is the whole state: hovering it has to say what to do, not just that something is. */
  it('marks each step at the right edge and says on hover what it is waiting for', async () => {
    const stub = new BridgeStub()
    stub.snapshot = { value: { timeoutMilliseconds: 180_000 }, passwordConfigured: false }
    const { view } = await mount(stub)
    const marks = view.getAllByRole('img')
      .map((mark) => [mark.textContent, mark.getAttribute('title')])

    // Dependencies are ready in this stub, so the host is the first thing still to do.
    expect(marks).toEqual([
      ['✓', 'Done: the verified sidecar bundle is installed.'],
      ['!', 'To do: enter the tablet host and press Save.'],
      ['!', 'Enter a tablet host in step 2 and save it first.'],
      ['!', 'Enter a tablet host in step 2 and save it first.'],
      ['!', 'Enter a tablet host in step 2 and save it first.'],
    ])
    marks.forEach(([, tooltip], index) =>
      expect(view.getAllByRole('img')[index]?.getAttribute('aria-label')).toBe(tooltip))
  })

  it('says what a blocked step is waiting for instead of failing after the click', async () => {
    const stub = new BridgeStub()
    stub.snapshot = {
      value: { timeoutMilliseconds: 180_000 },
      passwordConfigured: false,
    }
    stub.dependencyStatus = { kind: 'missing', detail: 'Not installed yet' }
    const { view } = await mount(stub)

    expect(view.container.textContent).toContain('Install the dependencies in step 1 first.')
    expect((view.getByRole('button', { name: 'Detect fingerprint' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect((view.getByRole('button', { name: 'Set or replace password' }) as HTMLButtonElement).disabled)
      .toBe(true)

    stub.dependencyStatus = readyConst
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Install dependencies' }))
    })

    expect(view.container.textContent).toContain('Enter a tablet host in step 2 and save it first.')

    fireEvent.change(view.getByLabelText('Tablet host or IP address'), {
      target: { value: '10.0.0.25' },
    })
    expect(view.container.textContent).toContain('Unsaved changes. Press Save below to continue.')

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Save' }))
    })

    expect(view.container.textContent).toContain('Set the tablet password in step 3 first.')

    expect((view.getByRole('button', { name: 'Set or replace password' }) as HTMLButtonElement).disabled)
      .toBe(true)
    fireEvent.change(view.getByLabelText('Tablet password'), { target: { value: 'secret' } })
    expect((view.getByRole('button', { name: 'Set or replace password' }) as HTMLButtonElement).disabled)
      .toBe(false)

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Set or replace password' }))
    })

    expect((view.getByRole('button', { name: 'Detect fingerprint' }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect(view.container.textContent).toContain('Detect and save a fingerprint in step 4 first.')
    expect((view.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled)
      .toBe(true)

    // The case the user hit: a host that IS saved, then edited. The password and the fingerprint
    // belong to the saved value, so both steps wait for Save rather than failing on the click.
    fireEvent.change(view.getByLabelText('Tablet host or IP address'), {
      target: { value: '10.0.0.26' },
    })
    expect(view.container.textContent)
      .toContain('Press Save below first: this step is stored against the saved host.')
    expect((view.getByRole('button', { name: 'Detect fingerprint' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('reports only persisted edits as dirty and disables stored-config actions while dirty', async () => {
    const { onDirtyChange, view } = await mount()
    const password = view.getByLabelText('Tablet password') as HTMLInputElement
    fireEvent.change(password, { target: { value: 'draft-only' } })

    expect(onDirtyChange).not.toHaveBeenCalled()

    const host = view.getByLabelText('Tablet host or IP address') as HTMLInputElement
    fireEvent.change(host, { target: { value: '10.0.0.26' } })

    expect(onDirtyChange.mock.calls).toEqual([[true]])
    expect((view.getByLabelText('Pinned SSH fingerprint') as HTMLInputElement).value).toBe('')
    expect((view.getByRole('button', { name: 'Detect fingerprint' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect((view.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect((view.getByRole('button', { name: 'Set or replace password' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })

  /**
   * Pinning is still two deliberate acts - detect, then use - but the second one writes. Leaving the
   * pinned value in the buffer for the bottom Save put the finishing act in another part of the card,
   * where a fingerprint that looked pinned could sit unsaved.
   */
  it('pins a detected fingerprint only when it is explicitly used, and saves it then', async () => {
    const { onDirtyChange, stub, view } = await mount()

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Detect fingerprint' }))
    })

    const use = await view.findByRole('button', { name: 'Use and save this fingerprint' })
    expect(view.container.textContent).toContain(candidateConst)
    expect((view.getByLabelText('Pinned SSH fingerprint') as HTMLInputElement).value)
      .toBe(fingerprintConst)
    expect(stub.saved).toEqual([])
    expect(onDirtyChange).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(use)
    })

    expect((view.getByLabelText('Pinned SSH fingerprint') as HTMLInputElement).value)
      .toBe(candidateConst)
    expect(stub.saved).toEqual([{
      host: '10.0.0.25',
      fingerprint: candidateConst,
      timeoutMilliseconds: 180_000,
    }])
    expect(onDirtyChange).not.toHaveBeenCalled()
  })

  it('sets and clears password immediately without changing dirty state', async () => {
    const stub = new BridgeStub()
    stub.snapshot = { ...stub.snapshot, passwordConfigured: false }
    const { onDirtyChange, view } = await mount(stub)
    const password = view.getByLabelText('Tablet password') as HTMLInputElement
    fireEvent.change(password, { target: { value: 'private-value' } })

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Set or replace password' }))
    })

    expect(stub.passwords).toEqual(['private-value'])
    expect(password.value).toBe('')
    expect(view.container.textContent).toContain('Configured for 10.0.0.25.')
    expect(onDirtyChange).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Clear password' }))
    })
    expect(view.container.textContent).toContain('Write-only: it never appears in config.json.')
    expect(onDirtyChange).not.toHaveBeenCalled()
  })

  it('draws every dependency status and the correct install or repair action', async () => {
    const cases: Array<{
      status: RemarkableDependencyStatus
      text: string
      button: string | null
    }> = [
      { status: readyConst, text: 'Ready. Node 22.23.2', button: 'Reinstall' },
      { status: { kind: 'missing', detail: 'not installed' }, text: 'not installed', button: 'Install dependencies' },
      { status: { kind: 'outdated', detail: 'old bundle' }, text: 'old bundle', button: 'Repair dependencies' },
      { status: { kind: 'damaged', detail: 'hash mismatch' }, text: 'hash mismatch', button: 'Repair dependencies' },
      { status: { kind: 'source-missing', detail: 'resource absent' }, text: 'Install source missing', button: null },
      { status: { kind: 'unsupported-platform', detail: 'linux arm64' }, text: 'Unsupported platform', button: null },
    ]

    for (const entry of cases) {
      const stub = new BridgeStub()
      stub.dependencyStatus = entry.status
      const { view } = await mount(stub)
      expect(view.container.textContent).toContain(entry.text)
      if (entry.button === null)
        expect(view.queryByRole('button', { name: /dependencies/ })).toBeNull()
      else
        expect(view.getByRole('button', { name: entry.button })).toBeTruthy()
      view.unmount()
    }
  })

  it('shows install failure separately and keeps an unsaved config buffer', async () => {
    const stub = new BridgeStub()
    stub.dependencyStatus = { kind: 'missing', detail: 'not installed' }
    stub.installResult = {
      ok: false,
      code: 'install-failed',
      detail: 'copy refused',
      retryable: false,
    }
    const { onDirtyChange, view } = await mount(stub)
    const timeout = view.getByLabelText('Connection timeout') as HTMLInputElement
    fireEvent.change(timeout, { target: { value: '90000' } })

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Install dependencies' }))
    })

    expect(view.getByRole('alert').textContent)
      .toContain('The dependencies could not be installed. copy refused')
    expect((view.getByLabelText('Connection timeout') as HTMLInputElement).value).toBe('90000')
    expect(onDirtyChange.mock.calls).toEqual([[true]])
  })

  it('clears a refused password draft and shows secure-storage failure without the secret', async () => {
    const stub = new BridgeStub()
    stub.snapshot = { ...stub.snapshot, passwordConfigured: false }
    stub.setResult = {
      ok: false,
      code: 'credential-unavailable',
      detail: 'encryption unavailable',
      retryable: false,
    }
    const { onDirtyChange, view } = await mount(stub)
    const password = view.getByLabelText('Tablet password') as HTMLInputElement
    fireEvent.change(password, { target: { value: 'must-not-remain' } })

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Set or replace password' }))
    })

    expect(password.value).toBe('')
    expect(view.getByRole('alert').textContent)
      .toContain('Secure password storage is unavailable. encryption unavailable')
    expect(view.container.textContent).not.toContain('must-not-remain')
    expect(onDirtyChange).not.toHaveBeenCalled()
  })

  it('shows damaged sidecar and failed connection as separate visible states', async () => {
    const damagedStub = new BridgeStub()
    damagedStub.dependencyStatus = { kind: 'damaged', detail: 'native module hash mismatch' }
    const damaged = await mount(damagedStub)
    expect(damaged.view.container.textContent).toContain('native module hash mismatch')
    expect(damaged.view.getByRole('button', { name: 'Repair dependencies' })).toBeTruthy()
    damaged.view.unmount()

    const testStub = new BridgeStub()
    testStub.testResult = {
      ok: false,
      code: 'device-sleeping',
      detail: 'tablet did not wake',
      retryable: true,
    }
    const tested = await mount(testStub)
    await act(async () => {
      fireEvent.click(tested.view.getByRole('button', { name: 'Test connection' }))
    })
    expect(tested.view.getByRole('alert').textContent)
      .toContain('Wake the tablet and keep it awake. tablet did not wake')
    expect((tested.view.getByLabelText('Tablet host or IP address') as HTMLInputElement).value)
      .toBe('10.0.0.25')
  })

  it('reopens with immediate actions kept while an unsaved host edit is discarded', async () => {
    const stub = new BridgeStub()
    stub.snapshot = { ...stub.snapshot, passwordConfigured: false }
    stub.dependencyStatus = { kind: 'missing', detail: 'not installed' }
    const first = await mount(stub)

    await act(async () => {
      fireEvent.click(first.view.getByRole('button', { name: 'Install dependencies' }))
    })
    const password = first.view.getByLabelText('Tablet password') as HTMLInputElement
    fireEvent.change(password, { target: { value: 'new-password' } })
    await act(async () => {
      fireEvent.click(first.view.getByRole('button', { name: 'Set or replace password' }))
    })
    fireEvent.change(first.view.getByLabelText('Tablet host or IP address'), {
      target: { value: '10.0.0.99' },
    })
    first.view.unmount()

    const reopened = await mount(stub)
    expect((reopened.view.getByLabelText('Tablet host or IP address') as HTMLInputElement).value)
      .toBe('10.0.0.25')
    expect(reopened.view.container.textContent).toContain('Configured for 10.0.0.25.')
    expect(reopened.view.container.textContent).toContain('Ready. Node 22.23.2')
  })

  it('saves only the settings buffer and reports itself clean when the write lands', async () => {
    const stub = new BridgeStub()
    stub.snapshot = {
      ...stub.snapshot,
      value: {
        ...stub.snapshot.value,
        futureSetting: 'kept',
      } as unknown as RemarkableSettingsValue,
    }
    const { onDirtyChange, view } = await mount(stub)
    fireEvent.change(view.getByLabelText('Connection timeout'), { target: { value: '120000' } })

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Save' }))
    })

    expect(stub.saved).toEqual([{
      host: '10.0.0.25',
      fingerprint: fingerprintConst,
      timeoutMilliseconds: 120_000,
      futureSetting: 'kept',
    }])
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })
})
