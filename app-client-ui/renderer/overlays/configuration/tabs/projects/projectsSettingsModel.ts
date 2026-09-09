import { Slug } from '../../../../../../lib-orchestrator/shared/slug'
import type {
  CatalogCategoryDto,
  VirtualFolderDef,
} from '../../../../../../lib-orchestrator/projectManager/projectManagerApi.types'

export interface ProjectsSettingsState {
  /** What the section held when it was last read or written. The yardstick for "modified". */
  loaded: readonly CatalogCategoryDto[] | null
  /**
   * The roots and nothing else: `categories` is one section of `config.json`, and everything beside
   * it is carried through by the store rather than by this buffer. What a category itself holds is
   * still this buffer's business - `CatalogCategoryDto` carries `[key: string]: unknown`, and a key
   * someone put there by hand has to come back out of a save unchanged.
   */
  buffer: readonly CatalogCategoryDto[] | null
  /** R8: the file moved under a modified buffer. Nothing is merged; an explicit reload is awaited. */
  staleOnDisk: boolean
  /** An explicit reload is in flight, and the roots it brings replace the buffer either way. */
  reloading: boolean
  /**
   * The roots a save is writing, and null when none is. They are what `loaded` becomes once the
   * write lands: an edit made while the write was in flight is not on disk, and a state that read
   * "saving" as a bare yes/no would clear the dirty mark over it.
   */
  saving: readonly CatalogCategoryDto[] | null
  /**
   * The question standing over the tab, and there is at most one: a second layer over the first is
   * the stacking the shell refuses.
   */
  asking: ProjectsSettingsQuestion | null
  problem: string | null
  /**
   * Which roots have their folder block open. A view state and nothing else: it never reaches the
   * file, so opening a block must not make the tab look modified.
   */
  expanded: ReadonlySet<string>
}

export type ProjectsSettingsQuestion =
  /** Removing a root orphans everything bound to its id, and nothing on disk shows that it did. */
  | { ask: 'remove'; id: string }
  /** Reading the file back throws every edit away, which is the same loss the window asks about. */
  | { ask: 'discard-and-reload' }

export type ProjectsSettingsInput =
  | { input: 'loaded'; categories: readonly CatalogCategoryDto[] }
  /** A read, a save or the picker failed; the buffer survives all three. */
  | { input: 'failed'; detail: string }
  | { input: 'add-requested' }
  | { input: 'add'; path: string }
  | { input: 'rename'; id: string; label: string }
  | { input: 'move'; id: string; delta: -1 | 1 }
  | { input: 'remove'; id: string }
  /** View only: which root's folder block is open. */
  | { input: 'folders-toggled'; id: string }
  | { input: 'folder-added'; id: string }
  | { input: 'folder-changed'; id: string; index: number; field: 'prefix' | 'title'; value: string }
  | { input: 'folder-removed'; id: string; index: number }
  /** The answer to whichever question stands; only the question knows what "yes" costs. */
  | { input: 'answered'; yes: boolean }
  | { input: 'save' }
  | { input: 'saved'; ok: boolean; detail?: string }
  | { input: 'reload-requested' }

export type ProjectsSettingsEffect =
  | { effect: 'load' }
  | { effect: 'save'; categories: readonly CatalogCategoryDto[] }
  | { effect: 'pick-directory' }

export interface ProjectsSettingsStep {
  state: ProjectsSettingsState
  effects: readonly ProjectsSettingsEffect[]
}

/**
 * The projects tab as data: the catalog section being edited, and the two rules that keep a
 * last-write-wins file from eating an edit.
 *
 * R8 - roots that arrive while the buffer is modified never replace it. They raise `staleOnDisk`
 * and the buffer stands until the user asks for the file back.
 * R9 - nothing here reconciles two versions. A save replaces the whole section, and the surface says
 * so before it happens rather than after.
 *
 * Order is the order of `categories`. There is no `order` field and there must not be one: the array
 * already drives the launcher's tabs and its 1-9 keys, so a second notion of order would be a second
 * answer to a question the file already answers.
 */
