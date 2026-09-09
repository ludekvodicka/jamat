import { describe, expect, it } from 'vitest'

import {
  type DirectoryExplorerPlace,
  directoryExplorerSettingsOf,
} from './directoryExplorer'

/**
 * The settings the explorer derives from its two places rather than exposing impossible mixes.
 * No third combination exists, and one that nobody drew is a loud failure rather than a silent
 * sidebar.
 */
describe('app-client-ui/renderer/fileViewer/directoryExplorer settings', () => {
  it('gives a panel its own path, root and menu', () => {
    expect(directoryExplorerSettingsOf('panel'))
      .toEqual({
        entryContextMenu: true,
        fileActivation: 'doubleClick',
        pathMode: 'absolute',
        rootMode: 'project',
      })
  })

  it('gives the sidebar the workspace root and no entry menu', () => {
    expect(directoryExplorerSettingsOf('sidebar'))
      .toEqual({
        entryContextMenu: false,
        fileActivation: 'click',
        pathMode: 'relative',
        rootMode: 'workspace',
      })
  })

  it('refuses a place it has not drawn', () => {
    expect(() => directoryExplorerSettingsOf('lightbox' as DirectoryExplorerPlace))
      .toThrow(/Unknown directory explorer place/)
  })
})
