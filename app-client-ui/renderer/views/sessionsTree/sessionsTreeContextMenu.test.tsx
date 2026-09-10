import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionOperation,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppCommands, type CommandId } from '../../../shared/commands'
import { CommandRegistry } from '../../commands/commandRegistry'
import type { TabSessionFacts } from '../../widgets/tabs/tabContextMenu'
import type { SessionAction } from './sessionNodeState'
import { SessionsTreeContextMenu } from './sessionsTreeContextMenu'

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
    ended: false,
    live: over.ended !== true,
    admits: everyOperationConst,
    ...over,
  }
}

/** The menu as the tree holds it: open until something closes it, then gone from the DOM. */
function MenuHost(props: {
  commands: CommandRegistry
  facts?: Partial<TabSessionFacts>
  plainTab?: boolean
  actions?: readonly SessionAction[]
  onAction?(action: SessionAction): void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  if (!open)
    return <div data-testid="closed" />
  return (
    <SessionsTreeContextMenu
      position={{ x: 10, y: 20 }}
      commands={props.commands}
      sessionId="s1"
      facts={factsOf(props.facts)}
      plainTab={props.plainTab ?? false}
      actions={props.actions ?? []}
      onAction={props.onAction ?? vi.fn()}
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

  /** Opens the appearance submenu and answers with the item that reads the given label. */
  static colour(label: string): HTMLElement {
    fireEvent.mouseEnter(
      MenuView.itemTitled(titleOf('session.setColor')).parentElement as HTMLElement,
    )
    const found = [...document.querySelectorAll(
      '.jamat-context-menu__flyout .jamat-context-menu__item',
    )].find((item) => item.textContent?.includes(label))
    if (!(found instanceof HTMLElement))
      throw new Error(`The appearance submenu shows no ${JSON.stringify(label)}`)
    return found
  }
}

describe('app-client-ui/renderer/views/sessionsTree/sessionsTreeContextMenu', () => {
  afterEach(() => vi.restoreAllMocks())

  // The catalog is the menu: the sessionsTree surface holds the session commands and nothing that
  // manipulates a tab, because a row is not a tab.
  it('shows the session commands that apply to a live claude row, in catalog order', () => {
    render(<MenuHost commands={new CommandRegistry()} />)

    expect(MenuView.titles()).toEqual([
      // The colour first: it is the one row of this menu a person reaches for again and again.
      'Session Appearance',
      'Session properties…',
      // The launcher pre-bound to this session's project: it starts nothing by itself, which is why
      // it is above the three that do.
      'New session',
      // The other agent only: this session is already Claude's.
      'New session in Codex',
      'Fork session',
      'Restart session',
      'Compact session',
      'Commit (SVN)…',
      'Commit (Git)…',
      'Open project folder',
      'Copy project folder',
      'Copy unique session id',
    ])
    expect(MenuView.titles()).not.toContain(titleOf('tab.close'))
    expect(MenuView.titles()).not.toContain(titleOf('tab.closeOthers'))
    expect(MenuView.titles()).not.toContain(titleOf('tab.splitRight'))
    expect(MenuView.titles()).not.toContain(titleOf('tab.moveToNewWindow'))
    // Appearance | session actions | folder actions.
    expect(MenuView.separators()).toHaveLength(2)
  })

  it('offers the other agent, whichever this one is', () => {
    render(<MenuHost commands={new CommandRegistry()} facts={{ agentId: 'codex' }} />)

    expect(MenuView.titles()).toContain(titleOf('session.newInClaude'))
    expect(MenuView.titles()).not.toContain(titleOf('session.newInCodex'))
  })

  /**
   * An ended or lost session admits nothing, and its row still has a menu: the record commands ask
   * nothing of the runtime, and the folder is where the session ran regardless of whether it runs.
   */
  it('keeps the record and folder commands on a row whose session admits nothing', () => {
    render(<MenuHost commands={new CommandRegistry()} facts={{ admits: [] }} />)

    expect(MenuView.titles()).toEqual([
      'Session Appearance',
      'Session properties…',
      // Not gated on `admits` either: the launcher creates from scratch rather than beside this one.
      'Commit (SVN)…',
      'Commit (Git)…',
      'Open project folder',
      'Copy project folder',
      // Gated on nothing either, and the one item on this row a SECOND agent is meant to read: an
      // ended session is exactly the one somebody hands over.
      'Copy unique session id',
    ])
  })

  it('leaves out every session action the session does not admit, and keeps the rest', () => {
    render(<MenuHost commands={new CommandRegistry()} facts={{ admits: ['newBeside'] }} />)

    expect(MenuView.titles()).toContain(titleOf('session.newBeside'))
    expect(MenuView.titles()).toContain(titleOf('session.newInCodex'))
    expect(MenuView.titles()).not.toContain(titleOf('session.fork'))
    expect(MenuView.titles()).not.toContain(titleOf('session.restart'))
    expect(MenuView.titles()).not.toContain(titleOf('session.compact'))
  })

  it('moves every secondary tree operation into a final menu group and keeps Finish on the row', () => {
    const onAction = vi.fn()
    // A row that offers a rerun is a row whose session has stopped, which is the same fact the
    // catalog block reads to draw `Resume session` there instead of `Restart session`.
    render(<MenuHost
      commands={new CommandRegistry()}
      facts={{ ended: true }}
      actions={['finalize', 'retrySetup', 'reopen', 'remove']}
      onAction={onAction}
    />)

    expect(MenuView.titles()).not.toContain('Finish')
    expect(MenuView.titles()).not.toContain('Restart session')
    // Rerun left this block on 2026-09-10: bringing a stopped session back is `Resume session` in
    // the catalog block above, and one operation under two names on one menu is what that block's
    // own rule already forbade.
    expect(MenuView.titles()).not.toContain('Rerun')
    expect(MenuView.titles().slice(-2)).toEqual(['Retry setup', 'Remove…'])
    expect(MenuView.separators()).toHaveLength(3)

    fireEvent.click(MenuView.itemTitled('Remove…'))

    expect(onAction).toHaveBeenCalledWith('remove')
    expect(MenuView.isOpen()).toBe(false)
  })

  it('offers copying the folder only where there is a path to copy, and opening it regardless', () => {
    render(<MenuHost commands={new CommandRegistry()} facts={{ directoryPath: null }} />)

    expect(MenuView.titles()).not.toContain(titleOf('tab.copyProjectFolder'))
    // The open needs only the session, exactly as the tab menu asks only for a session's tab.
    expect(MenuView.titles()).toContain(titleOf('tab.openProjectFolder'))
  })

  /*
   * The four that open the create card need a place to open it ON. A session founded with no
   * directory at all - which only the control API can do - has none, so the block is absent rather
   * than drawn to refuse a moment later.
   */
  it('leaves out the whole start-beside block on a row with no directory', () => {
    render(<MenuHost commands={new CommandRegistry()} facts={{ directoryPath: null }} />)

    expect(MenuView.titles()).not.toContain(titleOf('session.newBeside'))
    expect(MenuView.titles()).not.toContain(titleOf('session.fork'))
    // Still the whole point of the row: naming it and reading it ask nothing of a directory.
    expect(MenuView.titles()).toContain(titleOf('session.details'))
  })

  /*
   * `session.newHere` belongs to a PROJECT row now. This menu's own "New session" knows the same
   * project and the row's name and agent besides, so the two drawn together were one item twice.
   */
  it('leaves the project row’s pre-bound launcher out of a session row’s menu', () => {
    render(<MenuHost commands={new CommandRegistry()} />)

    expect(MenuView.titles()).not.toContain(titleOf('session.newHere'))
    expect(MenuView.titles()).toContain(titleOf('session.newBeside'))
  })

  it('offers keeping the tab only on a plain-tab row', () => {
    render(<MenuHost commands={new CommandRegistry()} plainTab />)
    expect(MenuView.titles()).toContain(titleOf('tab.promote'))

    cleanup()
    render(<MenuHost commands={new CommandRegistry()} />)
    expect(MenuView.titles()).not.toContain(titleOf('tab.promote'))
  })

  // The whole reason this menu exists: the command acts on the CLICKED row's session, which may
  // have no tab open in this window, so the active-tab fallback would aim at the wrong session.
  it('runs the clicked command on the clicked session and closes', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(<MenuHost commands={commands} />)

    fireEvent.click(MenuView.itemTitled(titleOf('session.fork')))

    expect(execute.mock.calls).toEqual([['session.fork', { sessionId: 's1' }]])
    expect(MenuView.isOpen()).toBe(false)
  })

  it('sends the chosen colour and the clicked session as the command value', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(<MenuHost commands={commands} />)

    fireEvent.click(MenuView.colour('Teal'))

    expect(execute.mock.calls).toEqual([['session.setColor', { color: 'teal', sessionId: 's1' }]])
    expect(MenuView.isOpen()).toBe(false)
  })

  it('marks the colour the session already has', () => {
    render(<MenuHost commands={new CommandRegistry()} facts={{ color: 'rose' }} />)

    expect(MenuView.colour('Rose').className).toContain('is-current')

    const current = document.querySelectorAll('.jamat-context-menu__flyout .is-current')
    expect(current).toHaveLength(1)
  })
})
