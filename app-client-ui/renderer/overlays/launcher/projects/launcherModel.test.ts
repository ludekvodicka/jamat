import { describe, expect, it } from 'vitest'

import type { ProjectListResult } from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import { LauncherFixtures } from '../fixtures/launcherFixtures'
import {
  type LauncherEffect,
  type LauncherInput,
  LauncherModel,
  type LauncherRow,
  type LauncherState,
} from './launcherModel'

describe('app-client-ui/renderer/overlays/launcher/launcherModel', () => {
  const remoteTargetConst = { remoteEndpointId: 'endpoint-a', displayName: 'Studio' }

  /** Feeds inputs in order and hands back the last step, so a test reads as the path a user took. */
  class Run {
    private constructor(
      readonly state: LauncherState,
      readonly effects: readonly LauncherEffect[],
    ) {}

    static remote(): Run {
      return Run.from(LauncherModel.initial(null, remoteTargetConst).state)
        .then({ input: 'categoriesLoaded', categories: LauncherFixtures.categories() })
        .then({
          input: 'projectsLoaded',
          categoryId: 'nodejs',
          sort: 'recent',
          listing: LauncherFixtures.nodejs(),
        })
    }

    static loaded(): Run {
      return Run.from(LauncherModel.initial(null).state)
        .then({ input: 'categoriesLoaded', categories: LauncherFixtures.categories() })
        .then({
          input: 'projectsLoaded',
          categoryId: 'nodejs',
          sort: 'recent',
          listing: LauncherFixtures.nodejs(),
        })
    }

    static from(state: LauncherState): Run {
      return new Run(state, [])
    }

    then(...inputs: readonly LauncherInput[]): Run {
      let state = this.state
      let effects: readonly LauncherEffect[] = []
      for (const input of inputs) {
        const step = LauncherModel.transition(state, input)
        state = step.state
        effects = step.effects
      }
      return new Run(state, effects)
    }

    rows(): readonly LauncherRow[] {
      return LauncherModel.rowsOf(this.state)
    }

    /**
     * Puts the cursor on the first row of a kind. By kind rather than by index, because the tail
     * grows: a row added to it used to renumber every test that reached one of the others.
     */
    on(kind: LauncherRow['kind']): Run {
      const index = this.rows().findIndex((row) => row.kind === kind)
      if (index < 0)
        throw new Error(`No ${kind} row is drawn`)
      return this.then({ input: 'setCursor', index })
    }

    /** What the cursor stands on, named the way a person reads the screen. */
    at(): string {
      const row = this.rows()[this.state.cursor]
      if (!row)
        throw new Error(`The cursor stands on nothing: ${this.state.cursor}`)
      if (row.kind === 'project')
        return row.project.name
      else if (row.kind === 'virtualFolder')
        return row.title
      else if (row.kind === 'pickFolder')
        return 'Pick folder'
      else if (row.kind === 'categoryRoot')
        return row.label
      else
        throw new Error(`Unknown launcher row: ${JSON.stringify(row)}`)
    }
  }

  function crowded(): ProjectListResult {
    const seed = LauncherFixtures.nodejs().projects[0]
    if (!seed)
      throw new Error('The node fixture has no seed project')
    const projects = Array.from({ length: 10 }, (_, index) => ({
      ...seed,
      name: `JamatLocal${index}`,
      path: `C:\\Projects\\NodeJs\\JamatLocal${index}`,
    }))
    return {
      entries: projects.map((project) => ({ kind: 'project', project })),
      projects,
      virtualFolders: [],
      truncated: false,
      available: true,
    }
  }

  it('asks for the categories before anything else', () => {
    expect(LauncherModel.initial(null).effects).toEqual([{ effect: 'fetchCategories', remoteEndpointId: null }])
  })

  it('lands on the first category and asks for its projects', () => {
    const run = Run.from(LauncherModel.initial(null).state)
      .then({ input: 'categoriesLoaded', categories: LauncherFixtures.categories() })

    expect(run.state.activeCategoryId).toBe('nodejs')
    expect(run.effects).toEqual([{ effect: 'fetchProjects', categoryId: 'nodejs', sort: 'recent', remoteEndpointId: null }])
  })

  /**
   * What a category row of the sessions tree asks for, from its button and its context menu alike.
   * Seeded rather than dispatched, so the listing is fetched once - for the category asked for,
   * never for the first.
   */
  it('stands in the category an opener asked for and asks for its projects', () => {
    const run = Run.from(LauncherModel.initial('web').state)
      .then({ input: 'categoriesLoaded', categories: LauncherFixtures.categories() })

    expect(run.state.activeCategoryId).toBe('web')
    expect(run.effects).toEqual([{ effect: 'fetchProjects', categoryId: 'web', sort: 'recent', remoteEndpointId: null }])
  })

  // A category that has been retired since the row was drawn is not a reason to open on nothing.
  it('falls back to the first category when the one asked for is gone', () => {
    const run = Run.from(LauncherModel.initial('retired').state)
      .then({ input: 'categoriesLoaded', categories: LauncherFixtures.categories() })

    expect(run.state.activeCategoryId).toBe('nodejs')
    expect(run.state.newProject).toBeNull()
  })

  it('draws the grouped listing plus the tail rows', () => {
    const run = Run.loaded()

    expect(run.rows().map((row) => row.kind))
      .toEqual(['project', 'project', 'virtualFolder', 'pickFolder', 'categoryRoot'])
  })

  it('draws every project flat once the grouping is off', () => {
    const run = Run.loaded().then({ input: 'toggleView' })

    expect(run.rows().map((row) => row.kind))
      .toEqual(['project', 'project', 'project', 'project', 'pickFolder', 'categoryRoot'])
  })

  // A category is a place, and coming back to it should be coming back to where you were.
  it('remembers the cursor per category and starts an unvisited one at the top', () => {
    const run = Run.loaded()
      .then({ input: 'setCursor', index: 2 })
      .then({ input: 'selectCategory', categoryId: 'web' })

    expect(run.state.cursor).toBe(0)

    const back = run
      .then({
        input: 'projectsLoaded',
        categoryId: 'web',
        sort: 'recent',
        listing: LauncherFixtures.web(),
      })
      .then({ input: 'selectCategory', categoryId: 'nodejs' })

    expect(back.state.cursor).toBe(2)
  })

  it('enters a virtual folder and leaves it on backspace', () => {
    const inside = Run.loaded()
      .then({ input: 'setCursor', index: 2 }, { input: 'activate' })

    expect(inside.state.virtualFolderPrefix).toBe('archive/')
    expect(inside.rows().map((row) => row.kind))
      .toEqual(['project', 'project', 'pickFolder', 'categoryRoot'])
    expect(inside.at()).toBe('archive/AppOld')

    const outside = inside.then({ input: 'backspace' })

    expect(outside.state.virtualFolderPrefix).toBeNull()
    expect(outside.state.cursor).toBe(0)
  })

  // The listing under the cursor can shrink at any time; an index kept beside it must not point past
  // the end of what is drawn.
  it('never leaves the cursor outside the rows it can stand on', () => {
    const run = Run.loaded()
      .then({ input: 'setCursor', index: 99 })

    expect(run.state.cursor).toBe(run.rows().length - 1)
    expect(Run.from(run.state).then({ input: 'moveCursor', delta: -99 }).state.cursor).toBe(0)
  })

  /**
   * There is nothing above the first row in the list, and the filter is what is above it on screen.
   * Without this the field is reachable only with the mouse.
   */
  it('opens the filter when Up is pressed on the first row', () => {
    const run = Run.loaded().then({ input: 'moveCursor', delta: -1 })

    expect(run.state.search.active).toBe(true)
    expect(run.state.cursor).toBe(0)
    expect(run.effects).toEqual([
      { effect: 'fetchProjects', categoryId: 'web', sort: 'recent', remoteEndpointId: null },
      { effect: 'fetchProjects', categoryId: 'ai', sort: 'recent', remoteEndpointId: null },
    ])
  })

  /**
   * The field is left by the arrow that goes back into the list, and it has to be openable again.
   * While leaving it changed nothing, the second Up produced the same state as the first, the effect
   * that puts the caret in the field never fired again, and the filter was reachable exactly once.
   */
  it('lets Up open the filter again after the arrow that left it', () => {
    const left = Run.loaded()
      .then({ input: 'moveCursor', delta: -1 }, { input: 'searchLeave' })
    expect(left.state.search.active).toBe(false)

    expect(left.then({ input: 'moveCursor', delta: -1 }).state.search.active).toBe(true)
  })

  /** Leaving the field is about the caret, not about the filter: what was typed goes on filtering. */
  it('keeps what was typed when the field is left', () => {
    const run = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'v3' }, { input: 'searchLeave' })

    expect(run.state.search).toEqual({ active: false, text: 'v3' })
    expect(run.rows().flatMap((row) => (row.kind === 'project' ? [row.project.name] : [])))
      .toEqual(['AppJamatV3'])
  })

  it('moves inside the list from anywhere else', () => {
    const run = Run.loaded().then({ input: 'setCursor', index: 2 }, { input: 'moveCursor', delta: -1 })

    expect(run.state.search.active).toBe(false)
    expect(run.state.cursor).toBe(1)
  })

  it('jumps to the next project starting with the letter and cycles on a repeat', () => {
    const first = Run.loaded().then({ input: 'typed', character: 'a' })
    expect(first.at()).toBe('AppJamatV3')

    const second = first.then({ input: 'typed', character: 'a' })
    expect(second.at()).toBe('archive')

    const wrapped = second.then({ input: 'typed', character: 'a' })
    expect(wrapped.at()).toBe('AppJamat')
  })

  /**
   * By what is drawn, as in V1: inside "archive" the rows read `AppOld` and `BotLegacy`, so `b` is
   * what jumps to the second. Matching the directory name would mean typing the prefix every row in
   * the folder shares, which reaches nothing.
   */
  it('jumps by the name a row shows inside a folder, not by its directory', () => {
    const inside = Run.loaded().then({ input: 'setCursor', index: 2 }, { input: 'activate' })
    expect(inside.at()).toBe('archive/AppOld')

    const jumped = inside.then({ input: 'typed', character: 'b' })

    expect(jumped.at()).toBe('archive/BotLegacy')
    // `a` is the first letter of the directory name and of nothing that is drawn.
    expect(jumped.then({ input: 'typed', character: 'a' }).at()).toBe('archive/AppOld')
  })

  /**
   * A filter is flat over every category already fetched, so most of what it draws is in no folder
   * at all and a row shortened by the folder's prefix would claim a membership the grouping refused.
   * The folder itself stays in the state: Escape and Backspace peel the search first and the folder
   * after it, in the order they were entered.
   */
  it('stops shortening the rows by the folder while a filter is on, without leaving it', () => {
    const inside = Run.loaded().then({ input: 'setCursor', index: 2 }, { input: 'activate' })
    expect(LauncherModel.labelPrefixOf(inside.state)).toBe('archive/')

    const filtering = inside.then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'app' })

    expect(LauncherModel.labelPrefixOf(filtering.state)).toBeNull()
    expect(filtering.state.virtualFolderPrefix).toBe('archive/')
  })

  it('types into the search field instead of jumping once search is open', () => {
    const run = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'typed', character: 'j' }, { input: 'typed', character: 'a' })

    expect(run.state.search).toEqual({ active: true, text: 'ja' })
    expect(run.rows().map((row) => row.kind))
      .toEqual(['project', 'project', 'pickFolder', 'categoryRoot'])
  })

  it('requests every foreign category once when search opens', () => {
    const loaded = Run.from(LauncherModel.initial(null).state)
      .then({ input: 'categoriesLoaded', categories: LauncherFixtures.categories() })
      .then({ input: 'projectsLoaded', categoryId: 'nodejs', sort: 'recent', listing: crowded() })

    const opened = loaded.then({ input: 'searchOpen' })

    expect(opened.effects).toEqual([
      { effect: 'fetchProjects', categoryId: 'web', sort: 'recent', remoteEndpointId: null },
      { effect: 'fetchProjects', categoryId: 'ai', sort: 'recent', remoteEndpointId: null },
    ])
    expect(opened.state.searchRequests.size).toBe(2)
    expect(opened.then({ input: 'searchOpen' }).effects).toEqual([])
  })

  it('requests the active and foreign listings when search opened before the catalog arrived', () => {
    const opened = Run.from(LauncherModel.initial(null).state).then({ input: 'searchOpen' })

    expect(opened.effects).toEqual([])

    const loaded = opened.then({
      input: 'categoriesLoaded',
      categories: LauncherFixtures.categories(),
    })

    expect(loaded.effects).toEqual([
      { effect: 'fetchProjects', categoryId: 'nodejs', sort: 'recent', remoteEndpointId: null },
      { effect: 'fetchProjects', categoryId: 'web', sort: 'recent', remoteEndpointId: null },
      { effect: 'fetchProjects', categoryId: 'ai', sort: 'recent', remoteEndpointId: null },
    ])
  })

  it('always returns current matches first and foreign matches in catalog order', () => {
    const run = Run.loaded()
      .then({
        input: 'projectsLoaded',
        categoryId: 'web',
        sort: 'recent',
        listing: LauncherFixtures.web(),
      })
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'jamat' })

    const results = LauncherModel.searchResultsOf(run.state)
    expect(results?.current.map((row) => row.project.name)).toEqual(['AppJamat', 'AppJamatV3'])
    expect(results?.other.map((row) => row.project.name)).toEqual(['WebJamatAdmin'])
  })

  it('keeps foreign matches after ten current matches', () => {
    const run = Run.from(LauncherModel.initial(null).state)
      .then({ input: 'categoriesLoaded', categories: LauncherFixtures.categories() })
      .then({ input: 'projectsLoaded', categoryId: 'nodejs', sort: 'recent', listing: crowded() })
      .then({
        input: 'projectsLoaded',
        categoryId: 'web',
        sort: 'recent',
        listing: LauncherFixtures.web(),
      })
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'jamat' })

    const results = LauncherModel.searchResultsOf(run.state)
    expect(results?.current).toHaveLength(10)
    expect(results?.other.map((row) => row.project.name)).toEqual(['WebJamatAdmin'])
  })

  it('orders foreign results by the catalog rather than by response arrival', () => {
    const searching = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'web' })
    const aiFirst = searching.then({
      input: 'projectsLoaded',
      categoryId: 'ai',
      sort: 'recent',
      listing: LauncherFixtures.web(),
    })
    const webSecond = aiFirst.then({
      input: 'projectsLoaded',
      categoryId: 'web',
      sort: 'recent',
      listing: LauncherFixtures.web(),
    })

    expect(LauncherModel.searchResultsOf(webSecond.state)?.other.map((row) => row.categoryId))
      .toEqual(['web', 'web', 'ai', 'ai'])
  })

  it('reaches into no category it has not fetched', () => {
    const run = Run.loaded().then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'jamat' })

    const categories = new Set(run.rows()
      .flatMap((row) => (row.kind === 'project' ? [row.categoryId] : [])))
    expect([...categories]).toEqual(['nodejs'])
  })

  it('takes the search back one character at a time and then closes it', () => {
    const run = Run.loaded().then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'ja' })

    const shorter = run.then({ input: 'backspace' })
    expect(shorter.state.search).toEqual({ active: true, text: 'j' })

    const closed = shorter.then({ input: 'backspace' }, { input: 'backspace' })
    expect(closed.state.search).toEqual({ active: false, text: '' })
  })

  it('creates a project into the folder the list is standing in', () => {
    const run = Run.loaded()
      .then({ input: 'setCursor', index: 2 }, { input: 'activate' })
      .then({ input: 'newProjectStart' })

    expect(run.state.newProject).toEqual({ name: '' })

    const created = run
      .then({ input: 'newProjectChanged', name: 'AppNew' }, { input: 'activate' })

    expect(created.effects).toEqual([{
      effect: 'createProject',
      categoryId: 'nodejs',
      name: 'AppNew',
      virtualFolderPrefix: 'archive/',
    }])
  })

  it('creates nothing from a name that is only spaces', () => {
    const run = Run.loaded()
      .then({ input: 'newProjectStart' })
      .then({ input: 'newProjectChanged', name: '   ' }, { input: 'activate' })

    expect(run.effects).toEqual([])
    expect(run.state.newProject).toEqual({ name: '   ' })
  })

  /**
   * V1 read Escape the same way: it left the virtual folder if you were in one, and quit only if you
   * were not. Closing the whole card from inside a folder loses the place you were standing in.
   */
  describe('escape peels one layer at a time', () => {
    it('leaves a virtual folder before it closes anything', () => {
      const inside = Run.loaded().then({ input: 'setCursor', index: 2 }, { input: 'activate' })

      const out = inside.then({ input: 'escape' })

      expect(out.state.virtualFolderPrefix).toBeNull()
      expect(out.effects).toEqual([])

      expect(out.then({ input: 'escape' }).effects).toEqual([{ effect: 'close' }])
    })

    it('closes a search before it leaves the folder the search was made in', () => {
      const searching = Run.loaded()
        .then({ input: 'setCursor', index: 2 }, { input: 'activate' })
        .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'bot' })

      const closed = searching.then({ input: 'escape' })

      expect(closed.state.search).toEqual({ active: false, text: '' })
      expect(closed.state.virtualFolderPrefix).toBe('archive/')
      expect(closed.effects).toEqual([])
    })

    it('closes the card from the root of a category', () => {
      expect(Run.loaded().then({ input: 'escape' }).effects).toEqual([{ effect: 'close' }])
    })
  })

  // Escape peels one layer: a mistyped project name must not cost the whole surface.
  it('cancels the edit on escape and closes only on the next one', () => {
    const editing = Run.loaded().then({ input: 'newProjectStart' })

    const cancelled = editing.then({ input: 'escape' })
    expect(cancelled.state.newProject).toBeNull()
    expect(cancelled.effects).toEqual([])

    expect(cancelled.then({ input: 'escape' }).effects).toEqual([{ effect: 'close' }])
  })

  it('puts the cursor on the project it just created', () => {
    const listing = LauncherFixtures.nodejs()
    const withNew = {
      ...listing,
      entries: [...listing.entries, {
        kind: 'project' as const,
        project: { name: 'AppNew', path: 'C:/Projects/NodeJs/AppNew', lastActivity: null },
      }],
    }
    const run = Run.loaded()
      .then({ input: 'projectCreated', categoryId: 'nodejs', name: 'AppNew' })

    expect(run.effects).toEqual([{ effect: 'fetchProjects', categoryId: 'nodejs', sort: 'recent', remoteEndpointId: null }])

    const listed = run.then({
      input: 'projectsLoaded',
      categoryId: 'nodejs',
      sort: 'recent',
      listing: withNew,
    })
    expect(listed.at()).toBe('AppNew')
    expect(listed.state.focusName).toBeNull()
  })

  it('re-asks the library for the order instead of sorting what it already drew', () => {
    const run = Run.loaded().then({ input: 'cycleSort' })

    expect(run.state.sort).toBe('alpha')
    expect(run.effects).toEqual([{ effect: 'fetchProjects', categoryId: 'nodejs', sort: 'alpha', remoteEndpointId: null }])
    expect(run.at()).toBe('AppJamat')
  })

  it('re-asks every category for a new search sort and ignores the old answer', () => {
    const searching = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'jamat' })
    const sorted = searching.then({ input: 'cycleSort' })

    expect(sorted.effects).toEqual([
      { effect: 'fetchProjects', categoryId: 'nodejs', sort: 'alpha', remoteEndpointId: null },
      { effect: 'fetchProjects', categoryId: 'web', sort: 'alpha', remoteEndpointId: null },
      { effect: 'fetchProjects', categoryId: 'ai', sort: 'alpha', remoteEndpointId: null },
    ])
    expect(LauncherModel.searchResultsOf(sorted.state)?.current).toEqual([])

    const stale = sorted.then({
      input: 'projectsLoaded',
      categoryId: 'nodejs',
      sort: 'recent',
      listing: LauncherFixtures.web(),
    })

    expect(LauncherModel.searchResultsOf(stale.state)?.current).toEqual([])
    expect(stale.state.cursor).toBe(sorted.state.cursor)

    const current = stale.then({
      input: 'projectsLoaded',
      categoryId: 'nodejs',
      sort: 'alpha',
      listing: LauncherFixtures.nodejs(),
    })
    expect(LauncherModel.searchResultsOf(current.state)?.current.map((row) => row.project.name))
      .toEqual(['AppJamat', 'AppJamatV3'])
  })

  it('requests each foreign category and sort once and keeps an answer for a later sort', () => {
    const searching = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'jamat' })
    const alpha = searching.then({ input: 'cycleSort' })
    const recentAgain = alpha.then({ input: 'cycleSort' })

    expect(recentAgain.effects).toEqual([
      { effect: 'fetchProjects', categoryId: 'nodejs', sort: 'recent', remoteEndpointId: null },
    ])

    const alphaWeb = recentAgain.then({
      input: 'projectsLoaded',
      categoryId: 'web',
      sort: 'alpha',
      listing: LauncherFixtures.web(),
    })
    const alphaAgain = alphaWeb.then({ input: 'cycleSort' })

    expect(alphaAgain.effects).toEqual([
      { effect: 'fetchProjects', categoryId: 'nodejs', sort: 'alpha', remoteEndpointId: null },
    ])
    expect(LauncherModel.searchResultsOf(alphaAgain.state)?.other.map((row) => row.project.name))
      .toEqual(['WebJamatAdmin'])
  })

  it('keeps the searched project targeted while its new sort loads', () => {
    const searching = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'jamat' })
      .then({ input: 'setCursor', index: 1 })
    expect(searching.at()).toBe('AppJamatV3')

    const sorted = searching.then({ input: 'cycleSort' })
    const listing = LauncherFixtures.nodejs()
    const loaded = sorted.then({
      input: 'projectsLoaded',
      categoryId: 'nodejs',
      sort: 'alpha',
      listing: { ...listing, projects: [...listing.projects].reverse() },
    })

    expect(loaded.at()).toBe('AppJamatV3')
  })

  it('lets a newer search change replace the project held through a sort load', () => {
    const searching = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'jamat' })
      .then({ input: 'setCursor', index: 1 })
    const sorted = searching.then({ input: 'cycleSort' })
    const response = {
      input: 'projectsLoaded' as const,
      categoryId: 'nodejs',
      sort: 'alpha' as const,
      listing: LauncherFixtures.nodejs(),
    }

    const responseFirst = sorted
      .then(response)
      .then({ input: 'searchChanged', text: 'app' })
    const typingFirst = sorted
      .then({ input: 'searchChanged', text: 'app' })
      .then(response)

    expect(responseFirst.at()).toBe('AppJamat')
    expect(typingFirst.at()).toBe('AppJamat')
  })

  it('keeps project listing failures on their category and sort', () => {
    const searching = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'jamat' })
      .then({
        input: 'projectsLoadFailed',
        categoryId: 'web',
        sort: 'recent',
        detail: 'web failed',
      })

    expect(LauncherModel.loadErrorOf(searching.state)).toBe('web failed')

    const unrelatedSuccess = searching.then({
      input: 'projectsLoaded',
      categoryId: 'ai',
      sort: 'recent',
      listing: LauncherFixtures.web(),
    })
    expect(LauncherModel.loadErrorOf(unrelatedSuccess.state)).toBe('web failed')

    const alpha = unrelatedSuccess.then({ input: 'cycleSort' })
    expect(LauncherModel.loadErrorOf(alpha.state)).toBeNull()

    const staleFailure = alpha.then({
      input: 'projectsLoadFailed',
      categoryId: 'ai',
      sort: 'recent',
      detail: 'old recent failed',
    })
    expect(LauncherModel.loadErrorOf(staleFailure.state)).toBeNull()

    const currentFailure = staleFailure.then({
      input: 'projectsLoadFailed',
      categoryId: 'ai',
      sort: 'alpha',
      detail: 'alpha failed',
    })
    expect(LauncherModel.loadErrorOf(currentFailure.state)).toBe('alpha failed')

    const recovered = currentFailure.then({
      input: 'projectsLoaded',
      categoryId: 'ai',
      sort: 'alpha',
      listing: LauncherFixtures.web(),
    })
    expect(LauncherModel.loadErrorOf(recovered.state)).toBeNull()
  })

  it('keeps a foreign project selected when an earlier foreign category arrives', () => {
    const aiFirst = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'web' })
      .then({
        input: 'projectsLoaded',
        categoryId: 'ai',
        sort: 'recent',
        listing: LauncherFixtures.web(),
      })
      .then({ input: 'setCursor', index: 0 })

    const webSecond = aiFirst.then({
      input: 'projectsLoaded',
      categoryId: 'web',
      sort: 'recent',
      listing: LauncherFixtures.web(),
    })
    const selected = webSecond.rows()[webSecond.state.cursor]

    expect(selected).toMatchObject({
      kind: 'project',
      categoryId: 'ai',
      project: { name: 'WebJamatAdmin' },
    })
  })

  it('keeps either tail row selected when foreign results arrive before it', () => {
    const aiFirst = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'web' })
      .then({
        input: 'projectsLoaded',
        categoryId: 'ai',
        sort: 'recent',
        listing: LauncherFixtures.web(),
      })

    for (const kind of ['pickFolder', 'categoryRoot'] as const) {
      const webSecond = aiFirst.on(kind).then({
        input: 'projectsLoaded',
        categoryId: 'web',
        sort: 'recent',
        listing: LauncherFixtures.web(),
      })
      expect(webSecond.rows()[webSecond.state.cursor]?.kind).toBe(kind)
    }
  })

  it('names where a session would run and decides nothing else', () => {
    const run = Run.loaded().then({ input: 'setCursor', index: 0 }, { input: 'activate' })

    expect(run.effects).toEqual([{
      effect: 'bindingChosen',
      binding: {
        mode: 'project',
        categoryId: 'nodejs',
        projectName: 'AppJamat',
        projectPath: 'C:\\Projects\\NodeJs\\AppJamat',
      },
    }])
  })

  it('asks the OS for a folder, and binds the one it answers with', () => {
    const run = Run.loaded().on('pickFolder').then({ input: 'activate' })

    expect(run.effects).toEqual([{ effect: 'pickDirectory' }])
    expect(run.then({ input: 'directoryPicked', path: 'Q:/tmp/scratch' }).effects)
      // A directory the OS dialog named is nobody's row, so manage mode has nothing to point at it.
      .toEqual([{ effect: 'bindingChosen', binding: { mode: 'adHoc', path: 'Q:/tmp/scratch' } }])
  })

  it('binds the active root itself on the root row', () => {
    const run = Run.loaded().on('categoryRoot').then({ input: 'activate' })

    expect(run.effects)
      .toEqual([{ effect: 'bindingChosen', binding: { mode: 'adHoc', path: 'C:\\Projects\\NodeJs' } }])
  })

  // Under a filter the list is flat over every category, so the root row still names the tab it
  // belongs to and binds that root rather than the one a foreign result came from.
  it('names the active root on the root row, and follows the tab', () => {
    const run = Run.loaded()
      .then({ input: 'searchOpen' }, { input: 'searchChanged', text: 'web' })
      .on('categoryRoot')
    expect(run.at()).toBe('NodeJs')

    const web = run.then({ input: 'selectCategory', categoryId: 'web' }).on('categoryRoot')
    expect(web.then({ input: 'activate' }).effects)
      .toEqual([{ effect: 'bindingChosen', binding: { mode: 'adHoc', path: 'C:\\Projects\\Web' } }])
  })

  it('draws no root row before the catalog has answered', () => {
    const rows = LauncherModel.rowsOf(LauncherModel.initial(null).state)

    expect(rows.map((row) => row.kind)).toEqual(['pickFolder'])
  })

  // The tail is reached with the arrows: a letter belongs to the projects, which is what type-to-jump
  // is for.
  // `Pick folder…` and `Root project (…)` carry no project name, so no letter reaches them.
  it('never jumps to a tail row', () => {
    const run = Run.loaded().then({ input: 'setCursor', index: 2 }, { input: 'typed', character: 'p' })

    expect(run.at()).toBe('archive')
  })

  // A listing that arrives for a category the user has already left is worth keeping - search reads
  // it - but it must not move a cursor standing somewhere else.
  it('keeps a listing for a category the cursor has left without moving anything', () => {
    const run = Run.loaded()
      .then({ input: 'setCursor', index: 2 })
      .then({
        input: 'projectsLoaded',
        categoryId: 'web',
        sort: 'recent',
        listing: LauncherFixtures.web(),
      })

    expect(run.state.cursor).toBe(2)
    expect(LauncherModel.listingOf(run.state, 'web')).toBeTruthy()
  })

  it('shows a failed load without throwing away what is on the screen', () => {
    const run = Run.loaded().then({ input: 'loadFailed', detail: 'category-unavailable: Q:/ is gone' })

    expect(run.state.loadError).toBe('category-unavailable: Q:/ is gone')
    expect(run.rows()).toHaveLength(5)
  })

  it('throws on an input it does not know', () => {
    expect(() => LauncherModel.transition(
      LauncherModel.initial(null).state,
      { input: 'teleport' } as unknown as LauncherInput,
    )).toThrow(/Unknown launcher input/)
  })

  /*
   * The same screen listing another computer's catalog. Only three things change and each is a
   * thing that would otherwise act on THIS machine: the source of the listings, the two tail rows,
   * and the project actions.
   */
  describe('a catalog that belongs to another computer', () => {
    it('asks that computer for its categories rather than this one', () => {
      expect(LauncherModel.initial(null, remoteTargetConst).effects)
        .toEqual([{ effect: 'fetchCategories', remoteEndpointId: 'endpoint-a' }])
      expect(LauncherModel.initial(null, remoteTargetConst).state.remote).toEqual(remoteTargetConst)
    })

    it('sends the endpoint with every listing it asks for', () => {
      const switched = Run.remote().then({ input: 'selectCategory', categoryId: 'web' })

      expect(switched.effects).toEqual([{
        effect: 'fetchProjects',
        categoryId: 'web',
        sort: 'recent',
        remoteEndpointId: 'endpoint-a',
      }])
    })

    /*
     * The remote source answers with every category's listing in one call, so the category in front
     * is already held by the time the categories arrive. Locally nothing has arrived yet, so the
     * ask is unchanged there - which the test above this block still pins.
     */
    it('asks for no listing it already holds', () => {
      const seeded = Run.from(LauncherModel.initial(null, remoteTargetConst).state)
        .then({
          input: 'projectsLoaded',
          categoryId: 'nodejs',
          sort: 'recent',
          listing: LauncherFixtures.nodejs(),
        })
        .then({ input: 'categoriesLoaded', categories: LauncherFixtures.categories() })

      expect(seeded.effects).toEqual([])
      expect(seeded.rows().some((row) => row.kind === 'project')).toBe(true)
    })

    // The picker opens this machine's dialog and the root is this machine's path.
    it('draws neither the folder picker nor the category root', () => {
      const rows = Run.remote().rows()

      expect(rows.some((row) => row.kind === 'pickFolder')).toBe(false)
      expect(rows.some((row) => row.kind === 'categoryRoot')).toBe(false)
      expect(Run.loaded().rows().some((row) => row.kind === 'pickFolder')).toBe(true)
    })

    // A directory is made on the machine that holds the catalog, and this screen's create is local.
    it('makes no project, and says where one would be made instead', () => {
      const asked = Run.remote().then({ input: 'newProjectStart' })

      expect(asked.state.newProject).toBeNull()
      expect(LauncherModel.newProjectRefusal(asked.state))
        .toBe('Projects are made on the computer that holds them; make it on Studio.')
      expect(LauncherModel.newProjectRefusal(Run.loaded().state)).toBeNull()
    })

    // The rung below a remote catalog is the computer list, not the way out of the card.
    it('steps back to the computer list rather than closing', () => {
      expect(Run.remote().then({ input: 'escape' }).effects)
        .toEqual([{ effect: 'showComputers' }])
      expect(Run.loaded().then({ input: 'escape' }).effects).toEqual([{ effect: 'close' }])
    })

    it('peels the filter and the folder before it offers the computer list', () => {
      const inside = Run.remote()
        .on('virtualFolder')
        .then({ input: 'activate' }, { input: 'searchOpen' }, { input: 'searchChanged', text: 'app' })

      const filtered = inside.then({ input: 'escape' })
      expect(filtered.effects).toEqual([])
      const folder = filtered.then({ input: 'escape' })
      expect(folder.effects).toEqual([])
      expect(folder.then({ input: 'escape' }).effects).toEqual([{ effect: 'showComputers' }])
    })

    it('still starts a session in a project of that computer', () => {
      const chosen = Run.remote().on('project').then({ input: 'activate' })

      expect(chosen.effects).toEqual([{
        effect: 'bindingChosen',
        binding: {
          mode: 'project',
          categoryId: 'nodejs',
          projectName: 'AppJamat',
          projectPath: 'C:\\Projects\\NodeJs\\AppJamat',
        },
      }])
    })
  })
})
