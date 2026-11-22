import { fireEvent } from '@testing-library/react'

/**
 * Reads a menu drawn by `ContextMenu` the way a person meets it: the top level, and a submenu only
 * after its row was entered. Shared by the tab menu's and the sessions tree's menu tests, which draw
 * from one builder.
 */
export class ContextMenuReading {
  private static readonly separatorConst = '---'
  private readonly rootSelector: string
  /** Submenus whose rows are values rather than commands, such as the colours. */
  private readonly skippedSubmenus: readonly string[]

  constructor(rootSelector: string, skippedSubmenus: readonly string[] = []) {
    this.rootSelector = rootSelector
    this.skippedSubmenus = skippedSubmenus
  }

  /** Top-level rows; a submenu's own rows carry the same item class. */
  items(): HTMLElement[] {
    return [...document.querySelectorAll(`${this.rootSelector} > .jamat-context-menu__row > .jamat-context-menu__item`)]
      .filter((item): item is HTMLElement => item instanceof HTMLElement)
  }

  titles(): string[] {
    return this.items().map(ContextMenuReading.labelOf)
  }

  /** The labels of one submenu, `---` for each separator, read after entering its row. */
  childrenOf(title: string): string[] {
    return this.flyoutEntries(title).map((entry) => entry === null ? ContextMenuReading.separatorConst : ContextMenuReading.labelOf(entry))
  }

  /** Every label the menu offers, the rows of each submenu included (except the skipped ones). */
  all(): string[] {
    return this.titles().flatMap((title, index) => this.isSubmenu(this.items()[index]) && !this.skippedSubmenus.includes(title)
      ? [title, ...this.childrenOf(title).filter((label) => label !== ContextMenuReading.separatorConst)]
      : [title])
  }

  /** The top level in order, each submenu as `Title ›` followed by its rows indented by two spaces. */
  outline(): string[] {
    return this.titles().flatMap((title, index) => this.isSubmenu(this.items()[index]) && !this.skippedSubmenus.includes(title)
      ? [`${title} ›`, ...this.childrenOf(title).map((label) => `  ${label}`)]
      : [title])
  }

  /** A row by its label, at the top level or inside a submenu, whose row is then entered. */
  itemTitled(title: string): HTMLElement {
    const top = this.titles().indexOf(title)
    if (top >= 0) return this.items()[top]
    for (const [index, row] of this.items().entries()) {
      const parent = this.titles()[index]
      if (!this.isSubmenu(row) || this.skippedSubmenus.includes(parent)) continue
      const found = this.flyoutEntries(parent).find((entry) => entry !== null && ContextMenuReading.labelOf(entry) === title)
      if (found !== undefined && found !== null) return found
    }
    throw new Error(`The menu shows no item titled ${JSON.stringify(title)}`)
  }

  private flyoutEntries(title: string): (HTMLElement | null)[] {
    const index = this.titles().indexOf(title)
    if (index < 0) throw new Error(`The menu shows no submenu titled ${JSON.stringify(title)}`)
    const row = this.items()[index].parentElement as HTMLElement
    fireEvent.mouseEnter(row)
    const flyout = row.querySelector(':scope > .jamat-context-menu__flyout')
    if (flyout === null) throw new Error(`The submenu ${JSON.stringify(title)} did not open`)
    return [...flyout.children].map((entry) => entry.getAttribute('role') === 'separator' ? null
      : entry.querySelector(':scope > .jamat-context-menu__item') as HTMLElement)
  }

  private isSubmenu(item: HTMLElement): boolean {
    return item.getAttribute('aria-haspopup') === 'menu'
  }

  private static labelOf(item: HTMLElement): string {
    return item.querySelector('.jamat-context-menu__label')?.textContent ?? ''
  }
}