export class ProjectsSettingsModel {
  static initial(): ProjectsSettingsStep {
    return {
      state: {
        loaded: null,
        buffer: null,
        staleOnDisk: false,
        reloading: false,
        saving: null,
        asking: null,
        problem: null,
        expanded: new Set(),
      },
      effects: [{ effect: 'load' }],
    }
  }

  /** Measured against the roots that were loaded, never against an empty list. */
  static isModified(state: ProjectsSettingsState): boolean {
    if (state.buffer === null)
      return false
    return JSON.stringify(state.buffer) !== JSON.stringify(state.loaded)
  }

  static categoriesOf(state: ProjectsSettingsState): readonly CatalogCategoryDto[] {
    return state.buffer ?? []
  }

  static foldersOf(category: CatalogCategoryDto): readonly VirtualFolderDef[] {
    return category.virtualFolders ?? []
  }

  /**
   * What a save would be refused for, said here instead of after the write. It mirrors
   * `CatalogSection.virtualFoldersProblem`, which trims before it measures, so a prefix of spaces is
   * as empty here as it is there.
   *
   * A duplicate prefix is deliberately NOT one of these. The store accepts it, V1 accepted it, and
   * the grouping puts such a project in both folders - so it is a thing worth pointing at and not a
   * thing this one screen gets to forbid.
   */
  static folderProblemsOf(category: CatalogCategoryDto): ReadonlyMap<number, string> {
    const problems = new Map<number, string>()
    const seen = new Map<string, number>()
    ProjectsSettingsModel.foldersOf(category).forEach((folder, index) => {
      if (!ProjectsSettingsModel.isComplete(folder)) {
        problems.set(index, 'A folder needs both a prefix and a name; this one cannot be saved.')
        return
      }
      // Trimmed, so a hand-written `"house "` beside a `"house"` is the pair it actually is.
      const prefix = folder.prefix.trim()
      const first = seen.get(prefix)
      if (first === undefined) seen.set(prefix, index)
      else
        problems.set(
          index,
          `The same prefix as folder ${first + 1}: a project matching it lands in both.`,
        )
    })
    return problems
  }

  /** Every folder of every root has to be savable, because a save writes the whole section. */
  static isSavable(state: ProjectsSettingsState): boolean {
    if (state.buffer === null) return false
    return ProjectsSettingsModel.categoriesOf(state).every((category) =>
      ProjectsSettingsModel.foldersOf(category).every(ProjectsSettingsModel.isComplete))
  }

  /** The one spelling of the store's rule, so what disables Save and what marks the row cannot part. */
  private static isComplete(folder: VirtualFolderDef): boolean {
    return folder.prefix.trim().length > 0 && folder.title.trim().length > 0
  }

  static transition(
    state: ProjectsSettingsState,
    input: ProjectsSettingsInput,
  ): ProjectsSettingsStep {
    if (input.input === 'loaded') return ProjectsSettingsModel.arrived(state, input.categories)
    else if (input.input === 'failed')
      return ProjectsSettingsModel.step({
        ...state,
        reloading: false,
        saving: null,
        problem: input.detail,
      })
    else if (input.input === 'add-requested')
      return ProjectsSettingsModel.step(state, { effect: 'pick-directory' })
    else if (input.input === 'add') return ProjectsSettingsModel.added(state, input.path)
    else if (input.input === 'rename') return ProjectsSettingsModel.renamed(state, input.id, input.label)
    else if (input.input === 'move') return ProjectsSettingsModel.moved(state, input.id, input.delta)
    else if (input.input === 'remove')
      return ProjectsSettingsModel.step({ ...state, asking: { ask: 'remove', id: input.id } })
    else if (input.input === 'folders-toggled') return ProjectsSettingsModel.toggled(state, input.id)
    else if (input.input === 'folder-added') return ProjectsSettingsModel.folderAdded(state, input.id)
    else if (input.input === 'folder-changed')
      return ProjectsSettingsModel.folderChanged(state, input)
    else if (input.input === 'folder-removed')
      return ProjectsSettingsModel.folderRemoved(state, input.id, input.index)
    else if (input.input === 'answered') return ProjectsSettingsModel.answered(state, input.yes)
    else if (input.input === 'save') return ProjectsSettingsModel.saveRequested(state)
    else if (input.input === 'saved') return ProjectsSettingsModel.saved(state, input.ok, input.detail)
    else if (input.input === 'reload-requested') return ProjectsSettingsModel.reloadRequested(state)
    else
      throw new Error(`Unknown projects settings input: ${JSON.stringify(input)}`)
  }

