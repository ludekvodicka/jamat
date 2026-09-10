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

  it.each(['svn', 'git', 'checkpoint', 'worktree-base'] as const)('offers Commit only for a writable %s source', (source) => {
    const open = vi.fn()
    render(<FileToolsSidebar sessionId="session" documentId={null} selected="workingTree" changes={changesConst}
      workingTree={{ ...workingConst, selectedSource: source }} onSelect={vi.fn()} onOpenChanged={vi.fn()} onOpenDocument={vi.fn()} onOpenCommit={open} />)
    const commit = screen.queryByRole('button', { name: 'Commit…' })
    if (source === 'svn' || source === 'git') {
      expect(commit).not.toBeNull()
      fireEvent.click(commit!)
      expect(open).toHaveBeenCalledWith(source)
    } else if (source === 'checkpoint' || source === 'worktree-base') expect(commit).toBeNull()
    else throw new Error(`Unexpected source ${source}`)
  })

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
