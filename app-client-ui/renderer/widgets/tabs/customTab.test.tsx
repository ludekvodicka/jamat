import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import type { IDockviewPanelHeaderProps } from 'dockview'
import { describe, expect, it, vi } from 'vitest'

import { CommandRegistry } from '../../commands/commandRegistry'
import { PanelFocusRegistry } from '../../shell/panelFocusRegistry'
import { CustomTab } from './customTab'
import { TabDecorationsStore } from './tabDecorations'
import { TabDecorationsProvider } from './tabDecorationsContext'
import type { TabsController } from './tabsController'

/** What a tab reads off the panel api, the two events it follows, and the one thing it calls back. */
class TabApiFake {
  readonly setActive = vi.fn()
  private title = 'Lifecycle Probe 2'
  private readonly listeners: ((event: { isActive: boolean }) => void)[] = []
  private readonly titleListeners: ((event: { title: string }) => void)[] = []
  private subscriptions = 0

  constructor(private readonly panelId: string, private active: boolean) {}

  props(): IDockviewPanelHeaderProps {
    const fake = this
    return {
      api: {
        id: this.panelId,
        get title() {
          return fake.title
        },
        get isActive() {
          return fake.active
        },
        setActive: this.setActive,
        onDidActiveChange: (listener: (event: { isActive: boolean }) => void) => {
          this.subscriptions += 1
          this.listeners.push(listener)
          return {
            dispose: () => {
              const index = this.listeners.indexOf(listener)
              if (index >= 0)
                this.listeners.splice(index, 1)
            },
          }
        },
        onDidTitleChange: (listener: (event: { title: string }) => void) => {
          this.titleListeners.push(listener)
          return {
            dispose: () => {
              const index = this.titleListeners.indexOf(listener)
              if (index >= 0)
                this.titleListeners.splice(index, 1)
            },
          }
        },
      },
      containerApi: {},
      params: {},
      tabLocation: 'header',
    } as unknown as IDockviewPanelHeaderProps
  }

  emitActive(isActive: boolean): void {
    this.active = isActive
    act(() => {
      for (const listener of [...this.listeners])
        listener({ isActive })
    })
  }

  /** What `applySessionTitles` does to a mounted panel: write the title, fire the event. */
  setTitle(title: string): void {
    this.title = title
    act(() => {
      for (const listener of [...this.titleListeners])
        listener({ title })
    })
  }

  listenerCount(): number {
    return this.listeners.length
  }

  titleListenerCount(): number {
    return this.titleListeners.length
  }

  subscribeCount(): number {
    return this.subscriptions
  }
}

class ControllerFake {
  readonly hidePanel = vi.fn(() => Promise.resolve())
  readonly keyOf = vi.fn(() => 'probe')
  readonly keepOpen = vi.fn()
  private previewPanelId: string | null = null
  private previewListeners: (() => void)[] = []

  subscribePreview = (listener: () => void): (() => void) => {
    this.previewListeners.push(listener)
    return () => {
      this.previewListeners = this.previewListeners.filter((candidate) => candidate !== listener)
    }
  }

  isPreview = (panelId: string): boolean => this.previewPanelId === panelId

  get previewListenerCount(): number {
    return this.previewListeners.length
  }

  setPreview(panelId: string | null): void {
    this.previewPanelId = panelId
    for (const listener of [...this.previewListeners])
      listener()
  }

  asController(): TabsController {
    return this as unknown as TabsController
  }
}

class TabRender {
  /** Under the provider, the same way the tab is mounted inside the shell. */
  static of(
    props: IDockviewPanelHeaderProps,
    controller: TabsController,
    store: TabDecorationsStore = new TabDecorationsStore(),
    panelFocus: PanelFocusRegistry = new PanelFocusRegistry(),
  ): RenderResult {
    return render(
      <TabDecorationsProvider store={store}>
        <CustomTab
          {...props}
          controller={controller}
          commands={new CommandRegistry()}
          sessionFacts={() => null}
          panelFocus={panelFocus}
        />
      </TabDecorationsProvider>,
    )
  }

