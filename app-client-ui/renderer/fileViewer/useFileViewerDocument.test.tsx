import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { Suspense, startTransition, useLayoutEffect, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type {
  FileChangesViewModel,
  FileChangesWorkingTreeViewModel,
} from './fileViewerPanel.types'
import { useFileViewerDocument } from './useFileViewerDocument'

class FileViewerDocumentHarness {
  static document(name: string, documentId = `document-${name}`): FileViewerDocument {
    return {
      documentId,
      documentKey: `key-${name}`,
      source: { kind: 'workspace', sessionId: 'session-1', path: `C:/work/${name}` },
      path: `C:/work/${name}`,
      name,
      size: 1,
      contentVersion: '1:1',
      kind: { kind: 'text' },
      modes: ['raw'],
    }
  }

  static changes(): FileChangesViewModel {
    return {
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
  }

  static workingTree(): FileChangesWorkingTreeViewModel {
    return {
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
  }

  static install(document = FileViewerDocumentHarness.document('a.ts')) {
    const fileViewer = {
      restore: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: document },
      })),
      text: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, kind: 'text' as const, text: 'body', contentVersion: '1:1' },
      })),
      release: vi.fn(async () => ({ ok: true as const, value: undefined })),
    }
    const fileChanges = { diff: vi.fn() }
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileViewer,
      fileChanges,
    } as unknown as AppClientUiBridge
    return { fileViewer, fileChanges }
  }
}

