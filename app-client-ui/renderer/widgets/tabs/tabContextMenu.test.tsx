import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionOperation,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppCommands, type CommandId } from '../../../shared/commands'
import { CommandRegistry } from '../../commands/commandRegistry'
import { TabContextMenu, type TabSessionFacts } from './tabContextMenu'

function titleOf(id: CommandId): string {
  const descriptor = AppCommands.all().find((candidate) => candidate.id === id)
  if (!descriptor)
    throw new Error(`The catalog holds no command ${JSON.stringify(id)}`)
  return descriptor.title
}

const everyOperationConst: readonly SessionOperation[] =
  ['newBeside', 'fork', 'restart', 'compact']

/** A claude session in a project that admits everything, which each test then narrows. */
function factsOf(over: Partial<TabSessionFacts> = {}): TabSessionFacts {
  return {
    agentId: 'claude',
    color: null,
    directoryPath: 'C:/Projects/NodeJs/AppJamatV3',
    launch: {
      kind: 'project',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      projectPath: 'C:/Projects/NodeJs/AppJamatV3',
    },
    admits: everyOperationConst,
    ...over,
  }
}

/**
 * Records every listener the menu adds to window and to document and pairs it with its removal, so
 * "the menu is gone" is asserted about the listener table rather than about the DOM only.
 */
class ListenerLedger {
  private readonly spies = [
    vi.spyOn(window, 'addEventListener'),
    vi.spyOn(window, 'removeEventListener'),
    vi.spyOn(document, 'addEventListener'),
    vi.spyOn(document, 'removeEventListener'),
  ] as const

  /** Event types added and never removed with the same listener reference. */
  pending(): string[] {
    return [
      ...ListenerLedger.unmatched(this.spies[0], this.spies[1]),
      ...ListenerLedger.unmatched(this.spies[2], this.spies[3]),
    ]
  }

  private static unmatched(
    added: { mock: { calls: unknown[][] } },
    removed: { mock: { calls: unknown[][] } },
  ): string[] {
    const open: unknown[][] = []
    for (const call of added.mock.calls)
      open.push(call)
    for (const call of removed.mock.calls) {
      const index = open.findIndex((other) => other[0] === call[0] && other[1] === call[1])
      if (index >= 0)
        open.splice(index, 1)
    }
    return open.map((call) => String(call[0]))
  }
}

