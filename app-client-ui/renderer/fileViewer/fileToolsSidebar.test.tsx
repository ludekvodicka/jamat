import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  FileChangesViewModel,
  FileChangesWorkingTreeViewModel,
} from './fileViewerPanel.types'
import { FileToolsSidebar } from './fileToolsSidebar'

describe('app-client-ui/renderer/fileViewer/fileToolsSidebar', () => {
  const changesConst: FileChangesViewModel = {
    snapshot: null,
    groups: [],
    nextCursor: null,
    preferredVcs: null,
    loading: false,
    loadingMore: false,
    error: null,
    reload: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
  }
  const workingConst: FileChangesWorkingTreeViewModel = {
    snapshot: null,
    snapshots: [],
    selectedSource: null,
    loading: false,
    error: null,
    requiredLoading: false,
    requiredError: null,
    select: vi.fn(),
    reload: vi.fn(async () => undefined),
    snapshotFor: () => null,
  }

  it('shows File Changes, Changelog and Explorer in that order', () => {
    const onSelect = vi.fn()
    render(
      <FileToolsSidebar
        sessionId="session-1"
        documentId={null}
        selected="workingTree"
        changes={changesConst}
        workingTree={workingConst}
        onSelect={onSelect}
        onOpenChanged={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent))
      .toEqual(['File Changes', 'Changelog', 'Explorer'])
    expect(screen.getByRole('tab', { name: 'File Changes' })).toHaveAttribute(
      'aria-selected', 'true',
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Changelog' }))
    expect(onSelect).toHaveBeenCalledWith('fileChanges')
  })

  it('renders the old fileChanges key as Changelog', () => {
    const view = render(
      <FileToolsSidebar
        sessionId="session-1"
        documentId={null}
        selected="fileChanges"
        changes={changesConst}
        workingTree={workingConst}
        onSelect={vi.fn()}
        onOpenChanged={vi.fn()}
        onOpenDocument={vi.fn()}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Changelog' })).toHaveAttribute('aria-selected', 'true')
    expect(view.container.querySelector('.file-tools-changes')).not.toBeNull()
  })
})