describe('app-client-ui/renderer/fileViewer/useFileViewerDocument', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('keeps a proof-expired restore as text state instead of throwing', async () => {
    const { fileViewer } = FileViewerDocumentHarness.install()
    fileViewer.restore.mockResolvedValue({
      ok: true,
      value: { ok: false, code: 'proof-expired', detail: 'Open the path again.' },
    } as never)

    const { result } = renderHook(() => useFileViewerDocument(
      FileViewerDocumentHarness.document('a.ts').source,
      undefined,
      FileViewerDocumentHarness.changes(),
      FileViewerDocumentHarness.workingTree(),
    ))

    await waitFor(() => expect(result.current.error)
      .toBe('proof-expired: Open the path again.'))
    expect(result.current.document).toBeNull()
    expect(fileViewer.text).not.toHaveBeenCalled()
  })

  it('reloads the same file without dropping the view or blanking the document', async () => {
    const first = {
      ...FileViewerDocumentHarness.document('a.ts', 'document-1'),
      modes: ['rendered', 'raw'] as const,
    }
    const second = { ...first, documentId: 'document-2', contentVersion: '2:2' }
    const { fileViewer } = FileViewerDocumentHarness.install(first)
    fileViewer.restore.mockResolvedValueOnce({
      ok: true,
      value: { ok: true, value: first },
    } as never).mockResolvedValueOnce({
      ok: true,
      value: { ok: true, value: second },
    } as never)
    let reads = 0
    fileViewer.text.mockImplementation(async () => {
      reads += 1
      return {
        ok: true as const,
        value: {
          ok: true as const,
          kind: 'text' as const,
          text: reads === 1 ? 'before' : 'after',
          contentVersion: `${reads}:${reads}`,
        },
      }
    })
    const view = renderHook(() => useFileViewerDocument(
      first.source,
      undefined,
      FileViewerDocumentHarness.changes(),
      FileViewerDocumentHarness.workingTree(),
    ))

    await waitFor(() => expect(view.result.current.text).not.toBeNull())
    act(() => { view.result.current.setMode('rendered') })
    expect(view.result.current.mode).toBe('rendered')

    act(() => { view.result.current.reload() })
    await waitFor(() => expect(view.result.current.document?.documentId).toBe('document-2'))
    // What was on screen stays on screen until the fresh text lands, which is what keeps an
    // automatic reload from scrolling a reader back to the top of the file.
    expect(view.result.current.text).not.toBeNull()
    expect(view.result.current.mode).toBe('rendered')
    await waitFor(() => {
      const text = view.result.current.text
      expect(text?.ok === true && text.kind === 'text' ? text.text : null).toBe('after')
    })
    expect(fileViewer.release).toHaveBeenCalledWith('document-1')
  })

  it('releases the active grant when its viewer unmounts', async () => {
    const document = FileViewerDocumentHarness.document('a.ts')
    const { fileViewer } = FileViewerDocumentHarness.install(document)
    const view = renderHook(() => useFileViewerDocument(
      document.source,
      undefined,
      FileViewerDocumentHarness.changes(),
      FileViewerDocumentHarness.workingTree(),
    ))

    await waitFor(() => expect(view.result.current.document?.documentId).toBe(document.documentId))
    expect(fileViewer.release).not.toHaveBeenCalled()
    view.unmount()
    expect(fileViewer.release).toHaveBeenCalledWith(document.documentId)
  })

  it('invalidates the pending restore in the layout phase when its source changes', () => {
    const first = FileViewerDocumentHarness.document('a.ts')
    const second = FileViewerDocumentHarness.document('b.ts')
    const answer = { ok: true as const, value: { ok: true as const, value: first } }
    const { fileViewer } = FileViewerDocumentHarness.install(first)
    let deliver: (() => void) | null = null
    fileViewer.restore
      .mockImplementationOnce(() => ({
        then: (onFulfilled: (value: typeof answer) => unknown) => {
          deliver = () => { onFulfilled(answer) }
          return Promise.resolve()
        },
      }) as never)
      .mockImplementationOnce(() => new Promise(() => {}) as never)
    const onDocument = vi.fn()
    const changes = FileViewerDocumentHarness.changes()
    const workingTree = FileViewerDocumentHarness.workingTree()

    function Probe(props: {
      source: FileViewerDocument['source']
      deliverOnLayout: boolean
    }): React.JSX.Element | null {
      useFileViewerDocument(props.source, undefined, changes, workingTree, onDocument)
      useLayoutEffect(() => {
        if (!props.deliverOnLayout)
          return
        if (deliver === null) throw new Error('the first restore did not start')
        deliver()
      }, [props.deliverOnLayout])
      return null
    }

    const view = render(<Probe source={first.source} deliverOnLayout={false} />)
    expect(deliver).not.toBeNull()
    view.rerender(<Probe source={second.source} deliverOnLayout />)

    expect(onDocument).not.toHaveBeenCalled()
    expect(fileViewer.release).toHaveBeenCalledWith(first.documentId)
  })

  it('marks an unmounted viewer dead before parent layout effects can deliver a restore', () => {
    const document = FileViewerDocumentHarness.document('a.ts')
    const answer = { ok: true as const, value: { ok: true as const, value: document } }
    const { fileViewer } = FileViewerDocumentHarness.install(document)
    let deliver: (() => void) | null = null
    fileViewer.restore.mockImplementationOnce(() => ({
      then: (onFulfilled: (value: typeof answer) => unknown) => {
        deliver = () => { onFulfilled(answer) }
        return Promise.resolve()
      },
    }) as never)
    const onDocument = vi.fn()
    const changes = FileViewerDocumentHarness.changes()
    const workingTree = FileViewerDocumentHarness.workingTree()

    function Viewer(): React.JSX.Element | null {
      useFileViewerDocument(document.source, undefined, changes, workingTree, onDocument)
      return null
    }

    function Parent(props: { show: boolean; deliverOnLayout: boolean }): React.JSX.Element | null {
      useLayoutEffect(() => {
        if (!props.deliverOnLayout)
          return
        if (deliver === null) throw new Error('the restore did not start')
        deliver()
      }, [props.deliverOnLayout])
      return props.show ? <Viewer /> : null
    }

    const view = render(<Parent show deliverOnLayout={false} />)
    expect(deliver).not.toBeNull()
    view.rerender(<Parent show={false} deliverOnLayout />)

    expect(onDocument).not.toHaveBeenCalled()
    expect(fileViewer.release).toHaveBeenCalledWith(document.documentId)
  })

  it('adopts an already opened document and does not restore the source it then writes', async () => {
    const first = FileViewerDocumentHarness.document('a.ts')
    const second = FileViewerDocumentHarness.document('b.ts')
    const onDocument = vi.fn()
    const { fileViewer } = FileViewerDocumentHarness.install(first)
    const changes = FileViewerDocumentHarness.changes()
    const workingTree = FileViewerDocumentHarness.workingTree()
    const view = renderHook(
      (source: FileViewerDocument['source']) => useFileViewerDocument(
        source,
        undefined,
        changes,
        workingTree,
        onDocument,
      ),
      { initialProps: first.source },
    )
    await waitFor(() => expect(view.result.current.document?.documentId).toBe(first.documentId))

    act(() => view.result.current.adopt(second, undefined))
    view.rerender(second.source)

    expect(view.result.current.document?.documentId).toBe(second.documentId)
    expect(fileViewer.restore).toHaveBeenCalledTimes(1)
    expect(onDocument).toHaveBeenLastCalledWith(second, undefined, true)
  })

  it('releases every superseded grant when two adopts share one React batch', async () => {
    const first = FileViewerDocumentHarness.document('a.ts')
    const second = FileViewerDocumentHarness.document('b.ts')
    const third = FileViewerDocumentHarness.document('c.ts')
    const { fileViewer } = FileViewerDocumentHarness.install(first)
    const view = renderHook(() => useFileViewerDocument(
      first.source,
      undefined,
      FileViewerDocumentHarness.changes(),
      FileViewerDocumentHarness.workingTree(),
    ))
    await waitFor(() => expect(view.result.current.document?.documentId).toBe(first.documentId))
    fileViewer.release.mockClear()

    act(() => {
      view.result.current.adopt(second, undefined)
      view.result.current.adopt(third, undefined)
    })

    expect(view.result.current.document?.documentId).toBe(third.documentId)
    expect(fileViewer.release).toHaveBeenCalledWith(first.documentId)
    expect(fileViewer.release).toHaveBeenCalledWith(second.documentId)
    expect(fileViewer.release).not.toHaveBeenCalledWith(third.documentId)
  })

  it('releases a restore accepted in a batch that unmounts before its state commits', async () => {
    const document = FileViewerDocumentHarness.document('deferred.ts')
    const { fileViewer } = FileViewerDocumentHarness.install(document)
    let settle: ((answer: unknown) => void) | null = null
    fileViewer.restore.mockImplementationOnce(() => new Promise((resolve) => {
      settle = resolve
    }) as never)
    const view = renderHook(() => useFileViewerDocument(
      document.source,
      undefined,
      FileViewerDocumentHarness.changes(),
      FileViewerDocumentHarness.workingTree(),
    ))
    if (settle === null) throw new Error('the restore did not start')

    await act(async () => {
      settle?.({ ok: true, value: { ok: true, value: document } })
      await Promise.resolve()
      view.unmount()
    })

    expect(fileViewer.release).toHaveBeenCalledTimes(1)
    expect(fileViewer.release).toHaveBeenCalledWith(document.documentId)
  })

  it('does not publish a callback from a render React discarded', async () => {
    const document = FileViewerDocumentHarness.document('committed.ts')
    const { fileViewer } = FileViewerDocumentHarness.install(document)
    let settle: ((answer: unknown) => void) | null = null
    fileViewer.restore.mockImplementationOnce(() => new Promise((resolve) => {
      settle = resolve
    }) as never)
    const committed = vi.fn()
    const discarded = vi.fn()
    const suspended = new Promise<void>(() => {})
    const changes = FileViewerDocumentHarness.changes()
    const workingTree = FileViewerDocumentHarness.workingTree()
    const view = renderHook(
      (props: { onDocument: typeof committed; suspend: boolean }) => {
        const model = useFileViewerDocument(
          document.source,
          undefined,
          changes,
          workingTree,
          props.onDocument,
        )
        if (props.suspend) throw suspended
        return model
      },
      {
        initialProps: { onDocument: committed, suspend: false },
        wrapper: (props: { children: ReactNode }) => (
          <Suspense fallback={null}>{props.children}</Suspense>
        ),
      },
    )
    act(() => {
      startTransition(() => view.rerender({ onDocument: discarded, suspend: true }))
    })
    if (settle === null) throw new Error('the restore did not start')

    await act(async () => {
      settle?.({ ok: true, value: { ok: true, value: document } })
      await Promise.resolve()
    })

    expect(committed).toHaveBeenCalledWith(document, undefined, false)
    expect(discarded).not.toHaveBeenCalled()
  })

  it('lets the later link open win and releases the slower answer', async () => {
    const first = FileViewerDocumentHarness.document('a.ts')
    const second = FileViewerDocumentHarness.document('b.ts')
    const third = FileViewerDocumentHarness.document('c.ts')
    const { fileViewer } = FileViewerDocumentHarness.install(first)
    const view = renderHook(() => useFileViewerDocument(
      first.source,
      undefined,
      FileViewerDocumentHarness.changes(),
      FileViewerDocumentHarness.workingTree(),
    ))
    await waitFor(() => expect(view.result.current.document?.documentId).toBe(first.documentId))

    let settleSecond: ((answer: unknown) => void) | null = null
    let settleThird: ((answer: unknown) => void) | null = null
    fileViewer.restore
      .mockImplementationOnce(() => new Promise((resolve) => { settleSecond = resolve }) as never)
      .mockImplementationOnce(() => new Promise((resolve) => { settleThird = resolve }) as never)
    act(() => {
      view.result.current.openSource(second.source)
      view.result.current.openSource(third.source)
    })
    await act(async () => {
      settleThird?.({ ok: true, value: { ok: true, value: third } })
      await Promise.resolve()
    })
    expect(view.result.current.document?.documentId).toBe(third.documentId)

    await act(async () => {
      settleSecond?.({ ok: true, value: { ok: true, value: second } })
      await Promise.resolve()
    })
    expect(view.result.current.document?.documentId).toBe(third.documentId)
    expect(fileViewer.release).toHaveBeenCalledWith(second.documentId)
  })
})
