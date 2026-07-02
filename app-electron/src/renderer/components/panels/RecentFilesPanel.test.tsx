/**
 * Regression: RecentFilesPanel's file-open must be idempotent per file.
 * Pre-fix the panel id was `file-${Date.now()}`, which collided on rapid
 * double-clicks (same millisecond) and could spawn duplicate tabs. The fix
 * uses a deterministic `fileViewerPanelId(projectDir, filePath)` and reuses
 * an existing panel via `updateParameters` + `setActive`.
 *
 * This mounts the real panel against a stub dockview API (via the shared
 * layout-store mock) and fires two clicks on the same item, asserting one
 * addPanel + reuse on the second click.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'
import { RecentFilesPanel } from './RecentFilesPanel'
import { fileViewerPanelId } from '../../utils/terminal-helpers'
import { mockLayoutStore, restoreLayoutStore } from '../../__test-helpers__/layout-store-mock'

const PROJECT = 'Q:\\Proj'
const FILE = 'Q:\\Proj\\src\\index.ts'

afterEach(() => {
  restoreLayoutStore()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).electronAPI
})

function stubRecentFiles(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).electronAPI = {
    listRecentFiles: async () => [
      { path: FILE, name: 'index.ts', mtime: Date.now(), relative: 'src/index.ts' },
    ],
  }
}

describe('RecentFilesPanel panel-id collision regression', () => {
  it('two rapid clicks on the same file open one panel, then reuse it', async () => {
    stubRecentFiles()
    const api = mockLayoutStore()

    const { container } = render(<RecentFilesPanel projectDir={PROJECT} />)

    await waitFor(() => {
      expect(container.querySelectorAll('.recent-file-item').length).toBe(1)
    })
    const item = container.querySelector('.recent-file-item') as HTMLElement

    // First click → addPanel once with the deterministic id.
    fireEvent.click(item)
    expect(api.addPanel).toHaveBeenCalledTimes(1)
    const expectedId = fileViewerPanelId(PROJECT, FILE)
    expect(api.addPanel.mock.calls[0][0].id).toBe(expectedId)

    // Second click → no new panel; reuse via updateParameters + setActive.
    fireEvent.click(item)
    expect(api.addPanel).toHaveBeenCalledTimes(1)
    const existing = api.panels.find((p) => p.id === expectedId)!
    expect(existing.api.updateParameters).toHaveBeenCalledTimes(1)
    expect(existing.api.setActive).toHaveBeenCalledTimes(1)
  })
})
