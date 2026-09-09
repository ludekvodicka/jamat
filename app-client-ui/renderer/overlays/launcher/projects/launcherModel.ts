import type {
  CategoryInfo,
  DisplayEntry,
  ProjectEntry,
  ProjectListResult,
  VirtualFolderDef,
} from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import type { LauncherBinding } from '../launcherBinding'
import { LauncherLabels } from '../launcherLabels'
import type { LauncherRemoteTarget } from '../launcherTarget'
import type { ProjectSummary } from './projectSummaries'

/** A row is what the cursor can stand on. Nothing else is drawn as a line the keyboard reaches. */
export type LauncherRow =
  | { kind: 'project'; categoryId: string; project: ProjectEntry }
  | { kind: 'virtualFolder'; prefix: string; title: string; count: number }
  /** A directory outside every category, named by the OS picker rather than typed. */
  | { kind: 'pickFolder' }
  /** The category's own root, for work that is about the root itself rather than one project in it. */
  | { kind: 'categoryRoot'; categoryId: string; label: string; path: string }

export type LauncherSort = Parameters<AppClientUiBridge['projects']['list']>[1]

export interface LauncherSearchResults {
  current: readonly Extract<LauncherRow, { kind: 'project' }>[]
  other: readonly Extract<LauncherRow, { kind: 'project' }>[]
}

type LauncherRowIdentity =
  | { kind: 'project'; categoryId: string; name: string }
  | { kind: 'pickFolder' }
  | { kind: 'categoryRoot' }

type LauncherProjectIdentity = Extract<LauncherRowIdentity, { kind: 'project' }>

export interface LauncherState {
  /**
   * The computer whose catalog this is, or null for this one. It decides the SOURCE - the local
   * project channels or `remote:projects-list` against that endpoint - and it takes the rows that
   * only mean something here with it: the OS folder picker and the category root are paths of this
   * machine, and a project made from this screen would be made on this machine.
   */
  remote: LauncherRemoteTarget | null
  categories: readonly CategoryInfo[]
  activeCategoryId: string | null
  /** Every category and sort listing fetched so far, keyed only through `projectRequestKeyOf`. */
  listings: ReadonlyMap<string, ProjectListResult>
  /** Every category and sort pair search already requested in this launcher. */
  searchRequests: ReadonlySet<string>
  /** Listing failures keep the same category and sort identity as successful answers. */
  projectLoadErrors: ReadonlyMap<string, string>
  /** A searched project held while its listing is replaced for a new sort. */
  sortCursor: LauncherProjectIdentity | null
  /** A changed query waiting for the active listing still targets its first future match. */
  searchCursorReset: boolean
  cursor: number
  sort: LauncherSort
  view: 'grouped' | 'flat'
  /** Non-null while the cursor is inside a virtual folder. Backspace leaves it. */
  virtualFolderPrefix: string | null
  /**
   * `active` is "the filter field holds the caret", not "a filter is on" - the text is what filters,
   * and it survives leaving the field. Keeping the two apart is what lets Up open the field again
   * after the arrow that went back into the list.
   */
  search: { active: boolean; text: string }
  /** Cursor per category, in memory only: a restart starts every category at the top. */
  tabMemory: ReadonlyMap<string, number>
  /**
   * The project being named, and null when none is. Not a row - a list of forty projects that ends in
   * a button is a list with something in it that is not a project - so `F7` opens it in the card's
   * own strip, above the key line.
   */
  newProject: { name: string } | null
  /** Set by a create: the next listing puts the cursor on this name, then forgets it. */
  focusName: string | null
  /** `categoryId/name` to counts. A row missing from here has not been read, which is not zero. */
  summaries: ReadonlyMap<string, ProjectSummary>
  loadError: string | null
}