  static signals(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll('.jamat-tab__signal')] as HTMLElement[]
  }

  /** Position inside the tab, because "before the cross" is the whole rule for a badge. */
  static childIndex(container: HTMLElement, selector: string): number {
    const children = [...(container.querySelector('.jamat-tab')?.children ?? [])]
    return children.findIndex((child) => child.matches(selector))
  }
}

describe('app-client-ui/renderer/widgets/tabs/customTab', () => {
  // The commands in the menu act on the ACTIVE panel, so the right button has to move it first.
  it('activates its panel and opens the menu on a right click', () => {
    const api = new TabApiFake('probe:2', false)
    const { container } = TabRender.of(api.props(), new ControllerFake().asController())

    const tab = container.querySelector('.jamat-tab')
    expect(tab).toBeInstanceOf(HTMLElement)
    expect(tab?.classList.contains('is-active')).toBe(false)
    expect(document.querySelector('.jamat-tab-menu')).toBeNull()

    fireEvent.contextMenu(tab as HTMLElement, { clientX: 40, clientY: 12 })

    expect(api.setActive.mock.calls.length).toBe(1)
    expect(document.querySelector('.jamat-tab-menu')).toBeInstanceOf(HTMLElement)
  })

  /**
   * The press already made the panel active, or it was active and dockview did nothing at all; in
   * both cases it left the focus on the tab element, which types into nothing. The click is the last
   * word, and it is why a person can go from the sessions tree straight back to typing.
   */
  it('hands the caret to the panel below it when the tab is clicked', () => {
    const panelFocus = new PanelFocusRegistry()
    const focused = vi.fn()
    panelFocus.register('probe:2', focused)
    const { container } = TabRender.of(
      new TabApiFake('probe:2', true).props(),
      new ControllerFake().asController(),
      new TabDecorationsStore(),
      panelFocus,
    )

    fireEvent.click(container.querySelector('.jamat-tab') as HTMLElement)

    expect(focused).toHaveBeenCalledOnce()
  })

  // The cross ends the tab; giving its panel the caret on the way out would be a keystroke into a
  // terminal that is going.
  it('leaves the caret alone when the cross is clicked', () => {
    const panelFocus = new PanelFocusRegistry()
    const focused = vi.fn()
    panelFocus.register('probe:3', focused)
    const { container } = TabRender.of(
      new TabApiFake('probe:3', true).props(),
      new ControllerFake().asController(),
      new TabDecorationsStore(),
      panelFocus,
    )

    fireEvent.click(container.querySelector('.jamat-tab__close') as HTMLElement)

    expect(focused).not.toHaveBeenCalled()
  })

  /**
   * The menu is a portal, so React bubbles its clicks through the tab while the DOM does not. An
   * item that opens another panel would otherwise leave the caret in a terminal nobody is looking at.
   */
  it('leaves the caret alone when its menu is clicked', () => {
    const panelFocus = new PanelFocusRegistry()
    const focused = vi.fn()
    panelFocus.register('probe:2', focused)
    const { container } = TabRender.of(
      new TabApiFake('probe:2', true).props(),
      new ControllerFake().asController(),
      new TabDecorationsStore(),
      panelFocus,
    )
    fireEvent.contextMenu(container.querySelector('.jamat-tab') as HTMLElement, {
      clientX: 40,
      clientY: 12,
    })

    const menu = document.querySelector('.jamat-tab-menu')
    if (!menu) throw new Error('the right click opened no menu')
    fireEvent.click(menu.querySelector('button') ?? menu)

    expect(focused).not.toHaveBeenCalled()
  })

  it('closes through the controller when the cross is clicked', () => {
    const controller = new ControllerFake()
    const { container } = TabRender.of(
      new TabApiFake('probe:3', true).props(),
      controller.asController(),
    )

    fireEvent.click(container.querySelector('.jamat-tab__close') as HTMLElement)

    expect(controller.hidePanel.mock.calls).toEqual([['probe:3']])
  })

  // The tab chains a `.catch` onto the close, so a double that answered `undefined` threw out of the
  // React handler and vitest reported one unhandled error for the whole run. The sentence itself had
  // no test either: a close that rejects has to say so, because the tab stays standing.
  it('reports a close that rejects instead of dropping it', async () => {
    const controller = new ControllerFake()
    controller.hidePanel.mockReturnValue(Promise.reject(new Error('the panel is owned elsewhere')))
    const reported: string[] = []
    const console_ = vi.spyOn(console, 'error').mockImplementation((message: string) => {
      reported.push(message)
    })
    const { container } = TabRender.of(
      new TabApiFake('probe:4', true).props(),
      controller.asController(),
    )

    fireEvent.click(container.querySelector('.jamat-tab__close') as HTMLElement)
    await Promise.resolve()

    expect(reported).toEqual([
      '[app-client-ui] the tab could not be closed: the panel is owned elsewhere',
    ])
    console_.mockRestore()
  })

  // Dockview hands the same api object to every render, so a tab that only READ isActive kept the
  // mark of the active tab after losing it: two tabs wore the accent line at once.
  it('follows the activity of its panel, and lets go of the subscription with the tab', () => {
    const api = new TabApiFake('probe:8', true)
    const rendered = TabRender.of(api.props(), new ControllerFake().asController())
    const tab = (): Element => rendered.container.querySelector('.jamat-tab') as Element

    expect(tab().classList.contains('is-active')).toBe(true)

    api.emitActive(false)
    expect(tab().classList.contains('is-active')).toBe(false)

    api.emitActive(true)
    expect(tab().classList.contains('is-active')).toBe(true)
    expect(api.subscribeCount()).toBe(1)

    rendered.unmount()
    expect(api.listenerCount()).toBe(0)
  })

  // The same api-object hazard as activity: a rename reaches a mounted panel through `setTitle`,
  // so a tab that only READ `api.title` would keep the name it opened under.
  it('follows a setTitle on its panel, and lets go of the subscription with the tab', () => {
    const api = new TabApiFake('probe:10', true)
    const rendered = TabRender.of(api.props(), new ControllerFake().asController())
    const title = (): string | null | undefined =>
      rendered.container.querySelector('.jamat-tab__title')?.textContent

    expect(title()).toBe('Lifecycle Probe 2')

    api.setTitle('014 - renamed')
    expect(title()).toBe('014 - renamed')

    rendered.unmount()
    expect(api.titleListenerCount()).toBe(0)
  })

  // Both slots are drawn on a tab that publishes nothing: that is what keeps the titles of a whole
  // strip on one axis instead of shifting them as signals come and go.
  it('holds both signal slots on a tab with no decorations', () => {
    const { container } = TabRender.of(
      new TabApiFake('probe:4', true).props(),
      new ControllerFake().asController(),
    )

    const signals = TabRender.signals(container)
    expect(signals.length).toBe(2)
    expect(signals.every((signal) => signal.classList.contains('is-empty'))).toBe(true)
    expect(container.querySelector('.jamat-tab__badge')).toBeNull()
  })

  it('draws the published signals and the badge before the cross', () => {
    const store = new TabDecorationsStore()
    store.set('probe:5', {
      primary: { glyph: '●', tone: 'ok', title: 'Working' },
      secondary: { glyph: '◆', tone: 'accent', title: 'Worktree' },
      badges: [{ key: 'ro', text: 'RO', tone: 'muted', title: 'Read only' }],
    })
    const { container } = TabRender.of(
      new TabApiFake('probe:5', true).props(),
      new ControllerFake().asController(),
      store,
    )

    const [primary, secondary] = TabRender.signals(container)
    expect([primary.textContent, primary.dataset.tone, primary.title])
      .toEqual(['●', 'ok', 'Working'])
    expect([secondary.textContent, secondary.dataset.tone]).toEqual(['◆', 'accent'])
    const badge = container.querySelector('.jamat-tab__badge') as HTMLElement
    expect([badge.textContent, badge.dataset.tone, badge.title])
      .toEqual(['RO', 'muted', 'Read only'])
    expect(TabRender.childIndex(container, '.jamat-tab__badge'))
      .toBeLessThan(TabRender.childIndex(container, '.jamat-tab__close'))
  })

  /**
   * A colour is a name here, exactly as a tone is: the tab puts it on an attribute and the
   * stylesheet is the one place that decides what it looks like.
   */
  it('carries the published colour as an attribute, and none where there is no colour', () => {
    const store = new TabDecorationsStore()
    store.set('probe:8', { primary: null, secondary: null, badges: [], color: 'teal' })
    const { container } = TabRender.of(
      new TabApiFake('probe:8', true).props(),
      new ControllerFake().asController(),
      store,
    )

    const tab = container.querySelector('.jamat-tab') as HTMLElement
    expect(tab.dataset.sessionColor).toBe('teal')

    cleanup()
    const plain = TabRender.of(
      new TabApiFake('probe:9', true).props(),
      new ControllerFake().asController(),
    )
    expect((plain.container.querySelector('.jamat-tab') as HTMLElement).dataset.sessionColor)
      .toBeUndefined()
  })

  // The point of the store: content publishes while its tab is already on screen, and a publication
  // meant for another panel is not this tab's business.
  it('follows what its own panel publishes and ignores another panel', () => {
    const store = new TabDecorationsStore()
    const { container } = TabRender.of(
      new TabApiFake('probe:6', true).props(),
      new ControllerFake().asController(),
      store,
    )

    act(() => store.set('probe:7', {
      primary: { glyph: '●', tone: 'danger', title: 'Someone else' },
      secondary: null,
      badges: [],
    }))
    expect(TabRender.signals(container)[0].classList.contains('is-empty')).toBe(true)

    act(() => store.set('probe:6', {
      primary: { glyph: '◑', tone: 'attention', title: 'Waiting for you' },
      secondary: null,
      badges: [],
    }))
    const primary = TabRender.signals(container)[0]
    expect([primary.textContent, primary.dataset.tone]).toEqual(['◑', 'attention'])

    act(() => store.clear('probe:6'))
    expect(TabRender.signals(container)[0].classList.contains('is-empty')).toBe(true)
  })

  describe('the preview mark', () => {
    it('follows the controller, and drops when the tab is promoted', () => {
      const controller = new ControllerFake()
      controller.setPreview('probe:2')
      const { container } = TabRender.of(new TabApiFake('probe:2', false).props(), controller.asController())

      const tab = container.querySelector('.jamat-tab')
      expect(tab?.classList.contains('is-preview')).toBe(true)

      act(() => controller.setPreview(null))
      expect(tab?.classList.contains('is-preview')).toBe(false)
    })

    it('is not worn by a tab that is not the preview', () => {
      const controller = new ControllerFake()
      controller.setPreview('probe:9')
      const { container } = TabRender.of(new TabApiFake('probe:2', false).props(), controller.asController())

      expect(container.querySelector('.jamat-tab')?.classList.contains('is-preview')).toBe(false)
    })

    it('promotes its own panel when the tab is double-clicked', () => {
      const controller = new ControllerFake()
      controller.setPreview('probe:2')
      const { container } = TabRender.of(new TabApiFake('probe:2', false).props(), controller.asController())

      const tab = container.querySelector('.jamat-tab')
      if (!tab) throw new Error('the tab did not render')
      fireEvent.doubleClick(tab)

      expect(controller.keepOpen.mock.calls).toEqual([['probe:2']])
    })

    it('stops listening when it is unmounted', () => {
      const controller = new ControllerFake()
      const { unmount } = TabRender.of(new TabApiFake('probe:2', false).props(), controller.asController())
      expect(controller.previewListenerCount).toBe(1)

      unmount()

      expect(controller.previewListenerCount).toBe(0)
    })
  })
})
