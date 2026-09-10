import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { VersioningSettingsTab } from './versioningSettingsTab'

/**
 * The tab is a composition and nothing else: what each section DOES is its own test's business, and
 * what is checked here is that both are on screen and that the one dirty answer the window gets is
 * the two of them together.
 */
describe('app-client-ui/renderer/overlays/configuration/tabs/versioning/versioningSettingsTab', () => {
  type BridgeStub = {
    versioning: Pick<AppClientUiBridge['versioning'], 'getSettings' | 'saveSettings'>
    fileChanges: Pick<AppClientUiBridge['fileChanges'], 'getSettings' | 'saveSettings'>
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount() {
    const saved: unknown[] = []
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      versioning: {
        getSettings: () => Promise.resolve({ ok: true, value: { mode: 'git', diffTool: { kind: 'internal' } } }),
        saveSettings: (value) => {
          saved.push(value)
          return Promise.resolve({ ok: true, value: { ok: true } })
        },
      },
      fileChanges: {
        getSettings: () => Promise.resolve({ ok: true, value: { primaryVcs: 'svn' } }),
        saveSettings: (value) => {
          saved.push(value)
          return Promise.resolve({ ok: true, value: { ok: true } })
        },
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<VersioningSettingsTab onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    return { onDirtyChange, saved, view }
  }

  function selectsOf(container: HTMLElement): HTMLSelectElement[] {
    return [...container.querySelectorAll('select')]
  }

  it('draws both sections, each with its own writer and its own Save', async () => {
    const { view } = await mount()
    const titles = [...view.container.querySelectorAll('.jamat-configuration__section-title')]
      .map((node) => node.textContent)

    expect(titles).toEqual(['AI versioning', 'Commit diff viewer', 'File changes'])
    expect(selectsOf(view.container).map((select) => select.value)).toEqual(['git', 'internal', 'svn'])
    // Two, deliberately: one button reporting two writes would report one outcome for two.
    expect(view.getAllByText('Save')).toHaveLength(3)
  })

  /*
   * The reason the tab holds the flag rather than forwarding whichever section spoke last: saving one
   * of them must not tell the window the tab is clean while the other still holds an edit.
   */
  it('stays dirty while either section holds an unsaved edit', async () => {
    const { onDirtyChange, saved, view } = await mount()
    const [mode, , vcs] = selectsOf(view.container)

    fireEvent.change(mode!, { target: { value: 'checkpoints' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.change(vcs!, { target: { value: 'git' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    // The first section's own Save, which leaves the second one's edit exactly where it was.
    await act(async () => { fireEvent.click(view.getAllByText('Save')[0]!) })
    expect(saved).toEqual([{ mode: 'checkpoints', diffTool: { kind: 'internal' } }])
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    await act(async () => { fireEvent.click(view.getAllByText('Save')[2]!) })
    expect(saved).toEqual([{ mode: 'checkpoints', diffTool: { kind: 'internal' } }, { primaryVcs: 'git' }])
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })
})
