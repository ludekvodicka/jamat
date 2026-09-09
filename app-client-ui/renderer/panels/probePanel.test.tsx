import { act, fireEvent, render, type RenderResult } from '@testing-library/react'
import type { IDockviewPanelProps } from 'dockview'
import { describe, expect, it } from 'vitest'

import { TabDecorationsStore } from '../widgets/tabs/tabDecorations'
import { TabDecorationsProvider } from '../widgets/tabs/tabDecorationsContext'
import { ProbePanel } from './probePanel'

interface Disposable {
  dispose(): void
}

/** The dockview events the panel consumes, plus the parameter event its sidebar infrastructure uses. */
class ProbeApiFake {
  private readonly visibility: ((event: { isVisible: boolean }) => void)[] = []
  private readonly active: ((event: { isActive: boolean }) => void)[] = []
  private readonly dimensions: ((event: { width: number; height: number }) => void)[] = []
  private readonly parameters: ((params: Record<string, unknown>) => void)[] = []

  readonly parameterWrites: Record<string, unknown>[] = []
  private stored: Record<string, unknown> = {}

  constructor(private readonly panelId: string) {}

  props(): IDockviewPanelProps {
    return {
      api: {
        id: this.panelId,
        getParameters: () => this.stored,
        updateParameters: (params: Record<string, unknown>) => {
          this.parameterWrites.push(params)
          this.stored = params
          for (const listener of [...this.parameters]) listener(params)
        },
        onDidParametersChange: (listener: (params: Record<string, unknown>) => void) =>
          ProbeApiFake.subscribe(this.parameters, listener),
        isVisible: true,
        isActive: true,
        width: 800,
        height: 600,
        onDidVisibilityChange: (listener: (event: { isVisible: boolean }) => void) =>
          ProbeApiFake.subscribe(this.visibility, listener),
        onDidActiveChange: (listener: (event: { isActive: boolean }) => void) =>
          ProbeApiFake.subscribe(this.active, listener),
        onDidDimensionsChange: (listener: (event: { width: number; height: number }) => void) =>
          ProbeApiFake.subscribe(this.dimensions, listener),
      },
      containerApi: {},
      params: this.stored,
    } as unknown as IDockviewPanelProps
  }

  emitVisibility(isVisible: boolean): void {
    act(() => {
      for (const listener of [...this.visibility])
        listener({ isVisible })
    })
  }

  emitActive(isActive: boolean): void {
    act(() => {
      for (const listener of [...this.active])
        listener({ isActive })
    })
  }

  emitDimensions(width: number, height: number): void {
    act(() => {
      for (const listener of [...this.dimensions])
        listener({ width, height })
    })
  }

  listenerCount(): number {
    return this.visibility.length + this.active.length + this.dimensions.length
      + this.parameters.length
  }

  private static subscribe<T>(
    listeners: ((event: T) => void)[],
    listener: (event: T) => void,
  ): Disposable {
    listeners.push(listener)
    return {
      dispose: () => {
        const index = listeners.indexOf(listener)
        if (index >= 0)
          listeners.splice(index, 1)
      },
    }
  }
}

class ProbeRender {
  /** The panel publishes into the tab store, so it needs the provider its shell puts around it. */
  static of(
    props: IDockviewPanelProps,
    store: TabDecorationsStore = new TabDecorationsStore(),
  ): RenderResult {
    return render(
      <TabDecorationsProvider store={store}>
        <ProbePanel {...props} />
      </TabDecorationsProvider>,
    )
  }
}

class ProbeView {
  static fact(container: HTMLElement, label: string): string {
    for (const fact of container.querySelectorAll('.jamat-probe__fact'))
      if (fact.querySelector('dt')?.textContent === label)
        return fact.querySelector('dd')?.textContent ?? ''
    throw new Error(`The probe renders no fact labelled ${JSON.stringify(label)}`)
  }

  static log(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.jamat-probe__entry')].map((entry) =>
      entry.textContent ?? '')
  }

  static button(container: HTMLElement): HTMLElement {
    const button = container.querySelector('.jamat-probe__button')
    if (!(button instanceof HTMLElement))
      throw new Error('The probe renders no local-state button')
    return button
  }

  static buttonLabelled(container: HTMLElement, label: string): HTMLElement {
    for (const button of container.querySelectorAll('.jamat-probe__button'))
      if (button.textContent === label && button instanceof HTMLElement)
        return button
    throw new Error(`The probe renders no button labelled ${JSON.stringify(label)}`)
  }
}