export type LauncherInput =
  | { input: 'categoriesLoaded'; categories: readonly CategoryInfo[] }
  | {
      input: 'projectsLoaded'
      categoryId: string
      sort: LauncherSort
      listing: ProjectListResult
    }
  | { input: 'projectsLoadFailed'; categoryId: string; sort: LauncherSort; detail: string }
  | { input: 'loadFailed'; detail: string }
  | { input: 'selectCategory'; categoryId: string }
  | { input: 'moveCursor'; delta: number }
  | { input: 'setCursor'; index: number }
  | { input: 'activate' }
  /** The mouse's activate: it names the row rather than acting on wherever the cursor happens to be. */
  | { input: 'openRow'; index: number }
  | { input: 'typed'; character: string }
  | { input: 'searchOpen' }
  /**
   * Focus left the filter field, by the arrow that goes back into the list or by a click anywhere
   * else. The text stays - what was typed is still filtering - and only "typing lands here" ends.
   */
  | { input: 'searchLeave' }
  | { input: 'searchChanged'; text: string }
  | { input: 'backspace' }
  | { input: 'cycleSort' }
  | { input: 'toggleView' }
  | { input: 'newProjectChanged'; name: string }
  | { input: 'projectCreated'; categoryId: string; name: string }
  /** Opens the create wherever the cursor stands; a project belongs to the category, not to a row. */
  | { input: 'newProjectStart' }
  /** Something outside this model changed the projects on disk and wants the listing read again. */
  | { input: 'refetchRequested'; categoryId: string }
  | { input: 'summaryLoaded'; categoryId: string; name: string; summary: ProjectSummary }
  /** The OS picker answered with a directory; a cancelled dialog sends no input at all. */
  | { input: 'directoryPicked'; path: string }
  | { input: 'escape' }

export type LauncherEffect =
  /**
   * `remoteEndpointId` is which computer answers, null being this one. It rides on the effect rather
   * than being read off the state by whoever runs it, so an answer can never be composed against a
   * different computer from the one that was asked.
   */
  | { effect: 'fetchCategories'; remoteEndpointId: string | null }
  | {
      effect: 'fetchProjects'
      categoryId: string
      sort: LauncherSort
      remoteEndpointId: string | null
    }
  | { effect: 'createProject'; categoryId: string; name: string; virtualFolderPrefix: string | null }
  /**
   * The seam. Enter says where a session would run and nothing about what happens to it: the second
   * screen is what turns a binding into a session.
   *
   * It carried HOW it was chosen until 2026-08-11, because Enter meant two things while the manage
   * mode existed - start a session, or point that mode's actions at the row - and the flag was how a
   * double click kept meaning start. The actions have their own keys now, so Enter means one thing
   * and nothing downstream asks which device sent it.
   */
  | { effect: 'bindingChosen'; binding: LauncherBinding }
  | { effect: 'pickDirectory' }
  /** The way back out of a remote card: the computer list is the screen behind this one. */
  | { effect: 'showComputers' }
  | { effect: 'close' }

export interface LauncherStep {
  state: LauncherState
  effects: readonly LauncherEffect[]
}

/**
 * The launcher's project screen as a pure machine: state plus one input gives state plus effects.
 *
 * Every keyboard path and every mouse path is an input here, which is what makes "the mouse can do
 * whatever the keyboard can" a test table rather than a promise.
 */
export class LauncherModel {
  /**
   * `preferredCategoryId` is where an opener asked to stand, or null for the first category of the
   * catalog. It is seeded rather than dispatched, because `withCategories` already keeps an active
   * category the load still names and falls back to the first otherwise - so a category that has
   * been retired degrades to the ordinary open, and no listing is fetched twice.
   */
  static initial(
    preferredCategoryId: string | null,
    remote: LauncherRemoteTarget | null = null,
  ): LauncherStep {
    return {
      state: {
        remote,
        categories: [],
        activeCategoryId: preferredCategoryId,
        listings: new Map(),
        searchRequests: new Set(),
        projectLoadErrors: new Map(),
        sortCursor: null,
        searchCursorReset: false,
        cursor: 0,
        sort: 'recent',
        view: 'grouped',
        virtualFolderPrefix: null,
        search: { active: false, text: '' },
        tabMemory: new Map(),
        newProject: null,
        focusName: null,
        summaries: new Map(),
        loadError: null,
      },
      effects: [{
        effect: 'fetchCategories',
        remoteEndpointId: remote === null ? null : remote.remoteEndpointId,
      }],
    }
  }

  /** Which computer answers for this card, null being this one. */
  static endpointOf(state: LauncherState): string | null {
    return state.remote === null ? null : state.remote.remoteEndpointId
  }

