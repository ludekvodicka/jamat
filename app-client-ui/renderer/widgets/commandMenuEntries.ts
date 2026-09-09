import type {
  SessionColorName,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { CommandDescriptor, CommandId } from '../../shared/commands'
import type { ContextMenuAction, ContextMenuEntry, ContextMenuItem } from './contextMenu'
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
   * with it.
   */
  static of(
    descriptors: readonly CommandDescriptor[],
    currentColor: SessionColorName | null,
    actions: CommandMenuActions,
  ): readonly ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = []
    let previousGroup: number | null = null
    for (const descriptor of descriptors) {
      const group = descriptor.contextMenuGroup ?? 0
      if (previousGroup !== null && group !== previousGroup)
        entries.push({ kind: 'separator', key: `separator:${group}` })
      previousGroup = group
      entries.push(CommandMenuEntries.itemOf(descriptor, currentColor, actions))
    }
    return entries
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
    return {
      key: descriptor.id,
      label: descriptor.title,
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
