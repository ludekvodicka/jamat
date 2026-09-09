import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppCommands, type CommandId } from '../../../shared/commands'
import { CommandRegistry } from '../../commands/commandRegistry'
import {
  type GroupRowFacts,
  SessionsTreeGroupItems,
  SessionsTreeGroupMenu,
} from './sessionsTreeGroupMenu'

function titleOf(id: CommandId): string {
  const descriptor = AppCommands.all().find((candidate) => candidate.id === id)
  if (!descriptor)
    throw new Error(`The catalog holds no command ${JSON.stringify(id)}`)
  return descriptor.title
}

const projectConst = {
  kind: 'project',
  categoryId: 'nodejs',
  projectName: 'AppJamatV3',
  projectPath: 'C:/Projects/NodeJs/AppJamatV3',
} as const

/** An ordinary project row: it names a place AND holds a folder. */
const projectRowConst: GroupRowFacts = {
  place: { kind: 'project', project: projectConst },
  folder: { path: 'C:/Projects/NodeJs/AppJamatV3', sessionId: 's1' },
}

const categoryRowConst: GroupRowFacts = {
  place: { kind: 'category', categoryId: 'nodejs' },
  folder: null,
}

function MenuHost(props: {
  commands: CommandRegistry
  facts: GroupRowFacts
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  if (!open)
    return <div data-testid="closed" />
  return (
    <SessionsTreeGroupMenu
      position={{ x: 10, y: 20 }}
      commands={props.commands}
      facts={props.facts}
      onClose={() => setOpen(false)}
    />
  )
}

class MenuView {
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
}

describe('app-client-ui/renderer/views/sessionsTree/sessionsTreeGroupMenu', () => {
  afterEach(() => vi.restoreAllMocks())

  // Nothing session-scoped reaches this menu: the surface is what keeps it out, not a filter here.
  it('shows the place and folder commands on a project row, in catalog order', () => {
    render(<MenuHost commands={new CommandRegistry()} facts={projectRowConst} />)

    expect(MenuView.titles()).toEqual([
      'New session…',
      'Open project folder',
      'Copy project folder',
      'Worktree setup…',
    ])
    expect(MenuView.titles()).not.toContain(titleOf('session.details'))
    expect(MenuView.titles()).not.toContain(titleOf('session.fork'))
    // The place | the folder.
    expect(MenuView.separators()).toHaveLength(1)
  })

  // A category is a place and not a directory: there is no one folder behind it to open.
  it('shows only the place command on a category row', () => {
    render(<MenuHost commands={new CommandRegistry()} facts={categoryRowConst} />)

    expect(MenuView.titles()).toEqual(['New session…'])
    expect(MenuView.separators()).toHaveLength(0)
  })

  // An ad-hoc directory belongs to no category, so there is nothing for the launcher to pre-bind to.
  it('shows only the folder commands on a project row the catalog does not name', () => {
    render(
      <MenuHost
        commands={new CommandRegistry()}
        facts={{ ...projectRowConst, place: null }}
      />,
    )

    expect(MenuView.titles()).toEqual(['Open project folder', 'Copy project folder'])
  })

  /**
   * The AD-HOC and NO PROJECT roots, which name no category and hold no path. The view asks this
   * before it opens anything, so a right-click there draws nothing rather than an empty box.
   */
  it('offers nothing at all for a row with neither a place nor a folder', () => {
    expect(SessionsTreeGroupItems.any({ place: null, folder: null })).toBe(false)
    expect(SessionsTreeGroupItems.any(categoryRowConst)).toBe(true)
    expect(SessionsTreeGroupItems.any({ ...projectRowConst, place: null })).toBe(true)
  })

  it('sends the project as the place of a new session, and closes', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(<MenuHost commands={commands} facts={projectRowConst} />)

    fireEvent.click(MenuView.itemTitled(titleOf('session.newHere')))

    expect(execute.mock.calls).toEqual([
      ['session.newHere', { place: { kind: 'project', project: projectConst } }],
    ])
    expect(MenuView.isOpen()).toBe(false)
  })

  // Half of what a project row sends, which is the whole point of a menu on the row above it.
  it('sends the category alone from a category row', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(<MenuHost commands={commands} facts={categoryRowConst} />)

    fireEvent.click(MenuView.itemTitled(titleOf('session.newHere')))

    expect(execute.mock.calls).toEqual([
      ['session.newHere', { place: { kind: 'category', categoryId: 'nodejs' } }],
    ])
  })

  // The path is the row's own, and the session only what the directory grant is proved against.
  it('sends the row path with a session to prove it, and the path alone to the clipboard', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(<MenuHost commands={commands} facts={projectRowConst} />)

    fireEvent.click(MenuView.itemTitled(titleOf('project.openFolder')))
    expect(execute.mock.calls).toEqual([
      ['project.openFolder', { path: 'C:/Projects/NodeJs/AppJamatV3', sessionId: 's1' }],
    ])

    cleanup()
    execute.mockClear()
    render(<MenuHost commands={commands} facts={projectRowConst} />)

    fireEvent.click(MenuView.itemTitled(titleOf('project.copyFolderPath')))
    expect(execute.mock.calls).toEqual([
      ['project.copyFolderPath', { path: 'C:/Projects/NodeJs/AppJamatV3' }],
    ])
  })

  /* The whole project and not just its path: the settings card names it as well as reads its file. */
  it('sends the whole project to the worktree setup, and offers it on no category row', () => {
    const commands = new CommandRegistry()
    const execute = vi.spyOn(commands, 'execute')
    render(<MenuHost commands={commands} facts={projectRowConst} />)

    fireEvent.click(MenuView.itemTitled(titleOf('project.worktreeSetup')))
    expect(execute.mock.calls).toEqual([['project.worktreeSetup', { project: projectConst }]])

    cleanup()
    render(<MenuHost commands={commands} facts={categoryRowConst} />)
    expect(MenuView.titles()).not.toContain(titleOf('project.worktreeSetup'))
  })
})