  /**
   * What the screen draws, derived and never stored: a cursor that indexes a list held beside the
   * facts it came from is a cursor that survives the list changing under it.
   */
  static rowsOf(state: LauncherState): readonly LauncherRow[] {
    const results = LauncherModel.searchResultsOf(state)
    const rows = results === null
      ? LauncherModel.browseRows(state)
      : [...results.current, ...results.other]
    // The tail is two rows in every category and under every filter: a directory to borrow, and the
    // root the whole tab is a listing of. Making a project or a folder is an action rather than a
    // row, because neither is a place a session can be started in until it exists.
    //
    // Both of them are paths of THIS machine - the picker opens this machine's dialog and the root
    // comes from this machine's catalog - so a remote card draws neither and says so on the key
    // line instead of offering a folder the other computer has never heard of.
    if (state.remote !== null) return rows
    return [...rows, { kind: 'pickFolder' }, ...LauncherModel.categoryRootRows(state)]
  }

  /**
   * The active category's own root, `C:\Projects\NodeJs` rather than a home directory nothing in
   * this launcher is about: an agent started there sees every project of the tab at once, which is
   * what a session about the root itself needs and what a home directory never was.
   *
   * Absent while no category is active, which is the moment before the catalog answers - and only
   * then, since a category that cannot be read right now still has the root it is configured with.
   */
  private static categoryRootRows(state: LauncherState): readonly LauncherRow[] {
    const category = LauncherModel.activeCategoryOf(state)
    if (category === null)
      return []
    return [{
      kind: 'categoryRoot',
      categoryId: category.id,
      label: category.label,
      path: category.path,
    }]
  }

  private static activeCategoryOf(state: LauncherState): CategoryInfo | null {
    return state.categories.find((candidate) => candidate.id === state.activeCategoryId) ?? null
  }

  /** Search membership belongs to the model; the screen only draws the two groups it is handed. */
  static searchResultsOf(state: LauncherState): LauncherSearchResults | null {
    if (state.search.text.length === 0)
      return null
    const needle = state.search.text.toLowerCase()
    return {
      current: LauncherModel.matchesIn(state, state.activeCategoryId, needle),
      other: state.categories
        .filter((category) => category.id !== state.activeCategoryId)
        .flatMap((category) => LauncherModel.matchesIn(state, category.id, needle)),
    }
  }

  static listingOf(
    state: LauncherState,
    categoryId: string,
    sort: LauncherSort = state.sort,
  ): ProjectListResult | null {
    return state.listings.get(LauncherModel.projectRequestKeyOf(categoryId, sort)) ?? null
  }

  static loadErrorOf(state: LauncherState): string | null {
    if (state.loadError !== null)
      return state.loadError
    if (state.activeCategoryId === null)
      return null
    const categoryIds = state.search.active || state.search.text.length > 0
      ? [
          state.activeCategoryId,
          ...state.categories
            .filter((category) => category.id !== state.activeCategoryId)
            .map((category) => category.id),
        ]
      : [state.activeCategoryId]
    for (const categoryId of categoryIds) {
      const detail = state.projectLoadErrors.get(
        LauncherModel.projectRequestKeyOf(categoryId, state.sort),
      )
      if (detail !== undefined)
        return detail
    }
    return null
  }

  /**
   * The prefix the drawn rows are shortened by, and the folder the breadcrumb may claim - null while
   * a filter is on, because search is flat over every category already fetched and most of what it
   * draws is in no folder at all. `virtualFolderPrefix` itself is deliberately NOT cleared: the
   * cursor is still standing inside the folder, and Backspace and Escape peel the search first and
   * the folder after it, in the order they were entered.
   */
  static labelPrefixOf(state: LauncherState): string | null {
    return state.search.text.length > 0 ? null : state.virtualFolderPrefix
  }

  /**
   * The folders a project can be moved into, and the ones the breadcrumb reads its title from: the
   * ones the ROOT defines, not the ones this listing happens to draw. Read off `entries` this was
   * every folder holding something, which excluded exactly the folder somebody had just created and
   * wanted to move the first project into.
   */
  static foldersOf(state: LauncherState): readonly VirtualFolderDef[] {
    return LauncherModel.activeListingOf(state)?.virtualFolders ?? []
  }

  /**
   * Where a new project would be made, in the words the rest of the card uses: the folder the cursor
   * is standing in, or the category when it is standing in none.
   *
   * Off `virtualFolderPrefix` rather than `labelPrefixOf`, because this answers where the directory
   * LANDS and that is the prefix `confirmNewProject` reads. The two differ under a filter: the
   * breadcrumb goes off screen because the list is then flat over every category, while the create
   * still lands in the folder - which is exactly when saying so is worth something.
   */
  static placeLabelOf(state: LauncherState): string {
    const category = LauncherModel.activeCategoryOf(state)
    return LauncherLabels.placeOf(
      category?.label ?? state.activeCategoryId ?? '',
      LauncherModel.foldersOf(state),
      state.virtualFolderPrefix,
    )
  }

