import type {
  SessionColorName,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppCommands, type CommandDescriptor, type CommandId } from '../../shared/commands'
import type { ContextMenuAction, ContextMenuEntry, ContextMenuItem, ContextMenuSeparator } from './contextMenu'
import { SessionPalette } from '../../shared/sessionPalette'
// The classes this builder emits are styled there, so every menu drawn from it gets the look
// without importing a stylesheet named after another widget.
import './tabs/tabContextMenu.css'

/**
 * What a clicked item runs, supplied by the menu that owns the click: the tab menu executes bare
 * and lets the handler read the active tab, the tree menu names the clicked row's session. The
 * colour swatches get a callback of their own because theirs is the one command that only means
 * something with a value.
 */
export interface CommandMenuActions {
  run(id: CommandId): void
  setColor(color: SessionColorName | null): void
  /** A label that depends on the session the menu is about; absent keeps the catalog title. */
  labelOf?(id: CommandId): string | undefined
}

/**
 * Command descriptors as menu entries, shared by the tab menu and the sessions tree's menu: one
 * builder, so the separator rule and the colour submenu cannot drift between the two. What differs
 * between the menus stays with the caller - which commands apply is filtered before this runs, and
 * the callbacks are how each menu says what its execute carries.
 */
export class CommandMenuEntries {
  /** The one item-class family; named for the tab menu because that menu existed first. */
  private static readonly itemClassConst = 'jamat-tab-menu__item'

  /**
   * The descriptors as menu entries, with a separator wherever the block changes. Drawn from what
   * SURVIVED the caller's filter, so a block whose every item was filtered out takes its separator
   * with it. The commands of one `contextSubmenu` become one parent row at the place of the first,
   * with a separator inside it wherever their own block changes.
   */
  static of(
    descriptors: readonly CommandDescriptor[],
    currentColor: SessionColorName | null,
    actions: CommandMenuActions,
  ): readonly ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = []
    const placed = new Set<string>()
    let previousGroup: number | null = null
    for (const descriptor of descriptors) {
      const submenu = descriptor.contextSubmenu
      if (submenu !== undefined && placed.has(submenu.id)) continue
      const group = descriptor.contextMenuGroup ?? 0
      if (previousGroup !== null && group !== previousGroup)
        entries.push({ kind: 'separator', key: `separator:${group}` })
      previousGroup = group
      if (submenu === undefined) {
        entries.push(CommandMenuEntries.itemOf(descriptor, currentColor, actions))
        continue
      }
      placed.add(submenu.id)
      entries.push({
        key: `submenu:${submenu.id}`,
        label: AppCommands.submenuTitleOf(submenu.id),
        className: CommandMenuEntries.itemClassConst,
        children: CommandMenuEntries.submenuChildren(descriptors.filter((member) => member.contextSubmenu?.id === submenu.id), actions),
      })
    }
    return entries
  }

  private static submenuChildren(
    members: readonly CommandDescriptor[],
    actions: CommandMenuActions,
  ): readonly (ContextMenuAction | ContextMenuSeparator)[] {
    const children: (ContextMenuAction | ContextMenuSeparator)[] = []
    let previousGroup: number | null = null
    for (const member of members) {
      const group = member.contextSubmenu?.group ?? 0
      if (previousGroup !== null && group !== previousGroup)
        children.push({ kind: 'separator', key: `separator:${member.contextSubmenu?.id ?? ''}:${group}` })
      previousGroup = group
      children.push(CommandMenuEntries.actionOf(member, actions))
    }
    return children
  }

  private static itemOf(
    descriptor: CommandDescriptor,
    currentColor: SessionColorName | null,
    actions: CommandMenuActions,
  ): ContextMenuItem {
    if (descriptor.id === 'session.setColor')
      return {
        key: descriptor.id,
        label: descriptor.title,
        className: CommandMenuEntries.itemClassConst,
        // The submenu is this ONE command drawn with its values, not twelve commands: the catalog
        // stays the size of the actions, and the colours stay the argument they are.
        children: CommandMenuEntries.colourChildren(currentColor, actions),
      }
    return CommandMenuEntries.actionOf(descriptor, actions)
  }

  private static actionOf(descriptor: CommandDescriptor, actions: CommandMenuActions): ContextMenuAction {
    return {
      key: descriptor.id,
      label: actions.labelOf?.(descriptor.id) ?? descriptor.title,
      className: CommandMenuEntries.itemClassConst,
      onSelect: () => actions.run(descriptor.id),
    }
  }

  private static colourChildren(
    currentColor: SessionColorName | null,
    actions: CommandMenuActions,
  ): readonly ContextMenuAction[] {
    const choices: readonly (SessionColorName | null)[] = [null, ...SessionPalette.namesConst]
    return choices.map((name) => ({
      key: `color:${name ?? 'none'}`,
      label: SessionPalette.labelOf(name),
      swatchClassName: name === null ? undefined : SessionPalette.swatchClassOf(name),
      className: currentColor === name
        ? `${CommandMenuEntries.itemClassConst} is-current`
        : CommandMenuEntries.itemClassConst,
      onSelect: () => actions.setColor(name),
    }))
  }
}