  /**
   * The one place R8 lives. A clean buffer takes the roots that arrived, because there is nothing of
   * the user's in it to lose. A modified one keeps every edit and only learns that the file moved.
   */
  private static arrived(
    state: ProjectsSettingsState,
    categories: readonly CatalogCategoryDto[],
  ): ProjectsSettingsStep {
    if (state.reloading || !ProjectsSettingsModel.isModified(state))
      return ProjectsSettingsModel.step({
        ...state,
        loaded: categories,
        buffer: categories,
        staleOnDisk: false,
        reloading: false,
        asking: null,
      })
    return ProjectsSettingsModel.step({ ...state, loaded: categories, staleOnDisk: true })
  }

  private static added(state: ProjectsSettingsState, path: string): ProjectsSettingsStep {
    const buffer = state.buffer
    if (!buffer)
      return ProjectsSettingsModel.step(state)
    const category: CatalogCategoryDto = {
      id: ProjectsSettingsModel.idFor(path, new Set(buffer.map((entry) => entry.id))),
      label: ProjectsSettingsModel.labelFor(path),
      path,
    }
    return ProjectsSettingsModel.step({ ...state, buffer: [...buffer, category] })
  }

  /** Only the label. The id is what everything binds to, so nothing but an add ever writes one. */
  private static renamed(
    state: ProjectsSettingsState,
    id: string,
    label: string,
  ): ProjectsSettingsStep {
    const buffer = state.buffer
    if (!buffer)
      return ProjectsSettingsModel.step(state)
    return ProjectsSettingsModel.step({
      ...state,
      buffer: buffer.map((category) => (category.id === id ? { ...category, label } : category)),
    })
  }

  /** Nothing of the document's; a block left open is not a change anybody could lose. */
  private static toggled(state: ProjectsSettingsState, id: string): ProjectsSettingsStep {
    const expanded = new Set(state.expanded)
    if (!expanded.delete(id)) expanded.add(id)
    return ProjectsSettingsModel.step({ ...state, expanded })
  }

  /**
   * An empty pair, which is exactly what the row then asks the user to fill in. Save is disabled
   * until they do, because the store refuses a folder without both halves.
   */
  private static folderAdded(state: ProjectsSettingsState, id: string): ProjectsSettingsStep {
    const expanded = new Set(state.expanded).add(id)
    return ProjectsSettingsModel.step({
      ...ProjectsSettingsModel.withFolders(
        state,
        id,
        (folders) => [...folders, { prefix: '', title: '' }],
      ),
      expanded,
    })
  }

  private static folderChanged(
    state: ProjectsSettingsState,
    input: Extract<ProjectsSettingsInput, { input: 'folder-changed' }>,
  ): ProjectsSettingsStep {
    const value = ProjectsSettingsModel.folderValueOf(input.field, input.value)
    return ProjectsSettingsModel.step(ProjectsSettingsModel.withFolders(
      state,
      input.id,
      (folders) => folders.map((folder, index) =>
        (index === input.index ? { ...folder, [input.field]: value } : folder)),
    ))
  }