/** The menu as the tab holds it: open until something closes it, then gone from the DOM. */
function MenuHost(props: {
  commands: CommandRegistry
  panelKey?: string
  params?: Record<string, unknown>
  facts?: TabSessionFacts | null
  preview?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  if (!open)
    return <div data-testid="closed" />
  return (
    <TabContextMenu
      position={{ x: 10, y: 20 }}
      commands={props.commands}
      panelKey={props.panelKey ?? 'probe'}
      params={props.params ?? {}}
      facts={props.facts ?? null}
      preview={props.preview ?? false}
      onClose={() => setOpen(false)}
    />
  )
}

class MenuView {
  /** The top level only: a submenu's own rows carry the same item class. */
  static items(): HTMLElement[] {
    return [...document.querySelectorAll(
      '.jamat-tab-menu > .jamat-context-menu__row > .jamat-context-menu__item',
    )].filter((item): item is HTMLElement => item instanceof HTMLElement)
  }

  static titles(): string[] {
    return MenuView.items().map((item) =>
      item.querySelector('.jamat-context-menu__label')?.textContent ?? '')
  }

  static separators(): HTMLElement[] {
    return [...document.querySelectorAll('.jamat-tab-menu > [role="separator"]')]
      .filter((item): item is HTMLElement => item instanceof HTMLElement)
  }

  static isOpen(): boolean {
    return document.querySelector('.jamat-tab-menu') !== null
  }

  static itemTitled(title: string): HTMLElement {
    const index = MenuView.titles().indexOf(title)
    if (index < 0)
      throw new Error(`The menu shows no item titled ${JSON.stringify(title)}`)
    return MenuView.items()[index]
  }

  /** Opens the appearance submenu and answers with the labels it holds. */
  static colours(): string[] {
    fireEvent.mouseEnter(MenuView.itemTitled(titleOf('session.setColor')).parentElement as HTMLElement)
    const submenu = document.querySelector('.jamat-context-menu__flyout')
    if (submenu === null)
      throw new Error('The appearance submenu did not open')
    return [...submenu.querySelectorAll('.jamat-context-menu__label')]
      .map((label) => label.textContent ?? '')
  }
}

describe('app-client-ui/renderer/widgets/tabs/tabContextMenu', () => {
  afterEach(() => vi.restoreAllMocks())

  // The catalog is the menu: a command declaring the surface arrives here without a code change.
  it('shows the catalog commands that apply to this tab, in catalog order', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf()}
      />,
    )

    expect(MenuView.titles()).toEqual([
      // The catalog's order, so the colour opens this menu exactly as it opens the tree's.
      'Session Appearance',
      'Session properties…',
      // The launcher pre-bound to this tab's project: it starts nothing by itself, which is why it
      // is above the three that do.
      'New session…',
      'New blank session',
      // The other agent only: this tab is already Claude's.
      'New session in Codex',
      'Fork session',
      'Restart session',
      'Compact session',
      'Open project folder',
      'Copy project folder',
      'Copy unique session id',
      'Close Tab',
      'Close Other Tabs',
      'Split Right',
      'Split Down',
      'Move to New Window',
    ])
    expect(MenuView.titles()).not.toContain(titleOf('tab.new'))
    expect(MenuView.titles()).not.toContain(titleOf('tab.resetLayout'))
  })

  it('offers the other agent, whichever this one is', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf({ agentId: 'codex' })}
      />,
    )

    expect(MenuView.titles()).toContain(titleOf('session.newInClaude'))
    expect(MenuView.titles()).not.toContain(titleOf('session.newInCodex'))
  })

  /**
   * The pre-bound launcher needs a project to bind TO, and a tab whose session runs in an ad-hoc
   * directory belongs to none. It is the one gate that is about the binding rather than `admits`.
   */
  it('leaves out the pre-bound launcher on a tab that belongs to no project', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf({ launch: null })}
      />,
    )

    expect(MenuView.titles()).not.toContain(titleOf('session.newHere'))
    expect(MenuView.titles()).toContain(titleOf('session.newBlank'))
  })

  // The one item of this menu that carries a value: no active tab can supply a place.
  it('sends the tab session’s project as the place of a new session', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(
      <MenuHost
        commands={commands}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf()}
      />,
    )

    fireEvent.click(MenuView.itemTitled(titleOf('session.newHere')))

    expect(execute.mock.calls).toEqual([['session.newHere', {
      place: {
        kind: 'project',
        project: {
          kind: 'project',
          categoryId: 'nodejs',
          projectName: 'AppJamatV3',
          projectPath: 'C:/Projects/NodeJs/AppJamatV3',
        },
      },
    }]])
  })

  /*
   * The bare branch runs a command with no argument, and `CommandRegistry.execute(id)` now refuses a
   * value-carrying id BY TYPE, so a plain id reaching it has to be narrowed first. That narrowing is
   * this throw. Without it the compiler is satisfied by a cast nobody sees and the click ends as
   * `undefined.place` inside a React `onSelect`, where nothing catches it and the menu stays open.
   */
  it('refuses a value-carrying command it cannot supply the value for', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(
      <MenuHost commands={commands} panelKey="terminal" params={{}} facts={factsOf()} />,
    )

    const reported: string[] = []
    const onError = (event: ErrorEvent): void => {
      reported.push(String(event.error))
      event.preventDefault()
    }
    window.addEventListener('error', onError)
    try {
      fireEvent.click(MenuView.itemTitled(titleOf('session.newHere')))
    } finally {
      window.removeEventListener('error', onError)
    }

    // React reports what an `onSelect` throws rather than letting it out of `fireEvent`, which is
    // the same silence the running app would have shown.
    expect(reported.join(' ')).toMatch(/cannot supply the value/)
    expect(execute).not.toHaveBeenCalled()
  })

  /**
   * The library decides which operations a session admits, and an item it does not admit is absent
   * rather than greyed out - a menu of dead rows says less than a short menu.
   */
  it('leaves out every session action the session does not admit', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf({ admits: ['newBeside'] })}
      />,
    )

    expect(MenuView.titles()).toContain(titleOf('session.newBlank'))
    expect(MenuView.titles()).not.toContain(titleOf('session.fork'))
    expect(MenuView.titles()).not.toContain(titleOf('session.restart'))
    expect(MenuView.titles()).not.toContain(titleOf('session.compact'))
  })

  it('offers no session action at all on a tab that is not a session panel', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="fileViewer"
        params={{ sessionId: 's1' }}
        facts={factsOf()}
      />,
    )

    expect(MenuView.titles()).not.toContain(titleOf('session.details'))
    expect(MenuView.titles()).not.toContain(titleOf('session.setColor'))
    expect(MenuView.titles()).not.toContain(titleOf('session.fork'))
    expect(MenuView.titles()).not.toContain(titleOf('session.copyReference'))
    // What the file viewer's own tab still offers is unaffected.
    expect(MenuView.titles()).toContain(titleOf('tab.openProjectFolder'))
  })

  /**
   * Renaming asks nothing of the runtime, so it takes no admits gate: an ended session's record is
   * exactly as renameable as a live one's. What it does need is a session at all.
   */
  it('offers the details dialog on any session panel, whatever the session admits', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf({ admits: [] })}
      />,
    )
    expect(MenuView.titles()).toContain(titleOf('session.details'))

    cleanup()
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={null}
      />,
    )
    expect(MenuView.titles()).not.toContain(titleOf('session.details'))
  })

  it('offers copying the folder only where there is a path to copy', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf({ directoryPath: null })}
      />,
    )

    expect(MenuView.titles()).not.toContain(titleOf('tab.copyProjectFolder'))
  })

  /**
   * The catalog says which commands a tab menu can hold; which of them apply is the tab's own
   * parameters. Keeping a tab as a session is meaningless on a session of the tree.
   */
  it('offers keeping the tab only on a plain tab', () => {
    render(<MenuHost commands={new CommandRegistry()} params={{ presentation: 'tab' }} />)
    expect(MenuView.titles()).toContain(titleOf('tab.promote'))

    cleanup()
    render(<MenuHost commands={new CommandRegistry()} params={{ sessionId: 's1' }} />)
    expect(MenuView.titles()).not.toContain(titleOf('tab.promote'))
    // Everything else the menu offers is unaffected.
    expect(MenuView.titles()).toContain(titleOf('tab.close'))
  })

  it('offers the project folder only on a tab bound to a session', () => {
    render(<MenuHost commands={new CommandRegistry()} params={{ sessionId: 's1' }} />)
    expect(MenuView.titles()).toContain(titleOf('tab.openProjectFolder'))

    cleanup()
    render(<MenuHost commands={new CommandRegistry()} params={{}} />)
    expect(MenuView.titles()).not.toContain(titleOf('tab.openProjectFolder'))

    cleanup()
    render(<MenuHost commands={new CommandRegistry()} params={{ sessionId: '' }} />)
    expect(MenuView.titles()).not.toContain(titleOf('tab.openProjectFolder'))
  })

  it('does not offer moving Home to a new window', () => {
    render(<MenuHost commands={new CommandRegistry()} panelKey="welcome" />)
    expect(MenuView.titles()).not.toContain(titleOf('tab.moveToNewWindow'))

    cleanup()
    render(<MenuHost commands={new CommandRegistry()} panelKey="probe" />)
    expect(MenuView.titles()).toContain(titleOf('tab.moveToNewWindow'))
  })

  it('separates the blocks, and only where both sides have something in them', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf()}
      />,
    )
    // Appearance | session actions | folder actions | tab actions.
    expect(MenuView.separators()).toHaveLength(3)

    cleanup()
    // A probe tab has no session block and no folder to copy, so only one line is left.
    render(<MenuHost commands={new CommandRegistry()} panelKey="probe" params={{}} />)
    expect(MenuView.separators()).toHaveLength(0)
  })

  it('runs the clicked command once and closes', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(<MenuHost commands={commands} />)

    fireEvent.click(MenuView.itemTitled(titleOf('tab.closeOthers')))

    // The id alone: a command without a value is called the way it always was.
    expect(execute.mock.calls).toEqual([['tab.closeOthers']])
    expect(MenuView.isOpen()).toBe(false)
  })

  it('offers None and the twelve colours, and sends the chosen one as the command value', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(
      <MenuHost
        commands={commands}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf()}
      />,
    )

    expect(MenuView.colours()).toEqual([
      'None', 'Red', 'Orange', 'Amber', 'Green', 'Teal', 'Cyan',
      'Sky', 'Blue', 'Indigo', 'Violet', 'Magenta', 'Rose',
    ])

    const teal = [...document.querySelectorAll('.jamat-context-menu__flyout .jamat-context-menu__item')]
      .find((item) => item.textContent?.includes('Teal'))
    fireEvent.click(teal as HTMLElement)

    // Named, like every other item this menu runs: the colour lands on the tab's own session
    // rather than on whatever a remote controller made active while the menu stood open.
    expect(execute.mock.calls)
      .toEqual([['session.setColor', { color: 'teal', sessionId: 's1' }]])
    expect(MenuView.isOpen()).toBe(false)
  })

  it('marks the colour the session already has', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf({ color: 'rose' })}
      />,
    )
    MenuView.colours()

    const current = document.querySelectorAll('.jamat-context-menu__flyout .is-current')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toContain('Rose')
  })

  it('marks None as current when the session has no colour', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        panelKey="terminal"
        params={{ sessionId: 's1' }}
        facts={factsOf()}
      />,
    )
    MenuView.colours()

    const current = document.querySelectorAll('.jamat-context-menu__flyout .is-current')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toBe('None')
  })

  it('closes on Escape', () => {
    render(<MenuHost commands={new CommandRegistry()} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(MenuView.isOpen()).toBe(false)
  })

  it('closes on a press outside itself and stays open on a press inside', () => {
    render(<MenuHost commands={new CommandRegistry()} />)

    fireEvent.mouseDown(MenuView.items()[0])
    expect(MenuView.isOpen()).toBe(true)

    fireEvent.mouseDown(document.body)
    expect(MenuView.isOpen()).toBe(false)
  })

  it('closes when the window loses focus', () => {
    render(<MenuHost commands={new CommandRegistry()} />)

    fireEvent.blur(window)

    expect(MenuView.isOpen()).toBe(false)
  })

  // The V1 splitter lesson: a listener that outlives its surface keeps calling into a dead closure.
  it('leaves no listener behind once it is closed', () => {
    const ledger = new ListenerLedger()
    render(<MenuHost commands={new CommandRegistry()} />)
    expect(ledger.pending().sort()).toEqual(['blur', 'keydown', 'mousedown'])

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(MenuView.isOpen()).toBe(false)
    expect(ledger.pending()).toEqual([])
  })

  // A menu opened at the edge belongs on screen; the flip is what keeps its last item reachable.
  it('flips onto the other side of the cursor when it would not fit', () => {
    const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 200, height: 120 } as DOMRect)
    window.innerWidth = 300
    window.innerHeight = 200
    const commands = new CommandRegistry()

    render(
      <TabContextMenu
        position={{ x: 260, y: 190 }}
        commands={commands}
        panelKey="probe"
        params={{}}
        facts={null}
        preview={false}
        onClose={() => undefined}
      />,
    )

    const menu = document.querySelector('.jamat-tab-menu')
    expect(menu).toBeInstanceOf(HTMLElement)
    expect((menu as HTMLElement).style.left).toBe('60px')
    expect((menu as HTMLElement).style.top).toBe('70px')
    box.mockRestore()
  })

  describe('Keep Open', () => {
    it('is offered on the provisional tab', () => {
      render(
        <MenuHost
          commands={new CommandRegistry()}
          panelKey="terminal"
          params={{ sessionId: 's1' }}
          facts={factsOf()}
          preview
        />,
      )

      expect(MenuView.titles()).toContain('Keep Open')
    })

    it('is not offered on a tab that already stays', () => {
      render(
        <MenuHost
          commands={new CommandRegistry()}
          panelKey="terminal"
          params={{ sessionId: 's1' }}
          facts={factsOf()}
        />,
      )

      expect(MenuView.titles()).not.toContain('Keep Open')
    })

    // A plain tab can never be the preview, so the item cannot reach the one tab whose close ends
    // its session. The controller refuses that pairing too; this is the surface saying the same.
    it('is not offered on a plain tab', () => {
      render(
        <MenuHost
          commands={new CommandRegistry()}
          panelKey="terminal"
          params={{ sessionId: 's1', presentation: 'tab' }}
          facts={factsOf()}
        />,
      )

      expect(MenuView.titles()).not.toContain('Keep Open')
    })

    it('runs the command with no argument, on the tab the menu made active', () => {
      const commands = new CommandRegistry()
      const executed = vi.fn()
      commands.register('tab.keepOpen', executed)
      render(
        <MenuHost
          commands={commands}
          panelKey="terminal"
          params={{ sessionId: 's1' }}
          facts={factsOf()}
          preview
        />,
      )

      fireEvent.click(MenuView.itemTitled('Keep Open'))

      expect(executed.mock.calls).toEqual([[undefined]])
    })
  })

  /*
   * The menu freezes what it DRAWS when it opens - the items are session A's, filtered against A's
   * `admits`. What it ran was late-bound: `execute(id)` with no argument falls back to the active
   * panel, read at the click. A remote controller does not click, so the window's `blur` listener
   * never fires: `open-session` from `app-client-cli` or a peer activates B's tab with no focus
   * change, the menu stays open, and Restart restarts B while the confirm dialog names no session.
   */
  it('aims every session item at the tab it was opened on', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    const ids: CommandId[] = [
      'session.details',
      'session.restart',
      'session.fork',
      'session.compact',
      'tab.promote',
      'tab.copyProjectFolder',
    ]
    for (const id of ids) {
      execute.mockClear()
      const view = render(
        <MenuHost
          commands={commands}
          panelKey="terminal"
          params={{ sessionId: 's1', presentation: 'tab' }}
          facts={factsOf()}
        />,
      )
      fireEvent.click(MenuView.itemTitled(titleOf(id)))

      expect(execute.mock.calls, id).toEqual([[id, { sessionId: 's1' }]])
      view.unmount()
    }
  })
})