  static transition(state: LauncherState, input: LauncherInput): LauncherStep {
    if (input.input === 'categoriesLoaded') return LauncherModel.withCategories(state, input.categories)
    else if (input.input === 'projectsLoaded') return LauncherModel.withListing(state, input)
    else if (input.input === 'projectsLoadFailed')
      return LauncherModel.withProjectLoadFailure(state, input)
    else if (input.input === 'loadFailed') return LauncherModel.step({ ...state, loadError: input.detail })
    else if (input.input === 'selectCategory') return LauncherModel.withCategory(state, input.categoryId)
    else if (input.input === 'moveCursor') return LauncherModel.moved(state, input.delta)
    else if (input.input === 'setCursor') return LauncherModel.withCursor(state, input.index)
    else if (input.input === 'activate') return LauncherModel.activated(state)
    else if (input.input === 'openRow')
      return LauncherModel.activated(LauncherModel.withCursor(state, input.index).state)
    else if (input.input === 'typed') return LauncherModel.typed(state, input.character)
    else if (input.input === 'searchOpen') return LauncherModel.searchOpened(state)
    else if (input.input === 'searchLeave')
      return LauncherModel.step({ ...state, search: { ...state.search, active: false } })
    else if (input.input === 'searchChanged') return LauncherModel.searched(state, input.text)
    else if (input.input === 'backspace') return LauncherModel.backspaced(state)
    else if (input.input === 'cycleSort') return LauncherModel.sorted(state)
    else if (input.input === 'toggleView') return LauncherModel.viewed(state)
    else if (input.input === 'newProjectChanged')
      return LauncherModel.step({ ...state, newProject: { name: input.name } })
    else if (input.input === 'projectCreated') return LauncherModel.created(state, input.categoryId, input.name)
    else if (input.input === 'newProjectStart')
      return LauncherModel.newProjectRefusal(state) === null
        ? LauncherModel.step({ ...state, newProject: { name: '' } })
        : LauncherModel.step(state)
    else if (input.input === 'refetchRequested')
      return LauncherModel.step(state, {
        effect: 'fetchProjects',
        categoryId: input.categoryId,
        sort: state.sort,
        remoteEndpointId: LauncherModel.endpointOf(state),
      })
    else if (input.input === 'summaryLoaded') return LauncherModel.summarised(state, input)
    else if (input.input === 'directoryPicked')
      return LauncherModel.step(state, {
        effect: 'bindingChosen',
        binding: { mode: 'adHoc', path: input.path },
      })
    else if (input.input === 'escape') return LauncherModel.escaped(state)
    else
      throw new Error(`Unknown launcher input: ${JSON.stringify(input)}`)
  }

  private static browseRows(state: LauncherState): readonly LauncherRow[] {
    const listing = LauncherModel.activeListingOf(state)
    if (!listing || state.activeCategoryId === null)
      return []
    const categoryId = state.activeCategoryId
    if (state.virtualFolderPrefix !== null)
      return LauncherModel.folderChildren(listing, state.virtualFolderPrefix)
        .map((project) => ({ kind: 'project', categoryId, project }))
    if (state.view === 'flat')
      return listing.projects.map((project) => ({ kind: 'project', categoryId, project }))
    else if (state.view === 'grouped')
      return listing.entries.map((entry) => LauncherModel.rowOf(categoryId, entry))
    else
      throw new Error(`Unknown launcher view: ${JSON.stringify(state.view)}`)
  }

  /** Search is flat across folders and only reads listings for the current sort. */
  private static matchesIn(
    state: LauncherState,
    categoryId: string | null,
    needle: string,
  ): readonly Extract<LauncherRow, { kind: 'project' }>[] {
    if (categoryId === null)
      return []
    const listing = LauncherModel.listingOf(state, categoryId)
    if (!listing)
      return []
    return listing.projects
      .filter((project) => project.name.toLowerCase().includes(needle))
      .map((project) => ({ kind: 'project', categoryId, project }))
  }

