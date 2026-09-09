import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { WindowInfo } from '../../shared/windowInfo'
import { WindowInfoStore } from './windowInfoStore'

describe('app-client-ui/renderer/shell/windowInfoStore', () => {
  function install(info: WindowInfo): { push(next: WindowInfo): Promise<void> } {
    let current = info
    let changed: (() => void) | null = null
    const bridge = {
      windows: {
        info: () => Promise.resolve({ ok: true as const, value: current }),
      },
      onWindowChanged: (callback: () => void) => {
        changed = callback
        return () => { changed = null }
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
    return {
      push: async (next) => {
        current = next
        changed?.()
        await vi.waitFor(() => expect(WindowInfoStore.current()).toEqual(next))
      },
    }
  }

  afterEach(() => {
    WindowInfoStore.reset()
    document.documentElement.style.removeProperty('--window-color')
    document.title = ''
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('loads and exposes the identity of this renderer', async () => {
    const color = 'currentColor'
    const info = { windowId: 'holder-1', role: 'holder', name: 'Review', color } as const
    install(info)

    expect(await WindowInfoStore.start()).toEqual(info)
    expect(WindowInfoStore.current()).toEqual(info)
  })

  it('applies the window color and title before rendering', async () => {
    const color = 'currentColor'
    install({ windowId: 'holder-1', role: 'holder', name: 'Review', color })

    await WindowInfoStore.start()

    expect(document.documentElement.style.getPropertyValue('--window-color')).toBe(color)
    expect(document.title).toBe('Jamat V3 - Review')
  })

  it('removes a previous color and uses the application title for an unnamed window', async () => {
    document.documentElement.style.setProperty('--window-color', 'currentColor')
    install({ windowId: 'main', role: 'main', name: null, color: null })

    await WindowInfoStore.start()

    expect(document.documentElement.style.getPropertyValue('--window-color')).toBe('')
    expect(document.title).toBe('Jamat V3')
  })

  it('notifies current subscribers and leaves unsubscribed ones alone', async () => {
    const called = vi.fn()
    const unsubscribe = WindowInfoStore.subscribe(called)
    install({ windowId: 'main', role: 'main', name: null, color: null })
    await WindowInfoStore.start()
    unsubscribe()
    install({ windowId: 'holder-1', role: 'holder', name: null, color: null })
    await WindowInfoStore.start()

    expect(called).toHaveBeenCalledTimes(1)
  })

  it('reads a pushed change, updates the document and notifies subscribers', async () => {
    const context = install({ windowId: 'main', role: 'main', name: null, color: null })
    await WindowInfoStore.start()
    const called = vi.fn()
    WindowInfoStore.subscribe(called)

    await context.push({ windowId: 'main', role: 'main', name: 'Review', color: 'currentColor' })

    expect(document.title).toBe('Jamat V3 - Review')
    expect(document.documentElement.style.getPropertyValue('--window-color')).toBe('currentColor')
    expect(called).toHaveBeenCalledOnce()
  })

  it('refuses to choose a role when the main process cannot identify the renderer', async () => {
    const bridge = {
      windows: {
        info: () => Promise.resolve({ ok: false as const, error: 'unknown renderer' }),
      },
      onWindowChanged: () => () => undefined,
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge

    await expect(WindowInfoStore.start()).rejects.toThrow(/unknown renderer/)
  })
})
