import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import type { RemarkableStorageSettingsValue } from '../../../../../shared/remarkableStorageSettings'
import { RemarkableStorageSettingsTab } from './remarkableStorageSettingsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/remarkableStorage/remarkableStorageSettingsTab', () => {
  type BridgeStub = {
    remarkable: Pick<AppClientUiBridge['remarkable'], 'getStorage' | 'saveStorage'>
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(stored: RemarkableStorageSettingsValue) {
    const saved: unknown[] = []
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      remarkable: {
        getStorage: () => Promise.resolve({ ok: true, value: stored }),
        saveStorage: (value) => {
          saved.push(value)
          return Promise.resolve({ ok: true, value: { ok: true, value: undefined } })
        },
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<RemarkableStorageSettingsTab onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    return { onDirtyChange, saved, view }
  }

  function directory(): HTMLInputElement {
    return screen.getByLabelText('Folder inside the project') as HTMLInputElement
  }

  it('loads the stored choice and leaves the folder disabled while storage is global', async () => {
    const { view } = await mount({ scope: 'global', projectDirectory: '.remarkable' })

    expect((view.getByLabelText(/On this machine/) as HTMLInputElement).checked).toBe(true)
    expect(directory().value).toBe('.remarkable')
    expect(directory().disabled).toBe(true)
  })

  it('saves the project folder the user typed', async () => {
    const { onDirtyChange, saved, view } = await mount({
      scope: 'global',
      projectDirectory: '.remarkable',
    })

    fireEvent.click(view.getByLabelText(/In the project/))
    fireEvent.change(directory(), { target: { value: '.aidocs/remarkable' } })
    expect(onDirtyChange).toHaveBeenCalledWith(true)
    await act(async () => { fireEvent.click(view.getByText('Save')) })

    expect(saved).toEqual([{ scope: 'project', projectDirectory: '.aidocs/remarkable' }])
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })

  it('explains an unusable folder and holds the save', async () => {
    const { saved, view } = await mount({ scope: 'project', projectDirectory: '.remarkable' })

    fireEvent.change(directory(), { target: { value: '../outside' } })

    expect(directory().getAttribute('aria-invalid')).toBe('true')
    expect(view.getByText(/without \. or \.\. steps/)).toBeTruthy()
    expect((view.getByText('Save') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(view.getByText('Save')) })
    expect(saved).toEqual([])
  })

  it('resets to machine storage and the default folder without saving', async () => {
    const { saved, view } = await mount({ scope: 'project', projectDirectory: 'docs/pages' })

    fireEvent.click(view.getByText('Reset to default'))

    expect((view.getByLabelText(/On this machine/) as HTMLInputElement).checked).toBe(true)
    expect(directory().value).toBe('.remarkable')
    expect(saved).toEqual([])
  })

  it('ignores a failed save after the tab was retired', async () => {
    let finish = (): void => undefined
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      remarkable: {
        getStorage: async () => ({
          ok: true,
          value: { scope: 'global', projectDirectory: '.remarkable' },
        }),
        saveStorage: () => new Promise((resolve) => {
          finish = () => resolve({
            ok: true,
            value: {
              ok: false,
              code: 'invalid-operation',
              detail: 'late refusal',
              retryable: false,
            },
          })
        }),
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<RemarkableStorageSettingsTab onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    fireEvent.click(view.getByLabelText(/In the project/))
    fireEvent.click(view.getByText('Save'))
    view.unmount()

    await act(async () => finish())

    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })
})