  private static projectRequestKeyOf(categoryId: string, sort: LauncherSort): string {
    return JSON.stringify([categoryId, sort])
  }

  private static rowOf(categoryId: string, entry: DisplayEntry): LauncherRow {
    if (entry.kind === 'project')
      return { kind: 'project', categoryId, project: entry.project }
    else if (entry.kind === 'virtualFolder')
      return { kind: 'virtualFolder', prefix: entry.prefix, title: entry.title, count: entry.children.length }
    else
      throw new Error(`Unknown display entry: ${JSON.stringify(entry)}`)
  }

  private static folderChildren(listing: ProjectListResult, prefix: string): readonly ProjectEntry[] {
    for (const entry of listing.entries)
      if (entry.kind === 'virtualFolder' && entry.prefix === prefix)
        return entry.children
    // The folder went away while the cursor stood in it: an empty list is what the caller can draw,
    // and Backspace is still there to leave with.
    return []
  }

  /** Browse keeps its last listing visible while F4 loads; filtered rows use only `listingOf`. */
  static activeListingOf(state: LauncherState): ProjectListResult | null {
    if (state.activeCategoryId === null)
      return null
    return LauncherModel.listingOf(state, state.activeCategoryId)
      ?? LauncherModel.listingOf(
        state,
        state.activeCategoryId,
        LauncherModel.nextSortOf(state.sort),
      )
  }

  private static withCategories(
    state: LauncherState,
    categories: readonly CategoryInfo[],
  ): LauncherStep {
    // A category that is still there keeps the screen where it was; a first load lands on the first.
    const keep = categories.some((category) => category.id === state.activeCategoryId)
    const activeCategoryId = keep ? state.activeCategoryId : categories[0]?.id ?? null
    const next: LauncherState = {
      ...state,
      categories,
      activeCategoryId,
      loadError: null,
    }
    if (activeCategoryId === null)
      return LauncherModel.step(next)
    // Nothing is asked for twice. Locally this changes nothing - no listing has arrived when the
    // categories do - but the remote source answers with every category's listing in one call, so
    // the listing for the category in front is already held by the time this runs.
    if (LauncherModel.listingOf(next, activeCategoryId) !== null)
      return LauncherModel.requestForeignListings(next)
    return LauncherModel.requestForeignListings(
      next,
      {
        effect: 'fetchProjects',
        categoryId: activeCategoryId,
        sort: state.sort,
        remoteEndpointId: LauncherModel.endpointOf(state),
      },
    )
  }

  private static searchOpened(state: LauncherState): LauncherStep {
    return LauncherModel.requestForeignListings({
      ...state,
      search: { ...state.search, active: true },
    })
  }

  private static requestForeignListings(
    state: LauncherState,
    ...effects: readonly LauncherEffect[]
  ): LauncherStep {
    if (!state.search.active && state.search.text.length === 0)
      return LauncherModel.step(state, ...effects)
    const missing = state.categories.filter((category) =>
      category.id !== state.activeCategoryId
      && LauncherModel.listingOf(state, category.id) === null
      && !state.searchRequests.has(LauncherModel.projectRequestKeyOf(category.id, state.sort)))
    const searchRequests = new Set(state.searchRequests)
    for (const category of missing)
      searchRequests.add(LauncherModel.projectRequestKeyOf(category.id, state.sort))
    return LauncherModel.step(
      { ...state, searchRequests },
      ...effects,
      ...missing.map((category) => ({
        effect: 'fetchProjects' as const,
        categoryId: category.id,
        sort: state.sort,
        remoteEndpointId: LauncherModel.endpointOf(state),
      })),
    )
  }

  private static withListing(
    state: LauncherState,
    input: Extract<LauncherInput, { input: 'projectsLoaded' }>,
  ): LauncherStep {
    const key = LauncherModel.projectRequestKeyOf(input.categoryId, input.sort)
    const listings = new Map(state.listings)
    listings.set(key, input.listing)
    const projectLoadErrors = new Map(state.projectLoadErrors)
    projectLoadErrors.delete(key)
    if (input.sort !== state.sort)
      return LauncherModel.step({ ...state, listings, projectLoadErrors })
    const selected = state.searchCursorReset ? null : state.sortCursor ?? (state.search.text.length > 0
      ? LauncherModel.rowIdentityOf(LauncherModel.rowsOf(state)[state.cursor])
      : null)
    const next = {
      ...state,
      listings,
      projectLoadErrors,
      searchCursorReset: state.searchCursorReset && input.categoryId !== state.activeCategoryId,
      sortCursor: state.sortCursor !== null && input.categoryId !== state.sortCursor.categoryId
        ? state.sortCursor
        : null,
      loadError: null,
    }
    // A listing for a category the user has already left changes what search can reach, never where
    // the cursor stands.
    if (input.categoryId !== state.activeCategoryId && selected === null)
      return LauncherModel.step(next)
    if (input.categoryId !== state.activeCategoryId)
      return LauncherModel.step({ ...next, cursor: LauncherModel.cursorFor(next, selected) })
    return LauncherModel.step({
      ...next,
      cursor: LauncherModel.cursorFor(next, selected),
      focusName: null,
    })
  }

