import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { VersioningModeSection } from './versioningModeSection'

describe('app-client-ui/renderer/overlays/configuration/tabs/versioning/versioningModeSection', () => {
  type BridgeStub = {
    versioning: Pick<AppClientUiBridge['versioning'], 'getSettings' | 'saveSettings'>
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(answer: { ok: boolean; detail?: string } = { ok: true }) {
    const saved: unknown[] = []
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      versioning: {
        getSettings: () => Promise.resolve({ ok: true, value: { mode: 'git' } }),
        saveSettings: (value) => {
          saved.push(value)
          return Promise.resolve(answer.ok
            ? { ok: true as const, value: { ok: true as const } }
            : {
              ok: true as const,
              value: {
                ok: false as const,
                code: 'config-latched' as const,
                detail: answer.detail ?? 'latched',
              },
            })
        },
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<VersioningModeSection onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    return { onDirtyChange, saved, view }
  }

  it('loads the stored mode and saves an explicit replacement', async () => {
    const { onDirtyChange, saved, view } = await mount()
    const select = view.container.querySelector('select')!
    expect(select.value).toBe('git')

    fireEvent.change(select, { target: { value: 'checkpoints' } })
    expect(onDirtyChange).toHaveBeenCalledWith(true)
    await act(async () => { fireEvent.click(view.getByText('Save')) })

    expect(saved).toEqual([{ mode: 'checkpoints' }])
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })

  /** The description is the whole point of the row: it has to follow the choice, not the stored value. */
  it('describes the mode that is selected rather than the one that was loaded', async () => {
    const { view } = await mount()
    expect(view.container.textContent).toContain('without our shared instructions')

    fireEvent.change(view.container.querySelector('select')!, { target: { value: 'checkpoints' } })

    expect(view.container.textContent).toContain('.checkpoints/store.git')
    expect(view.container.textContent).toContain('no version control at all')
  })

  it('resets git to the checkpoints default without saving immediately', async () => {
    const { saved, view } = await mount()
    fireEvent.click(view.getByText('Reset to default'))
    expect(view.container.querySelector('select')!.value).toBe('checkpoints')
    expect(saved).toEqual([])
  })

  /** A refused save keeps the edit on screen and says why, rather than silently reverting. */
  it('shows a refusal and keeps the edited value', async () => {
    const { view } = await mount({ ok: false, detail: 'config.json is latched' })
    fireEvent.change(view.container.querySelector('select')!, { target: { value: 'checkpoints' } })

    await act(async () => { fireEvent.click(view.getByText('Save')) })

    expect(view.getByRole('alert').textContent).toContain('config.json is latched')
    expect(view.container.querySelector('select')!.value).toBe('checkpoints')
  })

  it('ignores a failed save after the section was retired', async () => {
    let finish = (): void => undefined
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      versioning: {
        getSettings: async () => ({ ok: true, value: { mode: 'git' } }),
        saveSettings: () => new Promise((resolve) => {
          finish = () => resolve({
            ok: true,
            value: { ok: false, code: 'config-latched', detail: 'late refusal' },
          })
        }),
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<VersioningModeSection onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    fireEvent.change(view.container.querySelector('select')!, { target: { value: 'checkpoints' } })
    fireEvent.click(view.getByText('Save'))
    view.unmount()

    await act(async () => finish())

    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })
})
