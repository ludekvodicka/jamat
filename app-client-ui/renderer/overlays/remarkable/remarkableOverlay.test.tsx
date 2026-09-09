import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge, IpcResult } from '../../../shared/appClientUiIpc'
import type {
  RemarkableOpenDocumentPages,
  RemarkablePagePreview,
  RemarkableRenderedPage,
  RemarkableResult,
} from '../../../shared/remarkableApi.types'
import { RemarkableOverlay } from './remarkableOverlay'

describe('app-client-ui/renderer/overlays/remarkable/remarkableOverlay', () => {
  const outputPathConst = 'Q:\\imports\\Architecture notes-page-2.png'
  const pagesConst: RemarkableOpenDocumentPages = {
    operationId: 'operation-1',
    documentName: 'Architecture notes',
    currentPageNumber: 2,
    pages: [
      { pageId: 'page-a', number: 1, template: null, modified: false },
      { pageId: 'page-b', number: 2, template: 'Grid', modified: true },
      { pageId: 'page-c', number: 3, template: null, modified: false },
    ],
  }
  const previewConst: RemarkablePagePreview = {
    pngBase64: 'iVBORw0KGgo=',
    width: 360,
    height: 480,
    pageNumber: 2,
  }
  const renderedConst: RemarkableRenderedPage = {
    outputPath: outputPathConst,
    insertText: outputPathConst,
    pageNumber: 2,
    documentName: 'Architecture notes',
  }

  function domain<T>(result: RemarkableResult<T>): IpcResult<RemarkableResult<T>> {
    return { ok: true, value: result }
  }

  function deferred<T>(): {
    promise: Promise<T>
    resolve(value: T): void
  } {
    let settle: ((value: T) => void) | null = null
    const promise = new Promise<T>((resolve) => { settle = resolve })
    return {
      promise,
      resolve: (value) => {
        if (settle === null) throw new Error('Deferred promise has no resolver')
        settle(value)
      },
    }
  }

  function bridge() {
    const startOperation = vi.fn<AppClientUiBridge['remarkable']['startOperation']>(async () =>
      domain({ ok: true, value: { operationId: 'operation-1', storageNote: null, autoPreviewOnOpen: false } }))
    const pages = vi.fn<AppClientUiBridge['remarkable']['pages']>(async () =>
      domain({ ok: true, value: pagesConst }))
    const renderPage = vi.fn<AppClientUiBridge['remarkable']['render']>(async () =>
      domain({ ok: true, value: renderedConst }))
    const preview = vi.fn<AppClientUiBridge['remarkable']['preview']>(async () =>
      domain({ ok: true, value: previewConst }))
    const release = vi.fn<AppClientUiBridge['remarkable']['release']>(async () => ({
      ok: true,
      value: undefined,
    }))
    const saveImport = vi.fn<AppClientUiBridge['remarkable']['saveImport']>(async () =>
      domain({ ok: true, value: undefined }))
    const writeText = vi.fn<AppClientUiBridge['clipboard']['writeText']>(async () => ({
      ok: true,
      value: undefined,
    }))
    const calls = { startOperation, pages, render: renderPage, preview, release, saveImport }
    ;(window as unknown as { appClient: unknown }).appClient = {
      remarkable: calls,
      clipboard: { writeText },
    } as unknown as Pick<AppClientUiBridge, 'remarkable' | 'clipboard'>
    return { ...calls, writeText }
  }

  function mount(calls = bridge(), insert?: (path: string) => boolean) {
    const onInsert = vi.fn<(path: string) => boolean>(insert ?? (() => true))
    const onClose = vi.fn<() => void>()
    const view = render(
      <RemarkableOverlay sessionId="s-1" onInsert={onInsert} onClose={onClose} />,
    )
    return { calls, onInsert, onClose, view }
  }

  function insertButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: 'Insert page' }) as HTMLButtonElement
  }

  async function waitUntilReady(): Promise<void> {
    await waitFor(() => expect(insertButton().disabled).toBe(false))
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  /**
   * Listing a document downloads it, so a listed page renders locally and can be previewed the
   * moment it is picked. The tablet's own page cannot: that one waits to be asked.
   */
  it('previews a picked page by itself and the tablet page only when asked', async () => {
    const calls = bridge()
    mount(calls)
    await waitUntilReady()

    expect(calls.preview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Preview current page' }))

    await waitFor(() => expect(calls.preview).toHaveBeenCalledWith('operation-1', { kind: 'current' }))
    const drawn = await screen.findByAltText('Preview of page 2')
    expect(drawn.getAttribute('src')).toBe(`data:image/png;base64,${previewConst.pngBase64}`)

    fireEvent.click(screen.getByRole('radio', { name: /^Another page/ }))
    await waitFor(() => expect(calls.preview).toHaveBeenCalledWith('operation-1', {
      kind: 'listed-page',
      pageId: 'page-b',
    }))

    fireEvent.click(screen.getByRole('radio', { name: 'Page 3' }))
    await waitFor(() => expect(calls.preview).toHaveBeenCalledWith('operation-1', {
      kind: 'listed-page',
      pageId: 'page-c',
    }))
    expect(await screen.findByAltText('Preview of page 2')).toBeTruthy()
    expect(calls.render).not.toHaveBeenCalled()
  })

  it('says so when a preview cannot be drawn and still allows the insert', async () => {
    const calls = bridge()
    calls.preview.mockResolvedValue(domain({
      ok: false,
      code: 'device-sleeping',
      detail: 'the tablet did not wake',
      retryable: true,
    }))
    const test = mount(calls)
    await waitUntilReady()

    fireEvent.click(screen.getByRole('button', { name: 'Preview current page' }))

    await screen.findByText('Wake the tablet, keep it awake and lift the pen, then retry.')
    expect(screen.getByText('the tablet did not wake')).toBeTruthy()
    expect(insertButton().disabled).toBe(false)

    // A preview costs the operation nothing, so a failed one is always worth offering again.
    calls.preview.mockResolvedValue(domain({ ok: true, value: previewConst }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByAltText('Preview of page 2')).toBeTruthy()
    expect(calls.preview).toHaveBeenCalledTimes(2)

    fireEvent.click(insertButton())
    await waitFor(() => expect(test.onInsert).toHaveBeenCalledWith(outputPathConst))
  })

  it('renders and inserts the current page without listing', async () => {
    const test = mount()
    await waitUntilReady()

    fireEvent.click(insertButton())

    await waitFor(() => expect(test.onInsert).toHaveBeenCalledWith(outputPathConst))
    expect(test.calls.pages).not.toHaveBeenCalled()
    expect(test.calls.render).toHaveBeenCalledWith('operation-1', { kind: 'current' })
    expect(test.onClose).toHaveBeenCalledOnce()
    expect(test.calls.release).toHaveBeenCalledOnce()
  })

  /**
   * A Paper Pro answers with an open document and no page it can name. The overlay must not treat
   * that as a broken tool: it offers the pages it can still render and says why the current page is
   * not one of them.
   */
  it('offers the page list when the tablet names no open page', async () => {
    const calls = bridge()
    calls.render.mockResolvedValueOnce(domain({
      ok: false,
      code: 'no-open-page',
      detail: 'The reMarkable tablet does not say which page of "Notebook" is open',
      retryable: false,
    }))
    calls.pages.mockResolvedValue(domain({
      ok: true,
      value: { ...pagesConst, currentPageNumber: null },
    }))
    const test = mount(calls)
    await waitUntilReady()

    fireEvent.click(insertButton())

    const currentRadio = await screen.findByRole('radio', { name: /^Current page/ })
    await waitFor(() => expect((currentRadio as HTMLInputElement).disabled).toBe(true))
    expect(currentRadio.closest('label')?.textContent)
      .toContain('The tablet does not say which page is open')
    // Pressing Insert page must not look like nothing happened, and an asleep tablet is the
    // likeliest reason it answers this way at all.
    expect(screen.getByRole('status').textContent)
      .toBe('The tablet is not showing a page. Wake it, or choose one from the list.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('radio', { name: /, current$/ })).toBeNull()
    expect(insertButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: 'Page 3' }))
    fireEvent.click(insertButton())

    await waitFor(() => expect(test.onInsert).toHaveBeenCalledWith(outputPathConst))
    expect(calls.pages).toHaveBeenCalledOnce()
    expect(calls.render).toHaveBeenLastCalledWith('operation-1', {
      kind: 'listed-page',
      pageId: 'page-c',
    })
  })

  it('lists once, labels the current page and renders the selected page ID', async () => {
    const test = mount()
    await waitUntilReady()

    fireEvent.click(screen.getByRole('radio', { name: /^Another page/ }))
    await screen.findByRole('heading', { name: 'Architecture notes' })
    const current = screen.getByRole('radio', { name: 'Page 2, current' }) as HTMLInputElement
    expect(current.checked).toBe(true)
    expect(screen.getByText('Page 1')).toBeTruthy()
    expect(screen.getByText('Page 3')).toBeTruthy()
    expect(screen.getByText('Grid')).toBeTruthy()
    expect(screen.getByText('Modified')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Page 3' }))
    fireEvent.click(screen.getByRole('radio', { name: /^Current page/ }))
    fireEvent.click(screen.getByRole('radio', { name: /^Another page/ }))
    expect(test.calls.pages).toHaveBeenCalledOnce()

    fireEvent.click(insertButton())
    await waitFor(() => expect(test.calls.render).toHaveBeenCalledWith(
      'operation-1',
      { kind: 'listed-page', pageId: 'page-c' },
    ))
  })

  /**
   * The lock is held by something else and will be free at some point; the card cannot know which
   * click that is. Stopping after one made the third one say the request was no longer valid and
   * ask the user to close the card and open it again, which starts the same operation over.
   */
  it('keeps offering a retry while the device stays busy', async () => {
    const calls = bridge()
    const busy = domain<RemarkableRenderedPage>({
      ok: false,
      code: 'device-busy',
      detail: 'held by another process',
      retryable: true,
    })
    calls.render.mockResolvedValue(busy)
    mount(calls)
    await waitUntilReady()

    fireEvent.click(insertButton())
    expect((await screen.findByRole('alert')).textContent).toContain('device lock')

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(calls.render).toHaveBeenCalledTimes(attempt))
    }
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('previews without being asked when the setting says so, and saves the box when it is ticked', async () => {
    const calls = bridge()
    calls.startOperation.mockResolvedValueOnce(domain({
      ok: true,
      value: { operationId: 'operation-1', storageNote: null, autoPreviewOnOpen: true },
    }))
    mount(calls)

    await waitFor(() => expect(calls.preview).toHaveBeenCalledTimes(1))
    const box = screen.getByRole('checkbox', {
      name: 'Preview the current page as soon as this opens',
    }) as HTMLInputElement
    expect(box.checked).toBe(true)

    fireEvent.click(box)

    await waitFor(() => expect(calls.saveImport)
      .toHaveBeenCalledWith({ autoPreviewOnOpen: false }))
    expect(calls.preview).toHaveBeenCalledTimes(1)
  })

  /** The default: opening the card contacts no device until the user asks it to. */
  it('contacts nothing on open while the setting is off', async () => {
    const test = mount()
    await waitUntilReady()

    expect(test.calls.preview).not.toHaveBeenCalled()
    expect((screen.getByRole('checkbox', {
      name: 'Preview the current page as soon as this opens',
    }) as HTMLInputElement).checked).toBe(false)
  })
  it('gives each actionable failure its own instruction', async () => {
    const cases = [
      ['nothing-open', 'Open a document on the tablet'],
      ['host-key-changed', 'fingerprint changed'],
      ['web-interface-unavailable', 'Enable Web Interface'],
      ['invalid-cli-output', 'returned an invalid page'],
      ['sidecar-not-installed', 'Install the reMarkable dependencies'],
      ['settings-incomplete', 'Finish the reMarkable host and fingerprint setup'],
      ['password-missing', 'Set the reMarkable password'],
      ['sidecar-damaged', 'Repair the reMarkable dependencies'],
    ] as const

    for (const [code, instruction] of cases) {
      const calls = bridge()
      calls.startOperation.mockResolvedValueOnce(domain({
        ok: false,
        code,
        detail: `detail-${code}`,
        retryable: false,
      }))
      mount(calls)

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain(instruction)
      expect(alert.textContent).toContain(`detail-${code}`)
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      cleanup()
    }
  })

  it('releases a start token that arrives after Cancel and never inserts', async () => {
    const calls = bridge()
    const pending = deferred<Awaited<ReturnType<typeof calls.startOperation>>>()
    calls.startOperation.mockReturnValueOnce(pending.promise)
    const test = mount(calls)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(test.onClose).toHaveBeenCalledOnce()
    expect(calls.release).not.toHaveBeenCalled()

    await act(async () => pending.resolve(domain({
      ok: true,
      value: { operationId: 'operation-late', storageNote: null, autoPreviewOnOpen: false },
    })))

    await waitFor(() => expect(calls.release).toHaveBeenCalledWith('operation-late'))
    expect(calls.release).toHaveBeenCalledOnce()
    expect(test.onInsert).not.toHaveBeenCalled()
  })

  it('routes Escape, backdrop and Cancel through one close and release', async () => {
    const test = mount()
    await waitUntilReady()
    const dialog = screen.getByRole('dialog', { name: 'reMarkable' })
    const backdrop = test.view.container.querySelector('.jamat-remarkable')
    if (!(backdrop instanceof HTMLElement)) throw new Error('The overlay drew no backdrop')

    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.mouseDown(backdrop)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(test.onClose).toHaveBeenCalledOnce()
    expect(test.calls.release).toHaveBeenCalledOnce()
  })

  it('ignores a render that finishes after the overlay was cancelled', async () => {
    const calls = bridge()
    const pending = deferred<Awaited<ReturnType<typeof calls.render>>>()
    calls.render.mockReturnValueOnce(pending.promise)
    const test = mount(calls)
    await waitUntilReady()
    fireEvent.click(insertButton())
    await waitFor(() => expect(calls.render).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => pending.resolve(domain({ ok: true, value: renderedConst })))

    expect(test.onInsert).not.toHaveBeenCalled()
    expect(calls.release).toHaveBeenCalledOnce()
  })

  it('keeps the exact path and copies it when insertion returns false or throws', async () => {
    for (const outcome of ['false', 'throw'] as const) {
      const test = mount(
        bridge(),
        outcome === 'false'
          ? () => false
          : () => { throw new Error('target disappeared') },
      )
      await waitUntilReady()
      fireEvent.click(insertButton())

      const path = await screen.findByRole('textbox', { name: 'Rendered page path' })
      expect((path as HTMLInputElement).value).toBe(outputPathConst)
      expect(test.onClose).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
      await waitFor(() => expect(test.calls.writeText).toHaveBeenCalledWith(outputPathConst))
      cleanup()
    }
  })

  it('is modal, traps Tab and restores the previous focus', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const test = mount()
    await waitUntilReady()
    const dialog = screen.getByRole('dialog', { name: 'reMarkable' })

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dialog)
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )]
    focusable[focusable.length - 1].focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(focusable[0])

    test.view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