  private static withProjectLoadFailure(
    state: LauncherState,
    input: Extract<LauncherInput, { input: 'projectsLoadFailed' }>,
  ): LauncherStep {
    const projectLoadErrors = new Map(state.projectLoadErrors)
    projectLoadErrors.set(
      LauncherModel.projectRequestKeyOf(input.categoryId, input.sort),
      input.detail,
    )
    return LauncherModel.step({
      ...state,
      projectLoadErrors,
      searchCursorReset: state.searchCursorReset
        && (input.sort !== state.sort || input.categoryId !== state.activeCategoryId),
    })
  }

  /** The created project is where the cursor goes; otherwise the remembered place, clamped. */
  private static cursorFor(
    state: LauncherState,
    selected: LauncherRowIdentity | null = null,
  ): number {
    const rows = LauncherModel.rowsOf(state)
    if (state.focusName !== null) {
      const found = rows.findIndex((row) => row.kind === 'project' && row.project.name === state.focusName)
      if (found >= 0)
        return found
    }
    if (selected !== null) {
      const found = rows.findIndex((row) => LauncherModel.isRow(row, selected))
      if (found >= 0)
        return found
    }
    return LauncherModel.clamp(state.cursor, rows.length)
  }

  private static rowIdentityOf(row: LauncherRow | undefined): LauncherRowIdentity | null {
    if (row === undefined)
      return null
    if (row.kind === 'project')
      return { kind: 'project', categoryId: row.categoryId, name: row.project.name }
    else if (row.kind === 'virtualFolder')
      return null
    else if (row.kind === 'pickFolder')
      return { kind: 'pickFolder' }
    else if (row.kind === 'categoryRoot')
      return { kind: 'categoryRoot' }
    else
      throw new Error(`Unknown launcher row: ${JSON.stringify(row)}`)
  }

  private static isRow(row: LauncherRow, selected: LauncherRowIdentity): boolean {
    if (selected.kind === 'project')
      return row.kind === 'project'
        && row.categoryId === selected.categoryId
        && row.project.name === selected.name
    else if (selected.kind === 'pickFolder')
      return row.kind === 'pickFolder'
    else if (selected.kind === 'categoryRoot')
      return row.kind === 'categoryRoot'
    else
      throw new Error(`Unknown launcher row identity: ${JSON.stringify(selected)}`)
  }

  private static withCategory(state: LauncherState, categoryId: string): LauncherStep {
    if (categoryId === state.activeCategoryId)
      return LauncherModel.step(state)
    const tabMemory = new Map(state.tabMemory)
    if (state.activeCategoryId !== null)
      tabMemory.set(state.activeCategoryId, state.cursor)
    const next: LauncherState = {
      ...state,
      activeCategoryId: categoryId,
      tabMemory,
      // A drill, a search and a half-typed name all belong to the category they were made in.
      virtualFolderPrefix: null,
      search: { active: state.search.active, text: '' },
      sortCursor: null,
      searchCursorReset: false,
      newProject: null,
      cursor: 0,
      loadError: null,
    }
    return LauncherModel.step(
      { ...next, cursor: LauncherModel.clamp(tabMemory.get(categoryId) ?? 0, LauncherModel.rowsOf(next).length) },
      {
        effect: 'fetchProjects',
        categoryId,
        sort: state.sort,
        remoteEndpointId: LauncherModel.endpointOf(state),
      },
    )
  }

  /**
   * Up from the first row opens the filter, because there is nothing above that row in the list and
   * the field is what is above it on screen. Every other step is a move inside the list.
   */
  private static moved(state: LauncherState, delta: number): LauncherStep {
    if (delta < 0 && state.cursor === 0)
      return LauncherModel.searchOpened(state)
    return LauncherModel.withCursor(state, state.cursor + delta)
  }

