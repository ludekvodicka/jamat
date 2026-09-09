import type { IDockviewPanelProps } from 'dockview'
import { describe, expect, it } from 'vitest'

import { PanelRegistry } from './panelRegistry'

describe('app-client-ui/renderer/widgets/tabs/panelRegistry', () => {
  const componentStub: React.FunctionComponent<IDockviewPanelProps> = () => null

  it('keeps every registered key in the components map', () => {
    const registry = new PanelRegistry()
    registry.register({ key: 'welcome', title: 'Home', component: componentStub })
    registry.register({ key: 'probe', title: 'Lifecycle Probe', component: componentStub })

    expect(Object.keys(registry.components()).sort()).toEqual(['probe', 'welcome'])
    expect(registry.titleOf('probe')).toBe('Lifecycle Probe')
  })

  // Shadowing the first registration would only show up on a restored layout, in front of a user.
  it('refuses a second registration of the same key', () => {
    const registry = new PanelRegistry()
    registry.register({ key: 'welcome', title: 'Home', component: componentStub })

    expect(() => registry.register({ key: 'welcome', title: 'Other', component: componentStub }))
      .toThrow(/already registered/)
  })

  it('throws on an unknown component key instead of opening a blank panel', () => {
    const registry = new PanelRegistry()

    expect(() => registry.assertComponent('terminal')).toThrow(/Unknown panel component/)
  })

  it('answers with the key itself when nothing is registered under it', () => {
    expect(new PanelRegistry().titleOf('terminal')).toBe('terminal')
  })
})
