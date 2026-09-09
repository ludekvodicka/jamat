import { describe, expect, it } from 'vitest'

import type {
  CatalogCategoryDto,
} from '../../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import {
  ProjectsSettingsModel,
  type ProjectsSettingsEffect,
  type ProjectsSettingsInput,
  type ProjectsSettingsState,
} from './projectsSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/projects/projectsSettingsModel', () => {
  /** Two roots, one of them carrying a key nobody in this app knows about. */
  function roots(): CatalogCategoryDto[] {
    return [
      {
        id: 'nodejs',
        label: 'NodeJs',
        path: 'C:/Projects/NodeJs',
        hiddenFolders: ['node_modules'],
        futureCategoryKey: { kept: true },
      },
      { id: 'web', label: 'Web', path: 'C:/Projects/Web' },
    ]
  }

  function loaded(): ProjectsSettingsState {
    return ProjectsSettingsModel.transition(
      ProjectsSettingsModel.initial().state,
      { input: 'loaded', categories: roots() },
    ).state
  }

  function run(
    state: ProjectsSettingsState,
    ...inputs: readonly ProjectsSettingsInput[]
  ): { state: ProjectsSettingsState; effects: ProjectsSettingsEffect[] } {
    let carried = state
    const effects: ProjectsSettingsEffect[] = []
    for (const input of inputs) {
      const step = ProjectsSettingsModel.transition(carried, input)
      carried = step.state
      effects.push(...step.effects)
    }
    return { state: carried, effects }
  }

  function idsOf(state: ProjectsSettingsState): string[] {
    return ProjectsSettingsModel.categoriesOf(state).map((category) => category.id)
  }

  it('asks for the roots before it can draw anything', () => {
    const start = ProjectsSettingsModel.initial()

    expect(start.state.buffer).toBeNull()
    expect(start.effects).toEqual([{ effect: 'load' }])
    expect(ProjectsSettingsModel.isModified(start.state)).toBe(false)
  })

  it('refuses an input it does not know', () => {
    expect(() => ProjectsSettingsModel.transition(
      loaded(),
      { input: 'nonsense' } as unknown as ProjectsSettingsInput,
    )).toThrow(/Unknown projects settings input/)
  })

  /**
   * `CatalogCategoryDto` carries `[key: string]: unknown` and the file is edited by hand, so a key
   * inside a root has to come back out of a save unchanged. What stands BESIDE the section never
   * enters this buffer at all: the store merges the roots into the raw document, so nothing here
   * can delete a foreign section by leaving it out.
   */
  it('carries a key no build knows on a root through an edit and into the save', () => {
    const edited = run(
      loaded(),
      { input: 'rename', id: 'nodejs', label: 'Node' },
      { input: 'move', id: 'web', delta: -1 },
      { input: 'save' },
    )

    expect(edited.effects).toEqual([{
      effect: 'save',
      categories: [
        { id: 'web', label: 'Web', path: 'C:/Projects/Web' },
        {
          id: 'nodejs',
          label: 'Node',
          path: 'C:/Projects/NodeJs',
          hiddenFolders: ['node_modules'],
          futureCategoryKey: { kept: true },
        },
      ],
    }])
  })

  it('adds a root the picker chose, with an id read off the directory itself', () => {
    const added = run(loaded(), { input: 'add', path: 'C:/Projects/Ai' })

    expect(idsOf(added.state)).toEqual(['nodejs', 'web', 'ai'])
    expect(ProjectsSettingsModel.categoriesOf(added.state)[2])
      .toEqual({ id: 'ai', label: 'Ai', path: 'C:/Projects/Ai' })
  })

  // Everything binds to a category through its id, so two roots that end in the same folder name
  // must not end up sharing one - the store refuses a duplicate, and the second root would be lost.
  it('counts up an id whose name is already taken, and always spells one', () => {
    const added = run(
      loaded(),
      { input: 'add', path: 'D:/mirror/ProjectsNodeJs' },
      { input: 'add', path: 'E:/backup/projects nodejs' },
      // Accents fold; a name with no ASCII form at all still gets an id; a drive keeps its letter.
      { input: 'add', path: 'Q:/Projekty/Zákazníci' },
      { input: 'add', path: 'Q:/Projekty/项目' },
      { input: 'add', path: 'F:\\' },
    )

    expect(idsOf(added.state)).toEqual([
      'nodejs', 'web', 'projectsnodejs', 'projects-nodejs', 'zakaznici', 'root', 'f',
    ])
    expect(ProjectsSettingsModel.categoriesOf(added.state).map((category) => category.label))
      .toEqual([
        'NodeJs', 'Web', 'ProjectsNodeJs', 'projects nodejs',
        'Zákazníci', '项目', 'F:',
      ])
  })

  it('renames the label and never the id', () => {
    const renamed = run(loaded(), { input: 'rename', id: 'nodejs', label: 'Node projects' })

    expect(ProjectsSettingsModel.categoriesOf(renamed.state)[0])
      .toMatchObject({ id: 'nodejs', label: 'Node projects' })
    expect(ProjectsSettingsModel.isModified(renamed.state)).toBe(true)
  })

  it('moves a root by one index', () => {
    const moved = run(loaded(), { input: 'move', id: 'web', delta: -1 })

    expect(idsOf(moved.state)).toEqual(['web', 'nodejs'])
  })

  // At either end there is nowhere to go. Not "moves and clamps": the document must come out of it
  // unchanged, or an arrow at the end of the list would mark the tab dirty for doing nothing.
  it('does nothing at either end of the list, and nothing for a root that is not there', () => {
    const start = loaded()

    const up = run(start, { input: 'move', id: 'nodejs', delta: -1 })
    const down = run(start, { input: 'move', id: 'web', delta: 1 })
    const absent = run(start, { input: 'move', id: 'ghost', delta: 1 })

    for (const attempt of [up, down, absent]) {
      expect(idsOf(attempt.state)).toEqual(['nodejs', 'web'])
      expect(ProjectsSettingsModel.isModified(attempt.state)).toBe(false)
    }
  })

  it('asks before it removes a root, and drops the question when it is refused', () => {
    const asked = run(loaded(), { input: 'remove', id: 'web' })
    expect(asked.state.asking).toEqual({ ask: 'remove', id: 'web' })
    expect(idsOf(asked.state)).toEqual(['nodejs', 'web'])

    const kept = run(asked.state, { input: 'answered', yes: false })
    expect(kept.state.asking).toBeNull()
    expect(idsOf(kept.state)).toEqual(['nodejs', 'web'])

    const removed = run(asked.state, { input: 'answered', yes: true })
    expect(removed.state.asking).toBeNull()
    expect(idsOf(removed.state)).toEqual(['nodejs'])
    expect(ProjectsSettingsModel.isModified(removed.state)).toBe(true)
  })

  it('re-seeds a clean buffer from the roots that arrive', () => {
    const second: CatalogCategoryDto[] = [
      { id: 'solidity', label: 'Solidity', path: 'C:/Projects/Solidity' },
    ]

    const arrived = run(loaded(), { input: 'loaded', categories: second })

    expect(idsOf(arrived.state)).toEqual(['solidity'])
    expect(arrived.state.staleOnDisk).toBe(false)
    expect(ProjectsSettingsModel.isModified(arrived.state)).toBe(false)
  })

  /**
   * R8, and the whole reason this model exists: in V2 a re-seed like this one landed on top of a
   * modified buffer and the user's edits were gone with no trace.
   */
  it('never replaces a modified buffer, and says the file moved instead', () => {
    const edited = run(loaded(), { input: 'rename', id: 'nodejs', label: 'Node' }).state
    const onDisk: CatalogCategoryDto[] = [
      { id: 'someone-else', label: 'Elsewhere', path: 'Q:/Elsewhere' },
    ]

    const arrived = run(edited, { input: 'loaded', categories: onDisk })

    expect(idsOf(arrived.state)).toEqual(['nodejs', 'web'])
    expect(ProjectsSettingsModel.categoriesOf(arrived.state)[0].label).toBe('Node')
    expect(arrived.state.staleOnDisk).toBe(true)
    expect(ProjectsSettingsModel.isModified(arrived.state)).toBe(true)
  })

  it('replaces the buffer once the reload was asked for out loud', () => {
    const stale = run(
      loaded(),
      { input: 'rename', id: 'nodejs', label: 'Node' },
      { input: 'loaded', categories: [] },
    ).state

    // The reload costs the edits, so it asks first and reads nothing until it is answered.
    const asked = run(stale, { input: 'reload-requested' })
    expect(asked.effects).toEqual([])
    expect(asked.state.asking).toEqual({ ask: 'discard-and-reload' })

    const reload = run(asked.state, { input: 'answered', yes: true })
    expect(reload.effects).toEqual([{ effect: 'load' }])
    expect(idsOf(reload.state)).toEqual(['nodejs', 'web'])

    const back = run(reload.state, {
      input: 'loaded',
      categories: [{ id: 'x', label: 'X', path: 'Q:/X' }],
    })
    expect(idsOf(back.state)).toEqual(['x'])
    expect(back.state.staleOnDisk).toBe(false)
    expect(ProjectsSettingsModel.isModified(back.state)).toBe(false)
  })

  // Nothing to lose, nothing to ask about: this is what makes editing config.json by hand with the
  // window open work.
  it('reads the file straight back when the buffer holds nothing of the user’s', () => {
    const reload = run(loaded(), { input: 'reload-requested' })

    expect(reload.state.asking).toBeNull()
    expect(reload.state.reloading).toBe(true)
    expect(reload.effects).toEqual([{ effect: 'load' }])
  })

  it('keeps every edit when the question about discarding them is refused', () => {
    const edited = run(loaded(), { input: 'rename', id: 'nodejs', label: 'Node' }).state

    const kept = run(edited, { input: 'reload-requested' }, { input: 'answered', yes: false })

    expect(kept.effects).toEqual([])
    expect(kept.state.asking).toBeNull()
    expect(ProjectsSettingsModel.categoriesOf(kept.state)[0].label).toBe('Node')
  })

  // A reload that never arrives must not take the edits with it, which is why the reload is a flag
  // rather than an emptied buffer.
  it('keeps the buffer when the reload it asked for fails', () => {
    const edited = run(loaded(), { input: 'rename', id: 'nodejs', label: 'Node' }).state

    const failed = run(
      edited,
      { input: 'reload-requested' },
      { input: 'answered', yes: true },
      { input: 'failed', detail: 'main process is gone' },
    )

    expect(ProjectsSettingsModel.categoriesOf(failed.state)[0].label).toBe('Node')
    expect(failed.state.reloading).toBe(false)
    expect(failed.state.problem).toBe('main process is gone')
  })

  it('asks the picker for a directory rather than inventing a path', () => {
    expect(run(loaded(), { input: 'add-requested' }).effects)
      .toEqual([{ effect: 'pick-directory' }])
  })

  it('sends the whole buffer to the save and marks the tab clean once it lands', () => {
    const edited = run(loaded(), { input: 'rename', id: 'web', label: 'Web projects' }).state

    const saving = run(edited, { input: 'save' })
    expect(saving.effects).toEqual([{ effect: 'save', categories: saving.state.buffer }])
    expect(saving.state.saving).toBe(saving.state.buffer)

    const done = run(saving.state, { input: 'saved', ok: true })
    expect(done.state.saving).toBeNull()
    expect(ProjectsSettingsModel.isModified(done.state)).toBe(false)
    expect(done.state.problem).toBeNull()
  })

  it('refuses a second save while the first is still writing', () => {
    const saving = run(loaded(), { input: 'add', path: 'C:/Projects/Ai' }, { input: 'save' }).state

    expect(run(saving, { input: 'save' }).effects).toEqual([])
  })

  /**
   * An edit made while the write was in flight is not on disk. The written document becomes the
   * yardstick, so the tab stays dirty over exactly the part that was not saved.
   */
  it('keeps the tab dirty over an edit made while the save was in flight', () => {
    const saving = run(loaded(), { input: 'rename', id: 'web', label: 'Web projects' }, { input: 'save' }).state

    const later = run(
      saving,
      { input: 'rename', id: 'nodejs', label: 'Node' },
      { input: 'saved', ok: true },
    )

    expect(ProjectsSettingsModel.isModified(later.state)).toBe(true)
    expect(later.state.loaded?.find((category) => category.id === 'nodejs')?.label)
      .toBe('NodeJs')
  })

  // R9: the store refused, so the file still holds the other version. Dropping the buffer here would
  // be the silent reconciliation the rule forbids.
  it('keeps the buffer and shows what the store said when a save is refused', () => {
    const edited = run(loaded(), { input: 'rename', id: 'web', label: 'Web projects' }, { input: 'save' }).state

    const refused = run(edited, {
      input: 'saved',
      ok: false,
      detail: 'catalog-latched: Catalog at Q:/config.json is unreadable',
    })

    expect(refused.state.problem).toContain('catalog-latched')
    expect(ProjectsSettingsModel.categoriesOf(refused.state)[1].label).toBe('Web projects')
    expect(ProjectsSettingsModel.isModified(refused.state)).toBe(true)
    expect(refused.state.saving).toBeNull()
  })

  it('leaves every edit alone until a document has arrived', () => {
    const empty = ProjectsSettingsModel.initial().state

    const touched = run(
      empty,
      { input: 'add', path: 'C:/Projects/Ai' },
      { input: 'rename', id: 'nodejs', label: 'Node' },
      { input: 'move', id: 'nodejs', delta: 1 },
      { input: 'remove', id: 'nodejs' },
      { input: 'answered', yes: true },
      { input: 'save' },
      { input: 'folder-added', id: 'nodejs' },
      { input: 'folder-changed', id: 'nodejs', index: 0, field: 'prefix', value: 'house' },
      { input: 'folder-removed', id: 'nodejs', index: 0 },
    )

    expect(touched.state.buffer).toBeNull()
    expect(touched.effects).toEqual([])
  })

  describe('virtual folders', () => {
    function foldersOf(state: ProjectsSettingsState, id: string) {
      const category = ProjectsSettingsModel.categoriesOf(state).find((entry) => entry.id === id)
      if (!category) throw new Error(`No category ${id}`)
      return category
    }

    function named(state: ProjectsSettingsState, id: string): [string, string][] {
      return ProjectsSettingsModel.foldersOf(foldersOf(state, id))
        .map((folder) => [folder.prefix, folder.title])
    }

    /**
     * An empty array in a hand-edited file is a line nobody wrote, so the key exists exactly while
     * there is a folder to hold.
     */
    it('writes the key with the first folder and takes it away with the last', () => {
      const added = run(loaded(), { input: 'folder-added', id: 'web' })

      expect(foldersOf(added.state, 'web').virtualFolders).toEqual([{ prefix: '', title: '' }])

      const removed = run(added.state, { input: 'folder-removed', id: 'web', index: 0 })

      expect('virtualFolders' in foldersOf(removed.state, 'web')).toBe(false)
    })

    it('edits one half of one folder of one root', () => {
      const edited = run(
        loaded(),
        { input: 'folder-added', id: 'nodejs' },
        { input: 'folder-added', id: 'nodejs' },
        { input: 'folder-changed', id: 'nodejs', index: 0, field: 'prefix', value: 'house' },
        { input: 'folder-changed', id: 'nodejs', index: 0, field: 'title', value: 'House projects' },
        { input: 'folder-changed', id: 'nodejs', index: 1, field: 'prefix', value: 'temporary' },
      )

      expect(named(edited.state, 'nodejs')).toEqual([['house', 'House projects'], ['temporary', '']])
      expect(named(edited.state, 'web')).toEqual([])
    })

    it('keeps the keys no build knows through a whole round of folder edits', () => {
      const edited = run(
        loaded(),
        { input: 'folder-added', id: 'nodejs' },
        { input: 'folder-changed', id: 'nodejs', index: 0, field: 'prefix', value: 'house' },
        { input: 'folder-changed', id: 'nodejs', index: 0, field: 'title', value: 'House' },
        { input: 'folder-removed', id: 'nodejs', index: 0 },
      )

      expect(foldersOf(edited.state, 'nodejs')['futureCategoryKey']).toEqual({ kept: true })
      expect(foldersOf(edited.state, 'nodejs').hiddenFolders).toEqual(['node_modules'])
      // Back to what was loaded, so nothing is left to save.
      expect(ProjectsSettingsModel.isModified(edited.state)).toBe(false)
    })

    // The store refuses a folder without both halves, so a Save that could only come back as
    // invalid-config is a button that lies.
    it('is unsavable while any folder of any root is missing a half', () => {
      const half = run(
        loaded(),
        { input: 'folder-added', id: 'web' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'prefix', value: 'house' },
      )

      expect(ProjectsSettingsModel.isSavable(half.state)).toBe(false)
      expect(ProjectsSettingsModel.folderProblemsOf(foldersOf(half.state, 'web')).get(0))
        .toContain('cannot be saved')

      const whole = run(
        half.state,
        { input: 'folder-changed', id: 'web', index: 0, field: 'title', value: 'House' },
      )

      expect(ProjectsSettingsModel.isSavable(whole.state)).toBe(true)
      expect(ProjectsSettingsModel.folderProblemsOf(foldersOf(whole.state, 'web')).size).toBe(0)
    })

    // The store trims before it measures, so a prefix of spaces is as empty here as it is there.
    it('counts a folder of nothing but spaces as missing', () => {
      const spaces = run(
        loaded(),
        { input: 'folder-added', id: 'web' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'prefix', value: '   ' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'title', value: 'House' },
      )

      expect(ProjectsSettingsModel.isSavable(spaces.state)).toBe(false)
    })

    /**
     * `"house "` - a plausible paste - passed every check, which all trim before they measure, and
     * then matched no directory ever with nothing on screen saying why the folder stayed empty. The
     * title is not trimmed as it is typed, because trimming each keystroke eats the space between
     * two words while they are being written.
     */
    it('stores the prefix trimmed and the title as it was typed', () => {
      const padded = run(
        loaded(),
        { input: 'folder-added', id: 'web' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'prefix', value: '  house  ' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'title', value: ' House ' },
      )

      expect(named(padded.state, 'web')).toEqual([['house', ' House ']])
      expect(ProjectsSettingsModel.isSavable(padded.state)).toBe(true)
    })

    /**
     * The save is where the title catches up with the prefix: a trailing space is invisible in the
     * field that produced it, and the two halves name one folder. The buffer takes the trimmed
     * document too, or the tab would stay dirty against the file it had just written.
     */
    it('trims both halves at the save, and leaves the words inside a title alone', () => {
      const padded = run(
        loaded(),
        { input: 'folder-added', id: 'web' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'prefix', value: 'house' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'title', value: ' House projects ' },
        { input: 'save' },
      )

      expect(named(padded.state, 'web')).toEqual([['house', 'House projects']])
      expect(padded.effects).toContainEqual({ effect: 'save', categories: padded.state.buffer })

      const written = run(padded.state, { input: 'saved', ok: true })
      expect(ProjectsSettingsModel.isModified(written.state)).toBe(false)
    })

    /** Nothing writes an untrimmed prefix any more; a file edited by hand still can. */
    it('reads a padded prefix and an unpadded one as the same prefix', () => {
      const problems = ProjectsSettingsModel.folderProblemsOf({
        id: 'web',
        label: 'Web',
        path: 'C:/Projects/Web',
        virtualFolders: [{ prefix: 'house', title: 'House' }, { prefix: 'house ', title: 'Home' }],
      })

      expect(problems.get(1)).toContain('folder 1')
    })

    /**
     * The store accepts it and V1 accepted it: a project matching two prefixes lands in both
     * folders. Worth pointing at, not something this one screen gets to forbid.
     */
    it('warns about a repeated prefix without refusing to save it', () => {
      const twice = run(
        loaded(),
        { input: 'folder-added', id: 'web' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'prefix', value: 'house' },
        { input: 'folder-changed', id: 'web', index: 0, field: 'title', value: 'House' },
        { input: 'folder-added', id: 'web' },
        { input: 'folder-changed', id: 'web', index: 1, field: 'prefix', value: 'house' },
        { input: 'folder-changed', id: 'web', index: 1, field: 'title', value: 'Home' },
      )

      const problems = ProjectsSettingsModel.folderProblemsOf(foldersOf(twice.state, 'web'))
      expect(problems.get(1)).toContain('folder 1')
      expect(problems.has(0)).toBe(false)
      expect(ProjectsSettingsModel.isSavable(twice.state)).toBe(true)
    })

    it('opens and closes a block without making the tab look modified', () => {
      const opened = run(loaded(), { input: 'folders-toggled', id: 'nodejs' })

      expect(opened.state.expanded.has('nodejs')).toBe(true)
      expect(ProjectsSettingsModel.isModified(opened.state)).toBe(false)

      const closed = run(opened.state, { input: 'folders-toggled', id: 'nodejs' })

      expect(closed.state.expanded.has('nodejs')).toBe(false)
    })

    /** Adding a folder to a collapsed root would otherwise put a row where nothing can be seen. */
    it('opens the block it just added a folder to', () => {
      const added = run(loaded(), { input: 'folder-added', id: 'web' })

      expect(added.state.expanded.has('web')).toBe(true)
    })

    // R8 is one rule for the whole section, and folders are part of it.
    it('does not let the roots from disk replace edited folders', () => {
      const edited = run(loaded(), { input: 'folder-added', id: 'nodejs' })

      const arrived = run(edited.state, { input: 'loaded', categories: roots() })

      expect(arrived.state.staleOnDisk).toBe(true)
      expect(named(arrived.state, 'nodejs')).toEqual([['', '']])
    })
  })
})