  private static withCursor(state: LauncherState, index: number): LauncherStep {
    return LauncherModel.step({
      ...state,
      sortCursor: null,
      searchCursorReset: false,
      cursor: LauncherModel.clamp(index, LauncherModel.rowsOf(state).length),
    })
  }

  private static clamp(index: number, length: number): number {
    if (length === 0)
      return 0
    if (index < 0)
      return 0
    if (index >= length)
      return length - 1
    return index
  }

  private static activated(state: LauncherState): LauncherStep {
    if (state.newProject)
      return LauncherModel.confirmNewProject(state, state.newProject.name)
    const row = LauncherModel.rowsOf(state)[state.cursor]
    if (!row)
      return LauncherModel.step(state)
    if (row.kind === 'project')
      return LauncherModel.step(state, {
        effect: 'bindingChosen',
        binding: {
          mode: 'project',
          categoryId: row.categoryId,
          projectName: row.project.name,
          projectPath: row.project.path,
        },
      })
    else if (row.kind === 'virtualFolder')
      return LauncherModel.step({ ...state, virtualFolderPrefix: row.prefix, cursor: 0 })
    else if (row.kind === 'pickFolder')
      return LauncherModel.step(state, { effect: 'pickDirectory' })
    else if (row.kind === 'categoryRoot')
      return LauncherModel.step(state, {
        effect: 'bindingChosen',
        binding: { mode: 'adHoc', path: row.path },
      })
    else
      throw new Error(`Unknown launcher row: ${JSON.stringify(row)}`)
  }

  /** A name of nothing but spaces creates nothing: the edit stays open rather than failing at the library. */
  private static confirmNewProject(state: LauncherState, name: string): LauncherStep {
    const trimmed = name.trim()
    if (trimmed.length === 0 || state.activeCategoryId === null)
      return LauncherModel.step(state)
    return LauncherModel.step(state, {
      effect: 'createProject',
      categoryId: state.activeCategoryId,
      name: trimmed,
      virtualFolderPrefix: state.virtualFolderPrefix,
    })
  }

  static summaryKeyOf(categoryId: string, name: string): string {
    return `${categoryId}/${name}`
  }

  private static summarised(
    state: LauncherState,
    input: Extract<LauncherInput, { input: 'summaryLoaded' }>,
  ): LauncherStep {
    const summaries = new Map(state.summaries)
    summaries.set(LauncherModel.summaryKeyOf(input.categoryId, input.name), input.summary)
    return LauncherModel.step({ ...state, summaries })
  }

  private static created(state: LauncherState, categoryId: string, name: string): LauncherStep {
    return LauncherModel.step(
      { ...state, newProject: null, focusName: name, loadError: null },
      {
        effect: 'fetchProjects',
        categoryId,
        sort: state.sort,
        remoteEndpointId: LauncherModel.endpointOf(state),
      },
    )
  }

  /**
   * Typing means one of two things and never both: filtering while the search field is up, and
   * jumping to the next project starting with that letter while it is not. The jump starts one row
   * past the cursor and wraps, so pressing the same letter again walks the matches.
   */
  private static typed(state: LauncherState, character: string): LauncherStep {
    if (state.search.active)
      return LauncherModel.searched(state, state.search.text + character)
    const rows = LauncherModel.rowsOf(state)
    const letter = character.toLowerCase()
    for (let step = 1; step <= rows.length; step += 1) {
      const index = (state.cursor + step) % rows.length
      if (LauncherModel.startsWith(rows[index], letter, LauncherModel.labelPrefixOf(state)))
        return LauncherModel.step({ ...state, cursor: index })
    }
    return LauncherModel.step(state)
  }

  /** Only the rows that carry a name; the tail is reached with the arrows, not by typing. */
  private static startsWith(
    row: LauncherRow,
    letter: string,
    virtualFolderPrefix: string | null,
  ): boolean {
    if (row.kind === 'project')
      // By what is drawn, as in V1: inside "House projects" the row reads `Bazen`, so `b` is what
      // jumps to it. Matching the directory name would mean typing the prefix every row shares.
      return LauncherLabels.projectLabelOf(row.project.name, virtualFolderPrefix)
        .toLowerCase()
        .startsWith(letter)
    else if (row.kind === 'virtualFolder')
      return row.title.toLowerCase().startsWith(letter)
    else if (row.kind === 'pickFolder' || row.kind === 'categoryRoot')
      return false
    else
      throw new Error(`Unknown launcher row: ${JSON.stringify(row)}`)
  }

