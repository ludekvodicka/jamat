import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  FileChangeEntry,
  FileChangeStatus,
  FileChangesSnapshot,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileChangesSort } from './fileChangesSort'
import { FileChangesTime } from './fileChangesTime'
import { FileChangesStatusMark } from './fileChangesStatusMark'
import { FileChangesWidget } from './fileChangesWidget'

describe('app-client-ui/renderer/fileViewer/fileChangesWidget', () => {
  afterEach(cleanup)

  function entryOf(displayPath: string): FileChangeEntry {
    return {
      fileId: displayPath,
      path: `C:/work/${displayPath}`,
      displayPath,
      nodeKind: 'file',
      location: 'workspace',
      status: 'modified',
      previousPath: null,
      previousDisplayPath: null,
      modifiedAt: null,
      sources: ['vcs'],
      gitState: null,
    }
  }

  function snapshotOf(): FileChangesSnapshot {
    return {
      snapshotId: 'snapshot-1',
      sessionId: 'session-1',
      createdAt: 1,
      vcs: {
        requested: 'git', selected: 'git', available: ['git'], root: 'C:/work', fallbackReason: null,
      },
      defaultBaseline: null,
      entries: [entryOf('a.ts'), entryOf('b.ts')],
      history: { groups: [], nextCursor: null },
      warnings: [],
    }
  }

  function modelOf(snapshot: FileChangesSnapshot) {
    return {
      snapshot,
      groups: [],
      nextCursor: null,
      preferredVcs: null,
      loading: false,
      loadingMore: false,
      error: null,
      reload: () => Promise.resolve(),
      loadMore: () => Promise.resolve(),
    }
  }

  /*
   * It was `status.slice(0, 1)` over a ten-member union, so `modified`/`missing` both drew M,
   * `copied`/`conflicted` both C and `renamed`/`replaced` both R - and the last pair share a colour,
   * which made them identical on screen.
   */
  it('gives every status a mark of its own', () => {
    const statuses: readonly FileChangeStatus[] = [
      'added', 'modified', 'deleted', 'renamed', 'replaced',
      'copied', 'untracked', 'conflicted', 'missing', 'obstructed',
    ]
    const marks = statuses.map((status) => FileChangesStatusMark.of(status))

    expect(new Set(marks).size, marks.join()).toBe(statuses.length)
    expect(() => FileChangesStatusMark.of('exploded' as FileChangeStatus))
      .toThrow(/Unknown file change status/)
  })

  /*
   * `name` is the order the library already returned, not a second copy of its rule: it orders the
   * current list and every group's entries by shown path, and re-deciding it here meant two
   * comparators that could disagree about a tie-break.
   */
  it('keeps the library order for Name and sorts stably for Recent', () => {
    const at = (displayPath: string, modifiedAt: number | null): FileChangeEntry =>
      ({ ...entryOf(displayPath), modifiedAt })
    // As the library hands them over: by shown path.
    const entries = [at('a.ts', 10), at('b.ts', 30), at('c.ts', null), at('d.ts', 30)]

    expect(FileChangesSort.apply(entries, 'name')).toBe(entries)
    // Equal stamps keep the order they arrived in, so no tie-break of its own is needed.
    expect(FileChangesSort.apply(entries, 'recent').map((entry) => entry.displayPath))
      .toEqual(['b.ts', 'd.ts', 'a.ts', 'c.ts'])
  })

  it('reads a working-tree mtime as how long ago it changed', () => {
    const now = 1_700_000_000_000
    expect(FileChangesTime.agoOf(now, now)).toBe('0s ago')
    expect(FileChangesTime.agoOf(now - 1_000, now)).toBe('1s ago')
    expect(FileChangesTime.agoOf(now - 90_000, now)).toBe('1min ago')
    expect(FileChangesTime.agoOf(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(FileChangesTime.agoOf(now - 5 * 86_400_000, now)).toBe('5d ago')
    // The viewer's own zone, the same one the group heading beside it draws in. Asserted against
    // `toLocaleDateString` rather than a fixed string because the format is the machine's; what
    // matters is that it is the local DAY, which east of Greenwich differs from the UTC one for
    // anything near midnight.
    const old = now - 400 * 86_400_000
    expect(FileChangesTime.agoOf(old, now)).toBe(new Date(old).toLocaleDateString())
    expect(new Date(old).getDate()).to.equal(Number.parseInt(
      new Date(old).toLocaleDateString(undefined, { day: 'numeric' }),
      10,
    ))
  })

  it('orders changes by recency or by name, and sinks entries without a time', () => {
    const entry = (displayPath: string, modifiedAt: number | null): FileChangeEntry => ({
      fileId: displayPath,
      path: `C:/work/${displayPath}`,
      displayPath,
      nodeKind: 'file',
      location: 'workspace',
      status: 'modified',
      previousPath: null,
      previousDisplayPath: null,
      modifiedAt,
      sources: ['vcs'],
      gitState: null,
    })
    const entries = [entry('a.ts', 10), entry('b.ts', 30), entry('c.ts', null), entry('d.ts', 20)]
    expect(FileChangesSort.apply(entries, 'recent').map((item) => item.displayPath))
      .toEqual(['b.ts', 'd.ts', 'a.ts', 'c.ts'])
    expect(FileChangesSort.apply(entries, 'name').map((item) => item.displayPath))
      .toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
  })

  /*
   * Two clicks are one keystroke apart in a list of changes, and the answers come back in whatever
   * order the disk decides. The panel showed whichever answer arrived SECOND rather than whichever
   * file was clicked second - click a large file and then a small one, the small one opened and the
   * panel then jumped to the large one - and the first answer also cleared the "opening" mark from
   * the second row and could draw its refusal over a file that opened fine.
   */
  it('opens whichever file was clicked last, not whichever answer came back last', async () => {
    const answers = new Map<string, (value: unknown) => void>()
    const openFile = vi.fn((_snapshotId: string, fileId: string) =>
      new Promise((resolve) => answers.set(fileId, resolve)))
    ;(window as unknown as { appClient: unknown }).appClient = {
      fileChanges: { openFile },
    }
    const onOpen = vi.fn()
    const view = render(
      <FileChangesWidget model={modelOf(snapshotOf())} onOpen={onOpen} />,
    )
    const rows = (): HTMLElement[] => [...view.container.querySelectorAll('button')]
      .filter((node): node is HTMLButtonElement => node.textContent?.includes('.ts') === true)

    // The slow one first, then the quick one.
    fireEvent.click(rows()[0]!)
    fireEvent.click(rows()[1]!)
    answers.get('b.ts')?.({ ok: true, value: { ok: true, value: { documentId: 'document-b' } } })
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))

    // The first click's answer arrives second, and is dropped.
    answers.get('a.ts')?.({ ok: true, value: { ok: true, value: { documentId: 'document-a' } } })
    await Promise.resolve()

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0]?.[0]).toMatchObject({ fileId: 'b.ts' })
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('does not draw the refusal of an open that was already replaced', async () => {
    const answers = new Map<string, (value: unknown) => void>()
    ;(window as unknown as { appClient: unknown }).appClient = {
      fileChanges: {
        openFile: (_snapshotId: string, fileId: string) =>
          new Promise((resolve) => answers.set(fileId, resolve)),
      },
    }
    const view = render(<FileChangesWidget model={modelOf(snapshotOf())} onOpen={vi.fn()} />)
    const rows = (): HTMLElement[] => [...view.container.querySelectorAll('button')]
      .filter((node): node is HTMLButtonElement => node.textContent?.includes('.ts') === true)

    fireEvent.click(rows()[0]!)
    fireEvent.click(rows()[1]!)
    answers.get('b.ts')?.({ ok: true, value: { ok: true, value: { documentId: 'document-b' } } })
    await waitFor(() => expect(view.container.textContent).not.toContain('not-found'))
    answers.get('a.ts')?.({ ok: true, value: { ok: false, code: 'not-found', detail: 'it moved' } })
    await Promise.resolve()

    expect(view.container.textContent).not.toContain('not-found')
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('lists changes newest first, says how long ago, and switches to name order', () => {
    const at = (displayPath: string, modifiedAt: number | null): FileChangeEntry => ({
      fileId: displayPath,
      path: `C:/work/${displayPath}`,
      displayPath,
      nodeKind: 'file',
      location: 'workspace',
      status: 'modified',
      previousPath: null,
      previousDisplayPath: null,
      modifiedAt,
      sources: ['vcs'],
      gitState: null,
    })
    const now = Date.now()
    const snapshot: FileChangesSnapshot = {
      snapshotId: 'snapshot-1',
      sessionId: 'session-1',
      createdAt: now,
      vcs: {
        requested: 'git', selected: 'git', available: ['git'], root: 'C:/work', fallbackReason: null,
      },
      defaultBaseline: null,
      entries: [at('a.ts', now - 3_600_000), at('b.ts', now - 5_000), at('c.ts', null)],
      history: { groups: [], nextCursor: null },
      warnings: [],
    }
    const view = render(
      <FileChangesWidget
        model={{
          snapshot,
          groups: [],
          nextCursor: null,
          preferredVcs: null,
          loading: false,
          loadingMore: false,
          error: null,
          reload: () => Promise.resolve(),
          loadMore: () => Promise.resolve(),
        }}
        onOpen={vi.fn()}
      />,
    )
    const paths = (): string[] => [...view.container.querySelectorAll('.file-tools-file-path')]
      .map((node) => node.textContent ?? '')
    expect(paths()).toEqual(['b.ts', 'a.ts', 'c.ts'])
    expect(view.container.querySelector('.file-tools-when')?.textContent).toBe('5s ago')
    fireEvent.change(view.getByLabelText('Sort changed files'), { target: { value: 'name' } })
    expect(paths()).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })
})
