/**
 * Test helper: install a stub dockview API into the real `useLayoutStore`
 * so panel components that read `useLayoutStore.getState().dockviewApi`
 * (RecentFilesPanel, CommandPalette, …) can be exercised without a real
 * dockview instance.
 *
 * The stub's `addPanel` records each call AND pushes a findable panel
 * (with `updateParameters` / `setActive` spies) into `panels`, so a
 * component that re-opens the same id hits the "existing panel" branch —
 * exactly the path the panel-id collision regression needs to assert.
 */

import { vi } from 'vitest'
import { useLayoutStore } from '../store/layout-store'

export interface StubPanel {
  id: string
  api: {
    updateParameters: ReturnType<typeof vi.fn>
    setActive: ReturnType<typeof vi.fn>
  }
}

export interface MockDockviewApi {
  panels: StubPanel[]
  addPanel: ReturnType<typeof vi.fn>
}

/**
 * Build the stub, install it into the store, and return it for assertions.
 * Call `restoreLayoutStore()` in afterEach to clear it.
 */
export function mockLayoutStore(): MockDockviewApi {
  const panels: StubPanel[] = []
  const addPanel = vi.fn((opts: { id: string }) => {
    const panel: StubPanel = {
      id: opts.id,
      api: { updateParameters: vi.fn(), setActive: vi.fn() },
    }
    panels.push(panel)
    return panel
  })
  const api: MockDockviewApi = { panels, addPanel }
  // The store types dockviewApi as DockviewApi; the stub implements only
  // the slice panel code touches, so cast through unknown.
  useLayoutStore.setState({ dockviewApi: api as unknown as never })
  return api
}

export function restoreLayoutStore(): void {
  useLayoutStore.setState({ dockviewApi: null })
}
