import { describe, expect, it } from 'vitest'

import type {
  ConfigurationOpenRequest,
  ConfigurationTabDescriptor,
  ConfigurationTabId,
} from './configurationTab.types'
import { ConfigurationTabs } from './configurationTabs'

describe('app-client-ui/renderer/overlays/configuration/configurationTabs', () => {
  /** The catalog is data; what a descriptor draws is nothing this file needs to render. */
  function tab(id: string, order: number): ConfigurationTabDescriptor {
    return {
      id: id as ConfigurationTabId,
      title: id,
      order,
      Component: () => {
        throw new Error(`The catalog test drew tab ${id}`)
      },
    }
  }

  it('holds the nine groups, with reMarkable and Network nesting their own screens', () => {
    expect(ConfigurationTabs.ordered().map((descriptor) => [descriptor.id, descriptor.order]))
      .toEqual([
        ['projects', 0],
        ['ui', 1],
        ['keyboard', 2],
        ['agents', 3],
        ['versioning', 4],
        ['worktrees', 5],
        ['remarkable', 6],
        ['remoteControl', 7],
        ['window', 8],
      ])
    expect(ConfigurationTabs.flatten().map((descriptor) => descriptor.id)).toEqual([
      'projects', 'ui', 'keyboard', 'agents', 'versioning', 'worktrees',
      'remarkable', 'remarkableConnection', 'remarkableStorage',
      'remoteControl', 'remoteControlThisComputer', 'remoteControlConnect',
      'remoteControlConnections',
      'window',
    ])
  })

  /**
   * The one group whose title is not its id: a person looks for Network, and the code that writes
   * the file underneath every screen in it is the remote control subsystem.
   */
  it('titles the remoteControl group Network and orders its three screens', () => {
    const network = ConfigurationTabs.ordered().find((node) => node.id === 'remoteControl')

    expect(network?.title).toBe('Network')
    expect(network?.children?.map((child) => [child.id, child.title])).toEqual([
      ['remoteControlThisComputer', 'This computer'],
      ['remoteControlConnect', 'Connect computer'],
      ['remoteControlConnections', 'Remote connections'],
    ])
  })

  /**
   * What the sessions tree's "Open Remote connections settings" and the launcher's own button ask
   * for. Both name the list rather than the group: the group's first screen is This computer, and a
   * person who clicked a row about ANOTHER computer would land on the wrong machine.
   */
  it('lands both remote callers on the connections screen', () => {
    expect(ConfigurationTabs.screenOf('remoteControlConnections')?.title).toBe('Remote connections')
    expect(ConfigurationTabs.screenOf('remoteControl')?.id).toBe('remoteControlThisComputer')
  })

  /**
   * A group draws nothing, so it is not a place the window can sit: what a caller naming one gets
   * is its first screen. Everything that carries a selection - the pane, the dirty set, the leave
   * question - therefore only ever speaks in screens.
   */
  it('answers a group with its first screen and a screen with itself', () => {
    expect(ConfigurationTabs.screens().map((screen) => screen.id)).toEqual([
      'projects', 'ui', 'keyboard', 'agents', 'versioning', 'worktrees',
      'remarkableConnection', 'remarkableStorage',
      'remoteControlThisComputer', 'remoteControlConnect', 'remoteControlConnections',
      'window',
    ])
    expect(ConfigurationTabs.screenOf('remarkable')?.id).toBe('remarkableConnection')
    expect(ConfigurationTabs.screenOf('remarkableStorage')?.id).toBe('remarkableStorage')
    expect(ConfigurationTabs.screenOf('missing' as ConfigurationTabId)).toBeNull()
  })

  it('refuses a group that holds no screen', () => {
    expect(() => ConfigurationTabs.ordered([
      { id: 'remarkable', title: 'reMarkable', order: 0, children: [] },
    ])).toThrow(/holds no screen/)
  })

  it('accepts reMarkable as a direct-open target', () => {
    const request: ConfigurationOpenRequest = { requestId: 7, tab: 'remarkable' }

    expect(request).toEqual({ requestId: 7, tab: 'remarkable' })
  })

  it('returns the tabs in the order they declare, not the order they were written', () => {
    const ordered = ConfigurationTabs.ordered([tab('platforms', 2), tab('projects', 0), tab('keys', 1)])

    expect(ordered.map((descriptor) => descriptor.id)).toEqual(['projects', 'keys', 'platforms'])
  })

  // Two tabs sharing an id leave `activeTab` pointing at either of them.
  it('refuses a duplicate id', () => {
    expect(() => ConfigurationTabs.ordered([tab('projects', 0), tab('projects', 1)]))
      .toThrow(/same id/)
  })

  // Two tabs sharing an order make the list depend on the sort's stability, not on the catalog.
  it('refuses a duplicate order', () => {
    expect(() => ConfigurationTabs.ordered([tab('projects', 0), tab('platforms', 0)]))
      .toThrow(/same order/)
  })

  it('leaves the catalog it was given alone', () => {
    const given = [tab('platforms', 1), tab('projects', 0)]

    ConfigurationTabs.ordered(given)

    expect(given.map((descriptor) => descriptor.id)).toEqual(['platforms', 'projects'])
  })
})
