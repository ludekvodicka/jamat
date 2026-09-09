import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AppCommands,
  type CommandId,
  type LauncherKeyPreference,
} from '../../shared/commands'
import { AppMenu } from './appMenu'

const { menuMock } = vi.hoisted(() => ({ menuMock: { installs: 0 } }))

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
    setApplicationMenu: () => { menuMock.installs += 1 },
  },
}))

describe('app-client-ui/app/shell/appMenu', () => {
  interface Dispatched {
    main: CommandId[]
    renderer: CommandId[]
  }

  function build(launcherKeys: LauncherKeyPreference = 'session-first'): {
    menu: AppMenu
    template: MenuItemConstructorOptions[]
    dispatched: Dispatched
    focused: string[]
  } {
    const dispatched: Dispatched = { main: [], renderer: [] }
    const focused: string[] = []
    const menu = new AppMenu(
      (id) => dispatched.main.push(id),
      (id) => dispatched.renderer.push(id),
      (windowId) => focused.push(windowId),
      () => launcherKeys,
    )
    return { menu, template: menu.buildTemplate(), dispatched, focused }
  }

  function submenuOf(
    template: MenuItemConstructorOptions[],
    label: string,
  ): MenuItemConstructorOptions[] {
    const section = template.find((item) => item.label === label)
    if (!section || !Array.isArray(section.submenu))
      throw new Error(`No submenu for section ${label}`)
    return section.submenu
  }

  /** Label for a command item, 'separator' for a divider: what a person sees, in order. */
  function readOut(items: MenuItemConstructorOptions[]): (string | undefined)[] {
    return items.map((item) => (item.type === 'separator' ? 'separator' : item.label))
  }

  function commandItemsOf(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    return template
      .flatMap((section) => (Array.isArray(section.submenu) ? section.submenu : []))
      .filter((item) => item.type !== 'separator')
  }

  function click(item: MenuItemConstructorOptions): void {
    const handler = item.click as (() => void) | undefined
    if (!handler)
      throw new Error(`Item ${String(item.label)} has no click`)
    handler()
  }

  beforeEach(() => {
    menuMock.installs = 0
  })

  it('lays the sections out as File, Tab, View, Tools, Window, Debug', () => {
    const { template } = build()
    expect(template.map((section) => section.label))
      .toEqual(['File', 'Tab', 'View', 'Tools', 'Window', 'Debug'])
  })

  it('separates the groups of a section and nothing else', () => {
    const { template } = build()
    expect(readOut(submenuOf(template, 'Tab'))).toEqual([
      'New Tab',
      'Session properties…',
      'Close Tab',
      'separator',
      'Split Right',
      'Split Down',
      'Move to New Window',
      'separator',
      // The chord group: a key each, none of them registered - see the accelerator test below.
      'Move Right',
      'Move Left',
      'Move Up',
      'Move Down',
      'separator',
      'Reset Layout',
    ])
    expect(readOut(submenuOf(template, 'View'))).toEqual([
      'Toggle Left Sidebar',
      'Toggle Right Sidebar',
      'Toggle File Tools',
      'File Changes',
      'Maximize Group',
      'separator',
      'Toggle DevTools',
    ])
    expect(readOut(submenuOf(template, 'File')))
      .toEqual(['New Session', 'New Remote Session', 'Settings', 'separator', 'Quit'])
    expect(readOut(submenuOf(template, 'Tools')))
      .toEqual(['Remarkable', 'separator', 'Check for Updates…'])
    expect(readOut(submenuOf(template, 'Window'))).toEqual(['New Window', 'Window Settings'])
    expect(readOut(submenuOf(template, 'Debug')))
      .toEqual(['Debug Window', 'New Lifecycle Probe', 'Reload', 'separator', 'Restart App'])
  })

  it('holds exactly the catalog commands that declare the menu surface', () => {
    const { template } = build()
    const labels = commandItemsOf(template).map((item) => item.label)
    const titles = AppCommands.forSurface('menu').map((descriptor) => descriptor.title)
    expect([...labels].sort()).toEqual([...titles].sort())
  })

  it('gives a role item its role and no click of its own', () => {
    const { template } = build()
    const roleItems = commandItemsOf(template).filter((item) => item.role)
    expect(roleItems.map((item) => [item.label, item.role]))
      .toEqual([['Quit', 'quit'], ['Toggle DevTools', 'toggleDevTools']])
    for (const item of roleItems)
      expect(item.click, String(item.label)).toBeUndefined()
  })

  it('leaves Reload without an accelerator and without a role', () => {
    const { template } = build()
    const reload = submenuOf(template, 'Debug').find((item) => item.label === 'Reload')
    expect(reload?.accelerator).toBeUndefined()
    expect(reload?.role).toBeUndefined()
  })

  it('keeps Remarkable as a click-only renderer command', () => {
    const { template, dispatched } = build()
    const remarkable = submenuOf(template, 'Tools').find((item) => item.label === 'Remarkable')
    expect(remarkable?.accelerator).toBeUndefined()
    expect(remarkable?.role).toBeUndefined()

    if (!remarkable)
      throw new Error('The Tools menu has no Remarkable command')
    click(remarkable)
    expect(dispatched).toEqual({ main: [], renderer: ['tools.remarkable'] })
  })

  it('carries the accelerator of every command that declares one', () => {
    const { template } = build()
    const accelerators = commandItemsOf(template)
      .filter((item) => item.accelerator)
      .map((item) => [item.label, item.accelerator])
    expect(accelerators).toEqual([
      ['New Session', 'Ctrl+T'],
      ['New Remote Session', 'Ctrl+N'],
      ['Settings', 'Ctrl+,'],
      ['New Tab', 'Ctrl+Shift+T'],
      // The item is what registers the key: nothing else in this client can, which is the whole
      // reason a dialog reached from two context menus declares a native menu entry as well.
      ['Session properties…', 'F2'],
      ['Close Tab', 'Ctrl+W'],
      ['Split Right', 'Ctrl+Shift+Right'],
      ['Split Down', 'Ctrl+Shift+Down'],
      // Printed, never registered: Electron holds no chord, so the window's own listener delivers
      // these four and the item is only where a person reads what the keys are.
      ['Move Right', 'Alt+T Alt+N'],
      ['Move Left', 'Alt+T Alt+P'],
      ['Move Up', 'Alt+T Alt+U'],
      ['Move Down', 'Alt+T Alt+D'],
      ['Toggle Left Sidebar', 'Ctrl+B'],
      ['Toggle Right Sidebar', 'Ctrl+Alt+B'],
      ['Toggle File Tools', 'Ctrl+G'],
      ['File Changes', 'Ctrl+H'],
      ['Maximize Group', 'F11'],
      ['New Window', 'Ctrl+Shift+N'],
      ['Debug Window', 'Ctrl+Shift+D'],
    ])
  })

  /*
   * The preference reaches exactly two items and swaps their keys between them. Everything else is
   * checked here too, by the same list: the set of keys the menu registers is identical under both
   * values, which is what lets the reserved-key rule and the terminal's gate read the catalog alone.
   */
  it('swaps the two launcher keys when the preference says tab first, and moves nothing else', () => {
    const sessionFirst = commandItemsOf(build('session-first').template)
      .filter((item) => item.accelerator)
      .map((item) => [item.label, item.accelerator])
    const tabFirst = commandItemsOf(build('tab-first').template)
      .filter((item) => item.accelerator)
      .map((item) => [item.label, item.accelerator])

    expect(tabFirst.filter(([label]) => label === 'New Session' || label === 'New Tab'))
      .toEqual([['New Session', 'Ctrl+Shift+T'], ['New Tab', 'Ctrl+T']])
    expect(tabFirst.filter(([label]) => label !== 'New Session' && label !== 'New Tab'))
      .toEqual(sessionFirst.filter(([label]) => label !== 'New Session' && label !== 'New Tab'))
    expect(new Set(tabFirst.map(([, key]) => key)))
      .toEqual(new Set(sessionFirst.map(([, key]) => key)))
  })

  it('sends a renderer command to the renderer and a main command to the main process', () => {
    const { template, dispatched } = build()
    for (const item of commandItemsOf(template))
      if (!item.role)
        click(item)
    expect(dispatched.renderer).toEqual([
      'session.new',
      'session.newRemote',
      'settings.open',
      'tab.new',
      'session.details',
      'tab.close',
      'tab.splitRight',
      'tab.splitDown',
      'tab.moveToNewWindow',
      'tab.moveRight',
      'tab.moveLeft',
      'tab.moveUp',
      'tab.moveDown',
      'tab.resetLayout',
      'view.toggleLeftSidebar',
      'view.toggleRightSidebar',
      'view.toggleTabSidebar',
      'view.fileChanges',
      'view.maximizeToggle',
      'tools.remarkable',
      'window.settings',
      'debug.newProbe',
    ])
    expect(dispatched.main)
      .toEqual(['app.checkForUpdates', 'window.new', 'debug.open', 'app.reload', 'app.restart'])
  })

  /**
   * The one user-facing way into the updater, and the whole of what the menu owes it: an item that
   * dispatches to the main process, where the updater lives. Nothing is checked, downloaded or
   * installed until this is clicked.
   */
  it('carries the update check and clicks it into the main process', () => {
    const { template, dispatched } = build()
    const check = submenuOf(template, 'Tools').find((item) => item.label === 'Check for Updates…')

    if (!check)
      throw new Error('The Tools menu has no update check')
    expect(check.accelerator).toBeUndefined()
    expect(check.role).toBeUndefined()
    click(check)
    expect(dispatched).toEqual({ main: ['app.checkForUpdates'], renderer: [] })
  })

  it('appends named windows alphabetically with window id as the tie-break', () => {
    const { menu, focused } = build()
    menu.updateWindowEntries([
      { windowId: 'z', name: 'Zulu' },
      { windowId: 'b', name: 'alpha' },
      { windowId: 'a', name: 'Alpha' },
      { windowId: 'c', name: 'Alpha' },
    ])
    const windowItems = submenuOf(menu.buildTemplate(), 'Window')

    expect(readOut(windowItems)).toEqual([
      'New Window', 'Window Settings', 'separator', 'Alpha', 'alpha', 'Alpha', 'Zulu',
    ])
    for (const item of windowItems.slice(3))
      click(item)
    expect(focused).toEqual(['a', 'b', 'c', 'z'])
  })

  it('rebuilds only when the normalized named-window projection changes', () => {
    const { menu } = build()

    menu.updateWindowEntries([
      { windowId: 'b', name: 'Beta' },
      { windowId: 'a', name: 'Alpha' },
    ])
    expect(menuMock.installs).toBe(1)

    menu.updateWindowEntries([
      { windowId: 'a', name: 'Alpha' },
      { windowId: 'b', name: 'Beta' },
    ])
    menu.updateWindowEntries([
      { windowId: 'b', name: 'Beta' },
      { windowId: 'a', name: 'Alpha' },
    ])
    expect(menuMock.installs).toBe(1)

    menu.updateWindowEntries([
      { windowId: 'a', name: 'Alpha' },
      { windowId: 'b', name: 'Output' },
    ])
    expect(menuMock.installs).toBe(2)

    menu.updateWindowEntries([])
    expect(menuMock.installs).toBe(3)
  })
})
