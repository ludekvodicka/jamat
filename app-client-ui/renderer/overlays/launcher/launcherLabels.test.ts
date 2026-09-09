import { describe, expect, it } from 'vitest'

import type { VirtualFolderDef } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import { LauncherLabels } from './launcherLabels'

describe('app-client-ui/renderer/overlays/launcher/launcherLabels', () => {
  const foldersConst: readonly VirtualFolderDef[] = [
    { prefix: 'house', title: 'House projects' },
    { prefix: 'tmp-', title: 'Scratch' },
  ]

  describe('projectLabelOf', () => {
    it('shows the directory name at the root of a category', () => {
      expect(LauncherLabels.projectLabelOf('houseBazen', null)).toBe('houseBazen')
    })

    // V1 drew `Bazen` inside "House projects": the prefix is the folder, and the folder is the line
    // above the list.
    it('takes the folderprefix off inside the folder', () => {
      expect(LauncherLabels.projectLabelOf('houseBazen', 'house')).toBe('Bazen')
      expect(LauncherLabels.projectLabelOf('houseLoxoneFve', 'house')).toBe('LoxoneFve')
    })

    it('takes a separator prefix off whole', () => {
      expect(LauncherLabels.projectLabelOf('tmp-thing', 'tmp-')).toBe('thing')
    })

    /**
     * Search is flat and crosses categories, so a row drawn while the cursor stands in a folder can
     * belong to a project that does not: it keeps its whole name.
     */
    it('leaves a name that does not carry the prefix alone', () => {
      expect(LauncherLabels.projectLabelOf('AppJamatV3', 'house')).toBe('AppJamatV3')
    })

    // The grouping wants a name longer than its prefix, so this cannot arrive; a blank row would be
    // worse than the full name if it ever did.
    it('keeps the whole name rather than drawing nothing', () => {
      expect(LauncherLabels.projectLabelOf('house', 'house')).toBe('house')
    })

    /**
     * Membership is the word-boundary rule the library groups by, not `startsWith`: `housebazen` is
     * deliberately outside the folder `house`, and a flat search draws it while the cursor stands
     * inside that folder. Drawn as `bazen` it claimed a folder that refused it.
     */
    it('keeps the whole name of a project the folder does not hold', () => {
      expect(LauncherLabels.projectLabelOf('housebazen', 'house')).toBe('housebazen')
      expect(LauncherLabels.projectLabelOf('house_bazen', 'house')).toBe('house_bazen')
    })
  })

  describe('breadcrumbOf', () => {
    it('is the root alone when the cursor is not inside a folder', () => {
      expect(LauncherLabels.breadcrumbOf('NodeJs', foldersConst, null))
        .toBe('NodeJs')
    })

    it('names the folder by its title, not by its prefix', () => {
      expect(LauncherLabels.breadcrumbOf('NodeJs', foldersConst, 'house'))
        .toBe('NodeJs › House projects')
    })

    /** The folder was taken out of the config while the cursor stood in it. */
    it('falls back to the root for a folder nothing names any more', () => {
      expect(LauncherLabels.breadcrumbOf('NodeJs', foldersConst, 'gone'))
        .toBe('NodeJs')
      expect(LauncherLabels.breadcrumbOf('NodeJs', [], 'house'))
        .toBe('NodeJs')
    })
  })
})
