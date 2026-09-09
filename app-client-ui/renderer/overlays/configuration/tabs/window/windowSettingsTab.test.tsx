import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import type { WindowAppearance, WindowInfo } from '../../../../../shared/windowInfo'
import { WindowInfoStore } from '../../../../shell/windowInfoStore'
import { WindowSettingsTab } from './windowSettingsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/window/windowSettingsTab', () => {
  class BridgeStub {
    readonly saved: WindowAppearance[] = []
    info: WindowInfo = {
      windowId: 'holder-1',
      role: 'holder',
      name: 'Review',
      color: BridgeStub.color(1),
    }
    private changed: (() => void) | null = null

    install(): void {
      const bridge: Pick<AppClientUiBridge, 'windows' | 'onWindowChanged'> = {
        windows: {
          info: () => Promise.resolve({ ok: true, value: this.info }),
          saveAppearance: (appearance) => {
            this.saved.push(appearance)
            this.info = { ...this.info, ...appearance }
            this.changed?.()
            return Promise.resolve({ ok: true, value: this.info })
          },
        },
        onWindowChanged: (callback) => {
          this.changed = callback
          return () => { this.changed = null }
        },
      }
      ;(window as unknown as { appClient: typeof bridge }).appClient = bridge
    }

    async push(appearance: WindowAppearance): Promise<void> {
      this.info = { ...this.info, ...appearance }
      this.changed?.()
      await waitFor(() => expect(WindowInfoStore.current()).toEqual(this.info))
    }

    static color(index: number): string {
      return `#${index.toString(16).padStart(6, '0')}`
    }
  }

  const paletteTokensConst = [
    'red', 'orange', 'amber', 'green', 'teal', 'cyan',
    'sky', 'blue', 'indigo', 'violet', 'magenta', 'rose',
  ] as const

  async function mount() {
    paletteTokensConst.forEach((token, index) =>
      document.documentElement.style.setProperty(`--window-color-${token}`, BridgeStub.color(index + 1)))
    const bridge = new BridgeStub()
    bridge.install()
    await WindowInfoStore.start()
    const onDirtyChange = vi.fn()
    const view = render(<WindowSettingsTab onDirtyChange={onDirtyChange} />)
    return { bridge, onDirtyChange, view }
  }

  afterEach(() => {
    cleanup()
    WindowInfoStore.reset()
    for (const token of paletteTokensConst)
      document.documentElement.style.removeProperty(`--window-color-${token}`)
    document.documentElement.style.removeProperty('--window-color')
    document.title = ''
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('shows the current appearance and writes the edited name and palette color', async () => {
    const { bridge, onDirtyChange, view } = await mount()
    const name = view.container.querySelector('input')
    if (!(name instanceof HTMLInputElement))
      throw new Error('The Window tab drew no name input')
    const blue = view.getByRole('radio', { name: 'Blue' })

    expect(name.value).toBe('Review')
    expect(view.getByRole('radio', { name: 'Red' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.change(name, { target: { value: 'Output' } })
    fireEvent.click(blue)

    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(view.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.saved).toEqual([
      { name: 'Output', color: BridgeStub.color(8) },
    ]))
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
    expect(document.title).toBe('Jamat V3 - Output')
  })

  it('can clear the name and color', async () => {
    const { bridge, view } = await mount()
    const name = view.container.querySelector('input')
    if (!(name instanceof HTMLInputElement))
      throw new Error('The Window tab drew no name input')

    fireEvent.change(name, { target: { value: '' } })
    fireEvent.click(view.getByRole('radio', { name: 'None' }))
    fireEvent.click(view.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.saved).toEqual([{ name: '', color: null }]))
  })

  it('refreshes its fields when the main process pushes a changed appearance', async () => {
    const { bridge, view } = await mount()

    await bridge.push({ name: 'Logs', color: BridgeStub.color(3) })

    const name = view.container.querySelector('input')
    expect(name).toBeInstanceOf(HTMLInputElement)
    expect((name as HTMLInputElement).value).toBe('Logs')
    expect(view.getByRole('radio', { name: 'Amber' }).getAttribute('aria-checked')).toBe('true')
  })
})
