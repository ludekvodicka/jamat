import { CatalogEntries } from '../../../shared/catalogEntries'
import type { ConfigurationTabDescriptor, ConfigurationTabId } from './configurationTab.types'
import { AgentSettingsTab } from './tabs/agents/agentSettingsTab'
import { KeyboardSettingsTab } from './tabs/keyboard/keyboardSettingsTab'
import { ProjectsSettingsTab } from './tabs/projects/projectsSettingsTab'
import { RemarkableSettingsTab } from './tabs/remarkable/remarkableSettingsTab'
import { RemarkableStorageSettingsTab } from './tabs/remarkableStorage/remarkableStorageSettingsTab'
import { RemoteControlConnectTab } from './tabs/remoteControl/remoteControlConnectTab'
import { RemoteControlConnectionsTab } from './tabs/remoteControl/remoteControlConnectionsTab'
import { RemoteControlThisComputerTab } from './tabs/remoteControl/remoteControlThisComputerTab'
import { UiSettingsTab } from './tabs/ui/uiSettingsTab'
import { VersioningSettingsTab } from './tabs/versioning/versioningSettingsTab'
import { WindowSettingsTab } from './tabs/window/windowSettingsTab'
import { WorktreesSettingsTab } from './tabs/worktrees/worktreesSettingsTab'

/**
 * The one source of settings groups, read the way `AppCommands` reads its commands: whoever owns a
 * setting contributes a descriptor here and touches nothing else in the window.
 *
 * The set is known at compile time, so there is no registration at run time: a registry would add an
 * ordering problem between whoever registers and whoever draws, and buy nothing a literal cannot do.
 *
 * The tree is two levels, the same shape as the Debug window's, because that is what one subsystem
 * with several screens is. A third level is a change to this file and to the walk below, not to the
 * frame.
 */
export class ConfigurationTabs {
  private static readonly catalogConst: readonly ConfigurationTabDescriptor[] = [
    { id: 'projects', title: 'Projects', order: 0, Component: ProjectsSettingsTab },
    { id: 'ui', title: 'UI', order: 1, Component: UiSettingsTab },
    { id: 'keyboard', title: 'Keyboard', order: 2, Component: KeyboardSettingsTab },
    { id: 'agents', title: 'AI agents', order: 3, Component: AgentSettingsTab },
    { id: 'versioning', title: 'Versioning', order: 4, Component: VersioningSettingsTab },
    { id: 'worktrees', title: 'Worktrees', order: 5, Component: WorktreesSettingsTab },
    {
      id: 'remarkable',
      title: 'reMarkable',
      order: 6,
      children: [
        {
          id: 'remarkableConnection',
          title: 'Connection',
          order: 0,
          Component: RemarkableSettingsTab,
        },
        {
          id: 'remarkableStorage',
          title: 'Storage',
          order: 1,
          Component: RemarkableStorageSettingsTab,
        },
      ],
    },
    /*
     * Titled for what a person is looking for, while every id under it keeps the name of the
     * subsystem that owns the file these screens write - which is also the directory they live in
     * and the `remoteControl` section of config.json. One vocabulary for the tree, one for the
     * code, and the group id is where the two meet.
     */
    {
      id: 'remoteControl',
      title: 'Network',
      order: 7,
      children: [
        {
          id: 'remoteControlThisComputer',
          title: 'This computer',
          order: 0,
          Component: RemoteControlThisComputerTab,
        },
        {
          id: 'remoteControlConnect',
          title: 'Connect computer',
          order: 1,
          Component: RemoteControlConnectTab,
        },
        {
          id: 'remoteControlConnections',
          title: 'Remote connections',
          order: 2,
          Component: RemoteControlConnectionsTab,
        },
      ],
    },
    { id: 'window', title: 'Window', order: 8, Component: WindowSettingsTab },
  ]

  /**
   * The tree the window draws, every level in `order`. The parameter defaults to the catalog and
   * exists so the refusals below are checkable against a list that is allowed to be wrong; nothing
   * in the app passes it.
   *
   * An id must be unique across the WHOLE tree, because that is what the selection and the dirty set
   * carry; an order only among siblings, because that is all it decides. A group with no children is
   * refused too: it would draw a row that selects nothing.
   */
  static ordered(
    tabs: readonly ConfigurationTabDescriptor[] = ConfigurationTabs.catalogConst,
  ): readonly ConfigurationTabDescriptor[] {
    CatalogEntries.assertUnique(
      'configuration tabs',
      'id',
      ConfigurationTabs.flatten(tabs).map((node) => node.id),
    )
    return ConfigurationTabs.sortLevel(tabs)
  }

  /** Every node of the tree, parents before their own children, in the order they are drawn. */
  static flatten(
    tabs: readonly ConfigurationTabDescriptor[] = ConfigurationTabs.ordered(),
  ): readonly ConfigurationTabDescriptor[] {
    const flat: ConfigurationTabDescriptor[] = []
    for (const node of tabs) {
      flat.push(node)
      flat.push(...ConfigurationTabs.flatten(node.children ?? []))
    }
    return flat
  }

  /** The nodes that draw something. The dirty set, the selection and the pane all speak in these. */
  static screens(
    tabs: readonly ConfigurationTabDescriptor[] = ConfigurationTabs.ordered(),
  ): readonly Extract<ConfigurationTabDescriptor, { Component: unknown }>[] {
    return ConfigurationTabs.flatten(tabs)
      .filter((node): node is Extract<ConfigurationTabDescriptor, { Component: unknown }> =>
        node.Component !== undefined)
  }

  /**
   * The screen a selection names. A group resolves to its first screen, so a caller that knows only
   * "the reMarkable settings" need not know the tree has two of them.
   */
  static screenOf(
    id: ConfigurationTabId,
    tabs: readonly ConfigurationTabDescriptor[] = ConfigurationTabs.ordered(),
  ): Extract<ConfigurationTabDescriptor, { Component: unknown }> | null {
    for (const node of tabs) {
      if (node.Component !== undefined) {
        if (node.id === id) return node
        continue
      }
      if (node.id === id) return ConfigurationTabs.screenOf(node.children[0]?.id ?? id, node.children)
      const found = ConfigurationTabs.screenOf(id, node.children)
      if (found !== null) return found
    }
    return null
  }

  private static sortLevel(
    tabs: readonly ConfigurationTabDescriptor[],
  ): readonly ConfigurationTabDescriptor[] {
    CatalogEntries.assertUnique(
      'configuration tabs',
      'order',
      tabs.map((node) => node.order),
    )
    return [...tabs]
      .sort((left, right) => left.order - right.order)
      .map((node) => {
        if (node.Component !== undefined) return node
        if (node.children.length === 0)
          throw new Error(`The configuration group ${JSON.stringify(node.id)} holds no screen`)
        return { ...node, children: ConfigurationTabs.sortLevel(node.children) }
      })
  }
}