describe('app-client-ui/renderer/panels/probePanel', () => {
  it('logs each dockview event with the dimensions it carried, 0x0 included', () => {
    const fake = new ProbeApiFake('probe:events')
    const { container } = ProbeRender.of(fake.props())

    fake.emitVisibility(false)
    fake.emitDimensions(0, 0)
    fake.emitActive(false)
    fake.emitVisibility(true)
    fake.emitDimensions(640, 480)

    expect(ProbeView.log(container).map((line) => line.slice('00:00:00.000'.length))).toEqual([
      'visibility hidden',
      'dimensions 0x0',
      'active false',
      'visibility visible',
      'dimensions 640x480',
    ])
    expect(ProbeView.fact(container, 'Visible')).toBe('true')
    expect(ProbeView.fact(container, 'Active')).toBe('false')
    expect(ProbeView.fact(container, 'Size')).toBe('640x480')
  })

  // The whole point of the panel: a mount count above one is a panel dockview rebuilt.
  it('counts one mount per real mount of the same panel id', () => {
    const fake = new ProbeApiFake('probe:mounts')
    const first = ProbeRender.of(fake.props())
    expect(ProbeView.fact(first.container, 'Mounts')).toBe('1')

    first.unmount()
    const second = ProbeRender.of(fake.props())

    expect(ProbeView.fact(second.container, 'Mounts')).toBe('2')
    // The first mount's subscriptions went with it; a leak here would double every later reading.
    expect(fake.listenerCount()).toBe(4)
  })

  // The probe is what proves the tab slots are filled by the content and by nothing else.
  it('publishes its own state into the tab slots, and takes it back when it closes', () => {
    const store = new TabDecorationsStore()
    const fake = new ProbeApiFake('probe:slots')
    const rendered = ProbeRender.of(fake.props(), store)

    expect(store.get('probe:slots').primary?.tone).toBe('ok')
    expect(store.get('probe:slots').badges).toEqual([])

    fireEvent.click(ProbeView.buttonLabelled(rendered.container, 'Set RO badge'))
    expect(store.get('probe:slots').badges.map((badge) => badge.text)).toEqual(['RO'])

    fake.emitActive(false)
    expect(store.get('probe:slots').primary?.tone).toBe('muted')

    rendered.unmount()
    expect(store.get('probe:slots').primary).toBeNull()
  })

  it('keeps its local state and its log across a hide and reveal', () => {
    const fake = new ProbeApiFake('probe:state')
    const { container } = ProbeRender.of(fake.props())

    fireEvent.click(ProbeView.button(container))
    fireEvent.click(ProbeView.button(container))
    fake.emitVisibility(false)
    fake.emitDimensions(0, 0)
    fake.emitVisibility(true)

    expect(ProbeView.button(container).textContent).toBe('Local state: 2')
    expect(ProbeView.fact(container, 'Mounts')).toBe('1')
    expect(ProbeView.log(container).length).toBe(3)
  })
})

describe('app-client-ui/renderer/panels/probePanel tab sidebar', () => {
  it('opens its own sidebar and writes the state into the panel parameters', () => {
    const fake = new ProbeApiFake('probe:{"serial":1}')
    const { container } = ProbeRender.of(fake.props())
    expect(container.querySelector('.jamat-sidebar--hidden')).toBeTruthy()

    fireEvent.click(ProbeView.buttonLabelled(container, 'Show tab sidebar'))

    expect(container.querySelector('.jamat-sidebar--hidden')).toBeNull()
    expect(container.querySelector('[aria-label="Sidebar probe right"]')).toBeTruthy()
    expect(fake.parameterWrites).toEqual([{
      sidebar: { visible: true, width: 440, activeView: null },
    }])
  })

  // Closing the sidebar hides it by layout. Unmounting the view would throw away whatever it holds,
  // and a global sidebar makes the same promise - the count is the proof for both.
  it('keeps the view mounted across a close and a reopen', () => {
    const fake = new ProbeApiFake('probe:{"serial":2}')
    const { container } = ProbeRender.of(fake.props())

    fireEvent.click(ProbeView.buttonLabelled(container, 'Show tab sidebar'))
    const mounts = ProbeSidebarView.mounts(container)
    fireEvent.click(ProbeView.buttonLabelled(container, 'Hide tab sidebar'))
    fireEvent.click(ProbeView.buttonLabelled(container, 'Show tab sidebar'))

    expect(ProbeSidebarView.mounts(container)).toBe(mounts)
  })
})

class ProbeSidebarView {
  static mounts(container: HTMLElement): string {
    const view = container.querySelector('[aria-label="Sidebar probe right"]')
    if (!(view instanceof HTMLElement))
      throw new Error('The panel renders no tab sidebar view')
    for (const fact of view.querySelectorAll('.jamat-sidebar-probe__fact'))
      if (fact.querySelector('dt')?.textContent === 'Mounts')
        return fact.querySelector('dd')?.textContent ?? ''
    throw new Error('The sidebar probe renders no mount count')
  }
}
