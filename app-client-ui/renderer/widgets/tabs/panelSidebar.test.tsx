import { act, render, renderHook } from '@testing-library/react'
import type { IDockviewPanelProps } from 'dockview'
import { describe, expect, it } from 'vitest'

import type { SidebarSide } from '../../../shared/sidebarsState'
import { SidebarsState } from '../../../shared/sidebarsState'
import { PanelSidebarLayout, PanelSidebarParams, usePanelSidebar } from './panelSidebar'

describe('app-client-ui/renderer/widgets/tabs/panelSidebar', () => {
  /**
   * Only what the hook touches. `updateParameters` stands for the real one, which merges into the
   * panel's params and makes dockview fire a layout change; that this is the path which actually
   * persists is verified against a real window, not here.
   */
  function propsFixture(params: Record<string, unknown> = {}): {
    props: IDockviewPanelProps
    updates: Record<string, unknown>[]
    lowerPathCalls: string[]
    setParameters(next: Record<string, unknown>): void
  } {
    const updates: Record<string, unknown>[] = []
    const listeners: ((params: Record<string, unknown>) => void)[] = []
    // The lower path is OFFERED here on purpose: `containerApi.getPanel(id).update()` merges the
    // parameters and re-renders exactly like the public api, but never reaches the group model, so
    // dockview fires no layout change and the width is never stored. A test that only checked the
    // result could not tell the two apart.
    const lowerPathCalls: string[] = []
    const props = {
      api: {
        id: 'probe:{"serial":1}',
        getParameters: () => ({}),
        updateParameters: (next: Record<string, unknown>) => {
          updates.push(next)
          for (const listener of [...listeners]) listener(next)
        },
        onDidParametersChange: (listener: (next: Record<string, unknown>) => void) => {
          listeners.push(listener)
          return {
            dispose: () => {
              const at = listeners.indexOf(listener)
              if (at >= 0) listeners.splice(at, 1)
            },
          }
        },
      },
      containerApi: {
        getPanel: (id: string) => {
          lowerPathCalls.push(id)
          return { update: () => undefined }
        },
      },
      params,
    } as unknown as IDockviewPanelProps
    return {
      props,
      updates,
      lowerPathCalls,
      setParameters: (next) => {
        for (const listener of [...listeners]) listener(next)
      },
    }
  }

  it('opens a tab without a sidebar', () => {
    const { props } = propsFixture()
    const { result } = renderHook(() => usePanelSidebar(props))
    expect(result.current.state).toEqual(PanelSidebarParams.default())
  })

  it('starts from what the panel parameters carried, which is what a restore hands back', () => {
    const { props } = propsFixture({ serial: 1, sidebar: { visible: true, width: 300 } })
    const { result } = renderHook(() => usePanelSidebar(props, 'fileChanges'))
    expect(result.current.state).toEqual({
      visible: true,
      width: 300,
      activeView: 'fileChanges',
    })
  })

  it('uses the new view and width only when the saved layout omitted them', () => {
    expect(PanelSidebarParams.of({ sidebar: { visible: true } }, 'workingTree')).toEqual({
      visible: true,
      width: 440,
      activeView: 'workingTree',
    })
    expect(PanelSidebarParams.of({
      sidebar: { visible: true, width: 287, activeView: 'fileChanges' },
    }, 'workingTree')).toEqual({
      visible: true,
      width: 287,
      activeView: 'fileChanges',
    })
  })

  it('writes the state into the panel parameters and keeps the creation parameters', () => {
    const { props, updates, lowerPathCalls } = propsFixture({ serial: 1 })
    const { result } = renderHook(() => usePanelSidebar(props))
    act(() => result.current.toggle())
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({
      serial: 1,
      sidebar: { visible: true, width: 440, activeView: null },
    })
    // Through the public api and not through the panel: only that path is heard by the save.
    expect(lowerPathCalls).toEqual([])
  })

  it('clamps a width the same way the window sidebars are clamped', () => {
    const { props, updates } = propsFixture()
    const { result } = renderHook(() => usePanelSidebar(props))
    act(() => result.current.resize(10_000))
    expect(result.current.state.width).toBe(SidebarsState.maxWidthConst)
    expect(updates[0].sidebar).toEqual({
      visible: false,
      width: SidebarsState.maxWidthConst,
      activeView: null,
    })
  })

  it('falls back to the default when the stored parameters are damaged', () => {
    const { props } = propsFixture({ sidebar: 'wide' })
    const { result } = renderHook(() => usePanelSidebar(props))
    expect(result.current.state).toEqual(PanelSidebarParams.default())
  })

  it('merges without touching the creation parameters the panel id was derived from', () => {
    const creation = { serial: 1 }
    PanelSidebarParams.merged(creation, { visible: true, width: 300, activeView: null })
    expect(creation).toEqual({ serial: 1 })
  })

  // dockview's fromJSON reuses a LIVE panel with the same id, so parameters can change under a
  // mounted hook. Without the resync the hook kept its stale value and wrote it back on the next
  // change, dropping whatever the restore had brought.
  it('follows a parameter change that came from outside the hook', () => {
    const { props, updates } = propsFixture({ serial: 1 })
    const { result, rerender } = renderHook((current: IDockviewPanelProps) => usePanelSidebar(current), {
      initialProps: props,
    })
    expect(result.current.state.visible).toBe(false)

    const next = { serial: 1, sidebar: { visible: true, width: 300 } }
    rerender({ ...props, params: next })

    expect(result.current.state).toEqual({ visible: true, width: 300, activeView: null })
    expect(updates).toEqual([])

    act(() => result.current.toggle())
    expect(updates.at(-1)).toEqual({
      serial: 1,
      sidebar: { visible: false, width: 300, activeView: null },
    })
  })

  it('merges an immediate toggle into live split parameters', () => {
    const { props, updates, setParameters } = propsFixture({ serial: 1 })
    const { result } = renderHook(() => usePanelSidebar(props))
    const split = { ratio: 0.5, active: 'key:a.md', items: [{ key: 'key:a.md' }] }
    setParameters({ split })

    act(() => result.current.toggle())

    expect(updates.at(-1)?.split).toEqual(split)
    expect(updates.at(-1)?.sidebar).toEqual({
      visible: true,
      width: 440,
      activeView: null,
    })
  })

  // The DOM order, not a CSS `order`: a screen reader walks the panel the way it looks.
  it('puts the sidebar after the content on the right and before it on the left', () => {
    function textsFor(side: SidebarSide): string[] {
      const view = render(
        <PanelSidebarLayout side={side} sidebar={<span>the sidebar</span>}>
          <span>the content</span>
        </PanelSidebarLayout>,
      )
      const row = view.container.firstElementChild
      const texts = [...(row?.children ?? [])].map((child) => child.textContent ?? '')
      view.unmount()
      return texts
    }
    expect(textsFor('right')).toEqual(['the content', 'the sidebar'])
    expect(textsFor('left')).toEqual(['the sidebar', 'the content'])
  })

  it('gives two panels their own state, because each one carries its own parameters', () => {
    const first = propsFixture({ serial: 1, sidebar: { visible: true, width: 300 } })
    const second = propsFixture({ serial: 2 })
    const firstHook = renderHook(() => usePanelSidebar(first.props))
    const secondHook = renderHook(() => usePanelSidebar(second.props))
    expect(firstHook.result.current.state.width).toBe(300)
    expect(secondHook.result.current.state.visible).toBe(false)

    act(() => secondHook.result.current.resize(400))
    expect(firstHook.result.current.state.width).toBe(300)
    expect(first.updates).toEqual([])
  })

  it('stores the selected view and shows it in one operation', () => {
    const { props, updates } = propsFixture({ sidebar: { visible: false, width: 280 } })
    const { result } = renderHook(() => usePanelSidebar(props, 'fileChanges'))
    act(() => result.current.open('directoryExplorer'))
    expect(result.current.state).toEqual({
      visible: true,
      width: 280,
      activeView: 'directoryExplorer',
    })
    expect(updates[0].sidebar).toEqual(result.current.state)
  })
})
