import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListResult } from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import { LauncherFixtures } from '../fixtures/launcherFixtures'
import { type LauncherInput, LauncherModel, type LauncherState } from './launcherModel'
import { LauncherTime } from '../launcherTime'
import { LauncherProjectsScreen } from './launcherProjectsScreen'

describe('app-client-ui/renderer/overlays/launcher/launcherProjectsScreen', () => {
  const nowConst = Date.UTC(2026, 7, 5, 12, 0)

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function loaded(...inputs: readonly LauncherInput[]): LauncherState {
    let state = LauncherModel.initial(null).state
    const all: readonly LauncherInput[] = [
      { input: 'categoriesLoaded', categories: LauncherFixtures.categories() },
      {
        input: 'projectsLoaded',
        categoryId: 'nodejs',
        sort: 'recent',
        listing: LauncherFixtures.nodejs(),
      },
      ...inputs,
    ]
    for (const input of all)
      state = LauncherModel.transition(state, input).state
    return state
  }

  function draw(state: LauncherState) {
    const dispatch = vi.fn<(input: LauncherInput) => void>()
    const view = render(
      <LauncherProjectsScreen state={state} now={nowConst} dispatch={dispatch} />,
    )
    return { view, dispatch }
  }

  function rows(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('.jamat-launcher__row')]
  }

  function searched(text: string): LauncherState {
    return loaded(
      {
        input: 'projectsLoaded',
        categoryId: 'web',
        sort: 'recent',
        listing: LauncherFixtures.web(),
      },
      { input: 'searchOpen' },
      { input: 'searchChanged', text },
    )
  }

  function optionNames(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .map((option) => option.querySelector('.jamat-launcher__name')?.textContent ?? '')
  }

  // Whatever a key can reach, a click reaches through the same input: two paths into one model is
  // what keeps them from drifting apart.
  it('turns a click on a row into the cursor input a key would send', () => {
    const { view, dispatch } = draw(loaded())

    fireEvent.click(rows(view.container)[1])

    expect(dispatch).toHaveBeenCalledWith({ input: 'setCursor', index: 1 })
  })

  /**
   * The double click names the row it landed on rather than acting on wherever the cursor was, so
   * it cannot depend on the click that preceded it having moved the cursor first.
   */
  it('opens a row on a double click and never on a single one', () => {
    const { view, dispatch } = draw(loaded())

    fireEvent.click(rows(view.container)[0])
    expect(dispatch).not.toHaveBeenCalledWith({ input: 'openRow', index: 0 })

    fireEvent.doubleClick(rows(view.container)[1])
    expect(dispatch).toHaveBeenCalledWith({ input: 'openRow', index: 1 })
  })

  /**
   * The counts of a folder and of a project have to land in one column, and with a grid that means
   * landing in the same CHILD POSITION - jsdom lays nothing out, so the structure is what a test can
   * hold. A wrapper around the name is what keeps a search row's foreign category from taking the
   * column the counts want.
   */
  it('puts what a row counts in the same cell whatever the row is', () => {
    const { view } = draw(loaded())
    const cellsOf = (row: HTMLElement): string[] =>
      [...row.children].map((cell) =>
        cell.className.replace(/jamat-launcher(-projects)?__/, ''))

    const project = cellsOf(rows(view.container)[0])
    const folder = cellsOf(rows(view.container)[2])

    expect(project[0]).toBe('label')
    expect(folder[0]).toBe('label')
    expect(project[1]).toBe('meta')
    expect(folder[1]).toBe('meta')
  })

  it('keeps a foreign category inside the name cell rather than in a column of its own', () => {
    const { view } = draw(searched('jamat'))

    const foreign = rows(view.container)
      .find((row) => row.querySelector('.jamat-launcher-projects__foreign'))
    if (!foreign)
      throw new Error('The search drew no row from another category')
    expect(foreign.querySelector('.jamat-launcher-projects__label > .jamat-launcher-projects__foreign'))
      .toBeTruthy()
    expect([...foreign.children][1]?.className).toContain('jamat-launcher__meta')
  })

  it('opens a virtual folder row by its own index', () => {
    const { view, dispatch } = draw(loaded())

    fireEvent.doubleClick(rows(view.container)[2])

    expect(dispatch).toHaveBeenCalledWith({ input: 'openRow', index: 2 })
  })

  /**
   * The card is taller than the screen, and the cursor lands where the model puts it - on a created
   * project that sorted itself to the end, as well as on the row an arrow reached. A selected row
   * below the fold is a selection nobody can see they have.
   */
  it('brings the selected row into view', () => {
    const scrolled: Element[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function (this: Element): void {
        scrolled.push(this)
      })

    const { view } = draw(loaded({ input: 'setCursor', index: 2 }))

    expect(scrolled).toEqual([rows(view.container)[2]])
  })

  /** Up opens the filter, and it can only do that while the model knows the caret has left it. */
  it('reports the caret leaving the filter field', () => {
    const { view, dispatch } = draw(loaded({ input: 'searchOpen' }))
    const search = view.container.querySelector('.jamat-launcher__search')
    if (!(search instanceof HTMLInputElement))
      throw new Error('The screen drew no search field')

    fireEvent.blur(search)

    expect(dispatch).toHaveBeenCalledWith({ input: 'searchLeave' })
  })

  it('turns a click on a category tab into the same input the number key sends', () => {
    const { view, dispatch } = draw(loaded())

    fireEvent.click(view.container.querySelectorAll('[role="tab"]')[1])

    expect(dispatch).toHaveBeenCalledWith({ input: 'selectCategory', categoryId: 'web' })
  })

  it('marks a category whose root cannot be read right now', () => {
    const { view } = draw(loaded())
    const tabs = [...view.container.querySelectorAll('[role="tab"]')]

    expect(tabs[2].textContent).toContain('!')
    expect(tabs[2].getAttribute('title')).toContain('(unavailable)')
  })

  it('names the category of a row that came from another one', () => {
    const { view } = draw(searched('jamat'))

    const foreign = [...view.container.querySelectorAll('.jamat-launcher-projects__foreign')]
      .map((node) => node.textContent)
    expect(foreign).toEqual(['Web'])
  })

  it('draws the active results, Other folders and one tail in list order', () => {
    const { view } = draw(searched('jamat'))
    const listbox = view.container.querySelector('.jamat-launcher__rows')
    if (!(listbox instanceof HTMLElement))
      throw new Error('The screen drew no project list')
    const groups = [...listbox.querySelectorAll<HTMLElement>(':scope > [role="group"]')]

    expect(groups.map((group) => group.getAttribute('aria-label')))
      .toEqual(['NodeJs', 'Other folders'])
    expect([...groups[0].querySelectorAll('.jamat-launcher__name')]
      .map((node) => node.textContent)).toEqual(['AppJamat', 'AppJamatV3'])
    expect(groups[0].textContent).not.toContain('NodeJs')
    expect([...groups[1].querySelectorAll('.jamat-launcher__name')]
      .map((node) => node.textContent)).toEqual(['WebJamatAdmin'])
    const divider = groups[1].querySelector('.jamat-launcher-projects__other-folders')
    expect(divider?.textContent).toBe('Other folders')
    expect(divider?.closest('[role="option"]')).toBeNull()
    expect(optionNames(listbox)).toEqual([
      'AppJamat',
      'AppJamatV3',
      'WebJamatAdmin',
      'Pick folder…',
      'Root project (NodeJs)',
    ])
  })

  it('uses the global model index for a foreign result', () => {
    const { view, dispatch } = draw(searched('jamat'))
    const foreign = view.container
      .querySelector<HTMLElement>('[role="group"][aria-label="Other folders"] [role="option"]')
    if (!foreign)
      throw new Error('The search drew no foreign result')

    fireEvent.click(foreign)
    fireEvent.doubleClick(foreign)

    expect(dispatch).toHaveBeenCalledWith({ input: 'setCursor', index: 2 })
    expect(dispatch).toHaveBeenCalledWith({ input: 'openRow', index: 2 })
  })

  it('keeps empty search groups out of the cursor rows', () => {
    const localEmpty = draw(searched('portfolio'))
    const localGroups = [...localEmpty.view.container
      .querySelectorAll<HTMLElement>('.jamat-launcher__rows > [role="group"]')]

    expect(localGroups.map((group) => group.getAttribute('aria-label')))
      .toEqual(['NodeJs', 'Other folders'])
    expect(localGroups[0].querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(optionNames(localEmpty.view.container))
      .toEqual(['WebPortfolio', 'Pick folder…', 'Root project (NodeJs)'])

    cleanup()
    const foreignEmpty = draw(searched('v3'))
    expect(foreignEmpty.view.container.querySelectorAll(
      '.jamat-launcher__rows > [role="group"]',
    )).toHaveLength(1)
    expect(foreignEmpty.view.container
      .querySelector('.jamat-launcher-projects__other-folders')).toBeNull()
    expect(optionNames(foreignEmpty.view.container))
      .toEqual(['AppJamatV3', 'Pick folder…', 'Root project (NodeJs)'])
  })

  it('says so when the library could only answer with part of the list', () => {
    const state = loaded({
      input: 'projectsLoaded',
      categoryId: 'nodejs',
      sort: 'recent',
      listing: { ...LauncherFixtures.nodejs(), truncated: true },
    })
    const { view } = draw(state)

    expect(view.container.querySelector('.jamat-launcher__note')?.textContent)
      .toContain('truncated')
  })

  it('shows a refusal from the library word for word', () => {
    const state = loaded({
      input: 'loadFailed',
      detail: 'category-unavailable: C:/Projects/Ai cannot be read',
    })
    const { view } = draw(state)

    expect(view.container.querySelector('.jamat-launcher__error')?.textContent)
      .toBe('category-unavailable: C:/Projects/Ai cannot be read')
  })

  /**
   * The strip that asks for a new project's name is NOT this screen's to draw: the body scrolls, so
   * at the end of a long list it would open below the fold. The card draws it beside its key line -
   * `launcherOverlay.test.tsx` is where it is asserted, and this is here so its absence reads as the
   * decision it is rather than as a gap.
   */
  it('leaves the strip that names a new project to the card', () => {
    const { view } = draw(loaded({ input: 'newProjectStart' }))

    expect(view.container.querySelector('.jamat-launcher-manage')).toBeNull()
  })

  /**
   * Two folders may carry one prefix: the configuration tab warns about the pair and saves it, and
   * the launcher has to draw both. Keyed by the prefix alone they were one key to React, which is a
   * list with one of its children missing on the next update.
   */
  it('draws a row each for two folders that share a prefix', () => {
    const complaints: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      complaints.push(args.map((argument) => String(argument)).join(' '))
    })
    const old = {
      name: 'archive/AppOld',
      path: 'C:\\Projects\\NodeJs\\archive\\AppOld',
      lastActivity: null,
    }
    const shared: ProjectListResult = {
      entries: [
        { kind: 'virtualFolder', prefix: 'archive/', title: 'Archive', children: [old] },
        { kind: 'virtualFolder', prefix: 'archive/', title: 'Older still', children: [old] },
      ],
      projects: [old],
      virtualFolders: [
        { prefix: 'archive/', title: 'Archive' },
        { prefix: 'archive/', title: 'Older still' },
      ],
      truncated: false,
      available: true,
    }
    const { view } = draw(loaded({
      input: 'projectsLoaded',
      categoryId: 'nodejs',
      sort: 'recent',
      listing: shared,
    }))

    expect([...view.container.querySelectorAll('.jamat-launcher__name')]
      .map((node) => node.textContent).slice(0, 2))
      .toEqual(['▸ Archive', '▸ Older still'])
    expect(complaints.join('\n')).not.toContain('same key')
  })

  describe('inside a virtual folder', () => {
    function names(container: HTMLElement): string[] {
      return [...container.querySelectorAll('.jamat-launcher__name')]
        .map((node) => node.textContent ?? '')
    }

    function drilled(...inputs: readonly LauncherInput[]): LauncherState {
      return loaded({ input: 'setCursor', index: 2 }, { input: 'activate' }, ...inputs)
    }

    it('draws no breadcrumb at the root of a category', () => {
      const { view } = draw(loaded())

      expect(view.container.querySelector('.jamat-launcher-projects__breadcrumb')).toBeNull()
      expect(names(view.container)).toContain('AppJamat')
    })

    it('says where the list is standing and how to leave', () => {
      const { view } = draw(drilled())

      const breadcrumb = view.container.querySelector('.jamat-launcher-projects__breadcrumb')
      expect(breadcrumb?.textContent).toContain('NodeJs › archive')
      expect(breadcrumb?.textContent).toContain('Backspace leaves')
    })

    // The prefix is the folder, and the folder is the line above the list.
    it('draws the names without the prefix that named the folder', () => {
      const { view } = draw(drilled())

      // The tail rows are the same three under every filter and carry no project name.
      expect(names(view.container).slice(0, 2)).toEqual(['AppOld', 'BotLegacy'])
      cleanup()

      const atRoot = draw(loaded())
      expect(names(atRoot.view.container).slice(0, 2)).toEqual(['AppJamat', 'AppJamatV3'])
    })

    /**
     * A filter is flat over every category the launcher has fetched, so the list under it stands in
     * no folder: the breadcrumb goes with it, and the rows read as the directories they are. The
     * folder is still where the cursor was - Escape brings the list back into it.
     */
    it('drops the breadcrumb and the shortened names while a filter is on', () => {
      const { view } = draw(drilled(
        { input: 'searchOpen' },
        { input: 'searchChanged', text: 'bot' },
      ))

      expect(view.container.querySelector('.jamat-launcher-projects__breadcrumb')).toBeNull()
      expect(names(view.container).slice(0, 1)).toEqual(['archive/BotLegacy'])
    })

    /**
     * The row shows a short name and the operations behind it still carry the directory. A rename
     * that seeded itself from what is drawn would quietly move the project out of its folder.
     */
    it('opens a row on its directory name, not on the name it shows', () => {
      const { view, dispatch } = draw(drilled())

      fireEvent.doubleClick(rows(view.container)[0])

      expect(dispatch).toHaveBeenCalledWith({ input: 'openRow', index: 0 })
      expect(names(view.container)[0]).toBe('AppOld')
    })
  })

  it('reads a time as how long ago it was, and an unknown one as nothing', () => {
    expect(LauncherTime.agoOf(null, nowConst)).toBe('')
    expect(LauncherTime.agoOf(nowConst - 30_000, nowConst)).toBe('just now')
    expect(LauncherTime.agoOf(nowConst - 4 * 60_000, nowConst)).toBe('4 min ago')
    expect(LauncherTime.agoOf(nowConst - 3 * 3_600_000, nowConst)).toBe('3 h ago')
    expect(LauncherTime.agoOf(nowConst - 30 * 3_600_000, nowConst)).toBe('yesterday')
    expect(LauncherTime.agoOf(nowConst - 3 * 86_400_000, nowConst)).toBe('3 days ago')
    expect(LauncherTime.agoOf(Date.UTC(2026, 2, 14), nowConst)).toBe('2026-03-14')
  })
})