  /**
   * What is stored is what everything measures: the prefix is trimmed here because every check of it
   * trims first, so `"house "` - a plausible paste - passed all of them and then matched no directory
   * ever, with nothing on screen saying why the folder stayed empty.
   *
   * A TITLE cannot be trimmed here, because a title has words in it: trimming each keystroke eats the
   * space between "House" and "projects" as it is typed, so the two halves are trimmed together at
   * the save instead - see `normalised`.
   */
  private static folderValueOf(field: 'prefix' | 'title', value: string): string {
    if (field === 'prefix') return value.trim()
    else if (field === 'title') return value
    else
      throw new Error(`Unknown folder field: ${JSON.stringify(field)}`)
  }

  /**
   * Nothing on disk changes and nothing is renamed: the projects that matched this prefix simply
   * stop being grouped and stand in the flat list again, under the names they always had. That is
   * why this asks nothing, unlike removing a root.
   */
  private static folderRemoved(
    state: ProjectsSettingsState,
    id: string,
    index: number,
  ): ProjectsSettingsStep {
    return ProjectsSettingsModel.step(ProjectsSettingsModel.withFolders(
      state,
      id,
      (folders) => folders.filter((_folder, at) => at !== index),
    ))
  }

  /**
   * The key is written only while there are folders to hold. A category that never had one keeps a
   * file without it, and the last removal takes it away again - an empty array in a hand-edited file
   * is a line nobody wrote.
   */
  private static withFolders(
    state: ProjectsSettingsState,
    id: string,
    change: (folders: readonly VirtualFolderDef[]) => readonly VirtualFolderDef[],
  ): ProjectsSettingsState {
    const buffer = state.buffer
    if (!buffer) return state
    return {
      ...state,
      buffer: buffer.map((category) => {
        if (category.id !== id) return category
        const folders = change(ProjectsSettingsModel.foldersOf(category))
        if (folders.length > 0) return { ...category, virtualFolders: [...folders] }
        const { virtualFolders: _dropped, ...rest } = category
        return rest
      }),
    }
  }

  /** An index in the array and nothing else; at either end there is nowhere to go, so nothing moves. */
  private static moved(
    state: ProjectsSettingsState,
    id: string,
    delta: -1 | 1,
  ): ProjectsSettingsStep {
    const buffer = state.buffer
    if (!buffer)
      return ProjectsSettingsModel.step(state)
    const from = buffer.findIndex((category) => category.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= buffer.length)
      return ProjectsSettingsModel.step(state)
    const categories = [...buffer]
    const [taken] = categories.splice(from, 1)
    categories.splice(to, 0, taken)
    return ProjectsSettingsModel.step({ ...state, buffer: categories })
  }

  /**
   * A reload while there is nothing to lose just reads the file, which is what makes editing
   * config.json by hand with the window open work. While there is, it asks: a button that throws an
   * edit away without a word is the loss this whole model exists to prevent.
   */
  private static reloadRequested(state: ProjectsSettingsState): ProjectsSettingsStep {
    if (ProjectsSettingsModel.isModified(state))
      return ProjectsSettingsModel.step({ ...state, asking: { ask: 'discard-and-reload' } })
    return ProjectsSettingsModel.step(
      { ...state, reloading: true, asking: null, problem: null },
      { effect: 'load' },
    )
  }

  /** Every question is two steps, and a "no" always costs nothing. */
  private static answered(state: ProjectsSettingsState, yes: boolean): ProjectsSettingsStep {
    const asking = state.asking
    if (asking === null || !yes)
      return ProjectsSettingsModel.step({ ...state, asking: null })
    if (asking.ask === 'remove') return ProjectsSettingsModel.removed(state, asking.id)
    else if (asking.ask === 'discard-and-reload')
      return ProjectsSettingsModel.step(
        { ...state, reloading: true, asking: null, problem: null },
        { effect: 'load' },
      )
    else
      throw new Error(`Unknown projects settings question: ${JSON.stringify(asking)}`)
  }

