import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CatalogCategoryDto } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import { WindowInfoStore } from '../../shell/windowInfoStore'
import { ConfigurationLastTab } from './configurationLastTab'
import { ConfigurationOverlay } from './configurationOverlay'
import { WorktreeSetupIntentStore } from './worktreeSetupIntentStore'
import type { ConfigurationOpenRequest } from './configurationTab.types'
import { ConfigurationTabs } from './configurationTabs'

describe('app-client-ui/renderer/overlays/configuration/configurationOverlay', () => {
  /**
   * The frame owns no I/O, but the tab it draws does: it reads the catalog the moment it mounts.
   * One root is enough for every question this file asks, all of which are about the frame.
   */
  const categoriesConst: CatalogCategoryDto[] = [
    { id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' },
  ]

  function installBridge(): void {
    const bridge = {
      windows: {
        info: () => Promise.resolve({
          ok: true as const,
          value: { windowId: 'main', role: 'main' as const, name: null, color: null },
        }),
        saveAppearance: () => {
          throw new Error('No test of the frame saves window appearance')
        },
      },
      onWindowChanged: () => () => undefined,
      projects: {
        getConfig: () => Promise.resolve({ ok: true, value: { ok: true, value: categoriesConst } }),
        saveConfig: () => {
          throw new Error('No test of the frame saves anything')
        },
      },
      dialog: {
        pickDirectory: () => {
          throw new Error('No test of the frame picks a directory')
        },
      },
    }
    ;(window as unknown as { appClient: unknown }).appClient = bridge as unknown as
      Pick<AppClientUiBridge, 'projects' | 'dialog'>
  }

  afterEach(() => {
    cleanup()
    ConfigurationLastTab.reset()
    WindowInfoStore.reset()
    for (const token of ConfigurationOverlayTest.paletteTokensConst)
      document.documentElement.style.removeProperty(`--window-color-${token}`)
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(
    request: ConfigurationOpenRequest = { requestId: 1, tab: null },
    /** Which screen to wait for, where the request alone does not say - a remembered one. */
    opensOn: 'projects' | 'window' = request.tab === 'window' ? 'window' : 'projects',
  ) {
    installBridge()
    ConfigurationOverlayTest.installPalette()
    await WindowInfoStore.start()
    const onClose = vi.fn()
    const view = render(
      <ConfigurationOverlay request={request} worktreeSetupIntents={new WorktreeSetupIntentStore()}
        onClose={onClose} />,
    )
    const readySelector = opensOn === 'window'
      ? '.jamat-configuration-window__name'
      : '.jamat-configuration-projects__label'
    await waitFor(() => expect(view.container.querySelector(readySelector)).toBeTruthy())
    return { view, onClose }
  }

  function card(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-configuration__card')
    if (!(found instanceof HTMLElement))
      throw new Error('The overlay drew no card')
    return found
  }

  function buttonNamed(container: HTMLElement, label: string): HTMLElement {
    const found = [...container.querySelectorAll('button')]
      .find((node) => node.textContent === label)
    if (!found)
      throw new Error(`The overlay drew no ${label} button`)
    return found
  }

  /** Renaming a root is the tab's unsaved work, and the only thing the frame learns about it. */
  function editFirstRoot(container: HTMLElement): void {
    const input = container.querySelector('.jamat-configuration-projects__label')
    if (!(input instanceof HTMLInputElement))
      throw new Error('The tab drew no editable root')
    fireEvent.change(input, { target: { value: 'Renamed' } })
  }

  it('takes focus so the keys of the card reach it', async () => {
    const { view } = await mount()

    expect(document.activeElement).toBe(card(view.container))
  })

  it('returns focus to whatever held it before', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()

    const { view } = await mount()
    view.unmount()

    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('draws the groups of the catalog and the chosen one’s screen', async () => {
    const { view } = await mount()

    expect([...view.container.querySelectorAll('[role="treeitem"]')].map((node) => node.textContent))
      .toEqual(ConfigurationTabs.flatten().map((tab) => tab.title))
    expect(view.container.querySelector('.jamat-configuration__pane')?.getAttribute('aria-label'))
      .toBe('Projects')
    expect(view.container.querySelector('.jamat-configuration-projects')).toBeTruthy()
  })

  it('opens directly on the requested Window tab', async () => {
    const { view } = await mount({ requestId: 1, tab: 'window' })

    expect(view.container.querySelector('.jamat-configuration__pane')?.getAttribute('aria-label'))
      .toBe('Window')
    expect(view.container.querySelector('.jamat-configuration-window')).toBeTruthy()
  })

  /*
   * Settings are read in bursts, and the screen you were just on is nearly always the one you want
   * next. It is memory and not a file on purpose: a restart starts at the first screen again.
   */
  it('reopens on the screen it was last left on', async () => {
    const first = await mount()
    fireEvent.click(buttonNamed(first.view.container, 'Window'))
    first.view.unmount()

    const { view } = await mount({ requestId: 2, tab: null }, 'window')

    expect(view.container.querySelector('.jamat-configuration__pane')?.getAttribute('aria-label'))
      .toBe('Window')
  })

  // A named open is somebody saying which screen they mean, so it beats a screen left open earlier.
  it('opens where the request asks even after another screen was left open', async () => {
    ConfigurationLastTab.remember('window')

    const { view } = await mount({ requestId: 1, tab: 'projects' })

    expect(view.container.querySelector('.jamat-configuration__pane')?.getAttribute('aria-label'))
      .toBe('Projects')
  })

  it('routes a new request through the dirty tab leave question', async () => {
    const { view, onClose } = await mount()
    editFirstRoot(view.container)

    view.rerender(
      <ConfigurationOverlay
        request={{ requestId: 2, tab: 'window' }}
        worktreeSetupIntents={new WorktreeSetupIntentStore()}
        onClose={onClose}
      />,
    )

    await waitFor(() => expect(view.container.querySelector('.jamat-configuration__ask')?.textContent)
      .toContain('Projects has unsaved changes'))
    expect(view.container.querySelector('.jamat-configuration__pane')?.getAttribute('aria-label'))
      .toBe('Projects')
  })

  it('closes on Escape, on the backdrop and on the close button', async () => {
    const escape = await mount()
    fireEvent.keyDown(card(escape.view.container), { key: 'Escape' })
    expect(escape.onClose).toHaveBeenCalledOnce()

    cleanup()
    const backdrop = await mount()
    const scrim = backdrop.view.container.querySelector('.jamat-configuration')
    if (!(scrim instanceof HTMLElement))
      throw new Error('The overlay drew no backdrop')
    fireEvent.mouseDown(scrim)
    expect(backdrop.onClose).toHaveBeenCalledOnce()

    cleanup()
    const button = await mount()
    const close = button.view.container.querySelector('.jamat-configuration__close')
    if (!(close instanceof HTMLElement))
      throw new Error('The overlay drew no close button')
    fireEvent.click(close)
    expect(button.onClose).toHaveBeenCalledOnce()
  })

  it('stays open on a press inside the card', async () => {
    const { view, onClose } = await mount()

    fireEvent.mouseDown(card(view.container))

    expect(onClose).not.toHaveBeenCalled()
  })

  // The disabled controls are skipped on purpose: the tab's Save button is disabled until there is
  // something to save, and treating it as the last stop is how Tab used to leave the card.
  it('wraps Tab inside the card, over the controls that can actually hold focus', async () => {
    const { view } = await mount()
    const focusable = [...card(view.container)
      .querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
    expect(view.container.querySelector('button[disabled]')).toBeTruthy()
    focusable[focusable.length - 1].focus()

    fireEvent.keyDown(card(view.container), { key: 'Tab' })

    expect(document.activeElement).toBe(focusable[0])
  })

  it('marks the group whose tab reports unsaved work', async () => {
    const { view } = await mount()

    editFirstRoot(view.container)

    expect(view.container.querySelector('.jamat-configuration__dirty')).toBeTruthy()
  })

  it('asks instead of closing over a tab with unsaved work, and stays when told to', async () => {
    const { view, onClose } = await mount()
    editFirstRoot(view.container)

    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    expect(view.container.querySelector('.jamat-configuration__ask')?.textContent)
      .toContain('Projects has unsaved changes')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(buttonNamed(view.container, 'Stay'))
    expect(view.container.querySelector('.jamat-configuration__ask')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes once the question about leaving is answered', async () => {
    const { view, onClose } = await mount()
    editFirstRoot(view.container)
    fireEvent.keyDown(card(view.container), { key: 'Escape' })

    fireEvent.click(buttonNamed(view.container, 'Leave and discard'))

    expect(onClose).toHaveBeenCalledOnce()
  })
})

class ConfigurationOverlayTest {
  static readonly paletteTokensConst = [
    'red', 'orange', 'amber', 'green', 'teal', 'cyan',
    'sky', 'blue', 'indigo', 'violet', 'magenta', 'rose',
  ] as const

  static installPalette(): void {
    ConfigurationOverlayTest.paletteTokensConst.forEach((token, index) =>
      document.documentElement.style.setProperty(
        `--window-color-${token}`,
        `#${(index + 1).toString(16).padStart(6, '0')}`,
      ))
  }
}