  private static searched(state: LauncherState, text: string): LauncherStep {
    const next = { ...state, search: { active: true, text } }
    return LauncherModel.requestForeignListings({
      ...next,
      sortCursor: null,
      searchCursorReset: next.activeCategoryId === null
        || LauncherModel.listingOf(next, next.activeCategoryId) === null,
      cursor: LauncherModel.clamp(0, LauncherModel.rowsOf(next).length),
    })
  }

  /** Backspace takes back the last thing typed, in the order it was typed. */
  private static backspaced(state: LauncherState): LauncherStep {
    if (state.search.text.length > 0)
      return LauncherModel.searched(state, state.search.text.slice(0, -1))
    if (state.search.active)
      return LauncherModel.step({ ...state, search: { active: false, text: '' } })
    if (state.virtualFolderPrefix !== null)
      return LauncherModel.withCursor({ ...state, virtualFolderPrefix: null }, 0)
    return LauncherModel.step(state)
  }

  private static sorted(state: LauncherState): LauncherStep {
    const sort = LauncherModel.nextSortOf(state.sort)
    if (state.activeCategoryId === null)
      return LauncherModel.step({ ...state, sort })
    const selected = state.search.text.length > 0
      ? state.sortCursor ?? LauncherModel.rowIdentityOf(LauncherModel.rowsOf(state)[state.cursor])
      : null
    const next: LauncherState = {
      ...state,
      sort,
      sortCursor: selected?.kind === 'project' ? selected : null,
    }
    const aligned = selected === null
      ? next
      : { ...next, cursor: LauncherModel.cursorFor({ ...next, cursor: 0 }, selected) }
    return LauncherModel.requestForeignListings(
      aligned,
      {
        effect: 'fetchProjects',
        categoryId: state.activeCategoryId,
        sort,
        remoteEndpointId: LauncherModel.endpointOf(state),
      },
    )
  }

  private static nextSortOf(sort: LauncherSort): LauncherSort {
    if (sort === 'recent')
      return 'alpha'
    else if (sort === 'alpha')
      return 'recent'
    else
      throw new Error(`Unknown launcher sort: ${JSON.stringify(sort)}`)
  }

  /** Grouping is the same projects drawn differently, so nothing is fetched for it. */
  private static viewed(state: LauncherState): LauncherStep {
    const view = state.view === 'grouped' ? 'flat' : 'grouped'
    const next: LauncherState = { ...state, view, virtualFolderPrefix: null }
    return LauncherModel.withCursor(next, 0)
  }

  /**
   * Escape takes one layer at a time, innermost first, and the layers are the same ones Backspace
   * peels: a mistyped name must not cost the whole surface, and neither must standing inside a
   * folder. V1 read it the same way - Esc left the virtual folder if you were in one and quit only
   * if you were not.
   */
  private static escaped(state: LauncherState): LauncherStep {
    if (state.newProject)
      return LauncherModel.step({ ...state, newProject: null })
    if (state.search.active || state.search.text.length > 0)
      return LauncherModel.withCursor({ ...state, search: { active: false, text: '' } }, 0)
    if (state.virtualFolderPrefix !== null)
      return LauncherModel.withCursor({ ...state, virtualFolderPrefix: null }, 0)
    // The last rung of a remote card is the computer list rather than the way out: picking the wrong
    // computer is one of the two mistakes this profile makes easy, and the other one - the wrong
    // project - already steps back one screen.
    if (state.remote !== null) return LauncherModel.step(state, { effect: 'showComputers' })
    return LauncherModel.step(state, { effect: 'close' })
  }

  /**
   * Why this card makes no project, or null where it does. A directory is made on the machine the
   * catalog belongs to, and this screen's create would make it on this one.
   */
  static newProjectRefusal(state: LauncherState): string | null {
    if (state.remote === null) return null
    return `Projects are made on the computer that holds them; make it on ${state.remote.displayName}.`
  }

  private static step(state: LauncherState, ...effects: readonly LauncherEffect[]): LauncherStep {
    return { state, effects }
  }
}