  /**
   * Destructive in a way the file does not show: nothing on disk is deleted, and everything bound to
   * the category through its id is left pointing at nothing.
   */
  private static removed(state: ProjectsSettingsState, id: string): ProjectsSettingsStep {
    const buffer = state.buffer
    if (!buffer)
      return ProjectsSettingsModel.step({ ...state, asking: null })
    return ProjectsSettingsModel.step({
      ...state,
      asking: null,
      buffer: buffer.filter((category) => category.id !== id),
    })
  }

  /** A second save while the first is in flight would race two writers over one file. */
  private static saveRequested(state: ProjectsSettingsState): ProjectsSettingsStep {
    const buffer = state.buffer
    if (!buffer || state.saving !== null)
      return ProjectsSettingsModel.step(state)
    const categories = ProjectsSettingsModel.normalised(buffer)
    // The buffer takes the trimmed roots too, so what is on screen is what was written: leaving the
    // typed ones there would make `isModified` true against the section it just saved, and the tab
    // would stay dirty over a space nobody can see.
    return ProjectsSettingsModel.step(
      { ...state, buffer: categories, saving: categories, problem: null },
      { effect: 'save', categories },
    )
  }

  /**
   * A folder's two halves as the store will read them. The prefix is already trimmed on write, and
   * the title is trimmed here for the same reason: `"House projects "` names the same folder as
   * `"House projects"`, and a trailing space is invisible in the field that produced it.
   */
  private static normalised(categories: readonly CatalogCategoryDto[]): CatalogCategoryDto[] {
    return categories.map((category) => {
      const folders = ProjectsSettingsModel.foldersOf(category)
      if (folders.length === 0)
        return category
      return {
        ...category,
        virtualFolders: folders.map((folder) => ({
          prefix: folder.prefix.trim(),
          title: folder.title.trim(),
        })),
      }
    })
  }

  /**
   * A refused save keeps the buffer: the store wrote nothing, so throwing the edits away would lose
   * work over a refusal the user can still answer. A written one makes the WRITTEN roots the new
   * yardstick - not whatever the buffer holds now - which is also what clears the tab's dirty mark.
   */
  private static saved(
    state: ProjectsSettingsState,
    ok: boolean,
    detail?: string,
  ): ProjectsSettingsStep {
    if (!ok)
      return ProjectsSettingsModel.step({ ...state, saving: null, problem: detail ?? 'Save refused' })
    return ProjectsSettingsModel.step({
      ...state,
      saving: null,
      loaded: state.saving,
      staleOnDisk: false,
      problem: null,
    })
  }

  /**
   * Derived from the directory's own name, not from a random one: the id is what sessions, projects
   * and the launcher's keys bind to, it is written into a file people edit by hand, and it is never
   * rewritten afterwards - a rename touches the label alone. A name already taken gets a counted
   * suffix, so the store's refusal of duplicate ids cannot be reached by adding two roots that end
   * in the same folder name.
   */
  private static idFor(path: string, taken: ReadonlySet<string>): string {
    const base = ProjectsSettingsModel.slug(ProjectsSettingsModel.leafOf(path))
    let candidate = base
    let suffix = 2
    while (taken.has(candidate)) {
      candidate = `${base}-${suffix}`
      suffix++
    }
    return candidate
  }

  private static labelFor(path: string): string {
    return ProjectsSettingsModel.leafOf(path) || path
  }

  private static leafOf(path: string): string {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
    return segments[segments.length - 1] ?? ''
  }

  /** A name written in a script that folds to nothing still needs a non-empty id of some sort. */
  private static slug(name: string): string {
    const slug = Slug.of(name)
    return slug.length > 0 ? slug : 'root'
  }

  private static step(
    state: ProjectsSettingsState,
    ...effects: readonly ProjectsSettingsEffect[]
  ): ProjectsSettingsStep {
    return { state, effects }
  }
}
