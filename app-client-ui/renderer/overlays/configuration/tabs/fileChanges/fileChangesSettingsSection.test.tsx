import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { FileChangesSettingsSection } from './fileChangesSettingsSection'

describe('app-client-ui/renderer/overlays/configuration/tabs/fileChanges/fileChangesSettingsSection', () => {
  type BridgeStub = {
    fileChanges: Pick<AppClientUiBridge['fileChanges'], 'getSettings' | 'saveSettings'>
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount() {
    const saved: unknown[] = []
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      fileChanges: {
        getSettings: () => Promise.resolve({ ok: true, value: { primaryVcs: 'svn' } }),
        saveSettings: (value) => {
          saved.push(value)
          return Promise.resolve({ ok: true, value: { ok: true } })
        },
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<FileChangesSettingsSection onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    return { onDirtyChange, saved, view }
  }

  it('loads the stored VCS and saves an explicit replacement', async () => {
    const { onDirtyChange, saved, view } = await mount()
    const select = view.container.querySelector('select')!
    expect(select.value).toBe('svn')

    fireEvent.change(select, { target: { value: 'git' } })
    expect(onDirtyChange).toHaveBeenCalledWith(true)
    await act(async () => { fireEvent.click(view.getByText('Save')) })

    expect(saved).toEqual([{ primaryVcs: 'git' }])
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })

  it('resets SVN to the Git default without saving immediately', async () => {
    const { saved, view } = await mount()
    const select = view.container.querySelector('select')!
    fireEvent.click(view.getByText('Reset to default'))
    expect(select.value).toBe('git')
    expect(saved).toEqual([])
  })
})
