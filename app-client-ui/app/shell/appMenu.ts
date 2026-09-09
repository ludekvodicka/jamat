import { Menu, type MenuItemConstructorOptions } from 'electron'

import {
  AppCommands,
  type CommandDescriptor,
  type CommandId,
  type CommandMenuSection,
  type LauncherKeyPreference,
} from '../../shared/commands'

export interface WindowMenuEntry {
  windowId: string
  name: string
}

/**
 * The native menu from the static command catalog plus the named-window projection. Focus never
 * rebuilds it; only a changed sorted { windowId, name } projection does, or a saved launcher key
 * preference - the one thing about a key this menu does not read straight off the catalog.
 */
export class AppMenu {
  /**
   * The sections of the bar, in bar order, each with the label it wears. One list, because two of
   * them were a hand-written parallel to a five-member union: a section added to the union and
   * missing from the ORDER dropped every command it held with nothing to catch it, and one missing
   * from the LABELS threw at build time instead. `satisfies Record<CommandMenuSection, string>` is
   * what refuses an incomplete list now, at compile time, and key order is the bar's order.
   */
  private static readonly sectionsConst = {
    file: 'File',
    tab: 'Tab',
    view: 'View',
    tools: 'Tools',
    window: 'Window',
    debug: 'Debug',
  } as const satisfies Record<CommandMenuSection, string>
  private windowEntries: readonly WindowMenuEntry[] = []

  /**
   * `launcherKeysOf` is read at every build rather than held: a save rebuilds the menu, and a value
   * captured once would be the state of the config when this object was made.
   */
  constructor(
    private readonly runMainCommand: (id: CommandId) => void,
    private readonly publishRendererCommand: (id: CommandId) => void,
    private readonly focusOrRecreate: (windowId: string) => void,
    private readonly launcherKeysOf: () => LauncherKeyPreference,
  ) {}

  install(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(this.buildTemplate()))
  }

  updateWindowEntries(entries: readonly WindowMenuEntry[]): void {
    const next = AppMenu.normalizedProjection(entries)
    if (AppMenu.sameProjection(this.windowEntries, next))
      return
    this.windowEntries = next
    this.install()
  }

  /** Pure data, so what the menu bar will be is decidable without an Electron process. */
  buildTemplate(): MenuItemConstructorOptions[] {
    // The cast is what `satisfies` above earns: the literal has exactly the union's keys, and
    // `Object.entries` cannot say so on its own.
    return Object.entries(AppMenu.sectionsConst).map(([section, label]) => ({
      label,
      submenu: this.submenuOf(section as CommandMenuSection),
    }))
  }

  private submenuOf(section: CommandMenuSection): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = []
    let previousGroup: number | null = null
    for (const descriptor of AppCommands.forSurface('menu')) {
      const placement = descriptor.menu
      if (!placement)
        throw new Error(`Menu command without a placement: ${descriptor.id}`)
      if (placement.section !== section)
        continue
      if (previousGroup !== null && placement.group !== previousGroup)
        items.push({ type: 'separator' })
      items.push(this.itemOf(descriptor))
      previousGroup = placement.group
    }
    if (section === 'window')
      items.push(...this.windowTailOf())
    return items
  }

  private windowTailOf(): MenuItemConstructorOptions[] {
    if (this.windowEntries.length === 0)
      return []
    return [
      { type: 'separator' },
      ...this.windowEntries.map((entry) => ({
        label: entry.name,
        click: () => this.focusOrRecreate(entry.windowId),
      })),
    ]
  }

  private itemOf(descriptor: CommandDescriptor): MenuItemConstructorOptions {
    // A role is Electron's own item, keyboard handling included; giving it a click as well would be
    // the second dispatch path the catalog exists to prevent.
    if (descriptor.role)
      return { role: descriptor.role, label: descriptor.title }
    const item: MenuItemConstructorOptions = {
      label: descriptor.title,
      click: this.dispatcherOf(descriptor),
    }
    // The one place a menu item's key is not simply what its descriptor declares: the two launcher
    // commands answer with each other's when the preference says so.
    const accelerator = AppCommands.acceleratorOf(descriptor, this.launcherKeysOf())
    if (accelerator)
      item.accelerator = accelerator
    // A chord goes in the same field because printing a key is all this field can do for one:
    // Electron holds a single combination per item, so it is told not to register what it prints
    // and the window delivers the strokes itself.
    if (descriptor.chord) {
      item.accelerator = descriptor.chord
      item.registerAccelerator = false
    }
    if (descriptor.registerAccelerator === false)
      item.registerAccelerator = false
    return item
  }

  private dispatcherOf(descriptor: CommandDescriptor): () => void {
    if (descriptor.target === 'main')
      return () => this.runMainCommand(descriptor.id)
    else if (descriptor.target === 'renderer')
      return () => this.publishRendererCommand(descriptor.id)
    else
      throw new Error(`Unknown command target: ${JSON.stringify(descriptor)}`)
  }

  private static normalizedProjection(
    entries: readonly WindowMenuEntry[],
  ): readonly WindowMenuEntry[] {
    return entries
      .map((entry) => ({ windowId: entry.windowId, name: entry.name }))
      .sort((left, right) => {
        const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
        return byName !== 0 ? byName : left.windowId.localeCompare(right.windowId)
      })
  }

  private static sameProjection(
    current: readonly WindowMenuEntry[],
    next: readonly WindowMenuEntry[],
  ): boolean {
    return current.length === next.length && current.every((entry, index) =>
      entry.windowId === next[index].windowId && entry.name === next[index].name)
  }
}
