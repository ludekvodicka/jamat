import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionFilePorts } from '../../shared/sessionWorkspace'
import type {
  FileViewerDocument,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { FileViewerTextResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { FileViewerContent, FileViewerText } from './fileViewerContent'

describe('app-client-ui/renderer/fileViewer/fileViewerContent', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function documentOf(kind: FileViewerDocument['kind'], path = 'C:/work/a.ts'): FileViewerDocument {
    return {
      documentId: 'document-1',
      documentKey: 'key-1',
      source: { kind: 'workspace', sessionId: 'session-1', path },
      path,
      name: path.split('/').pop() ?? 'a.ts',
      size: 100,
      contentVersion: '100:1',
      kind,
      modes: ['rendered', 'raw'],
    }
  }

  function textOf(text: string): FileViewerTextResult {
    return { ok: true, kind: 'text', text, contentVersion: '100:1' }
  }

  function checklist(ports: SessionFilePorts['viewer'], overrides: Partial<React.ComponentProps<typeof FileViewerContent>> = {}) {
    return <FileViewerContent ports={ports}
      document={documentOf({ kind: 'markdown', flavor: 'markdown' }, 'C:/work/guide.md')}
      mode="rendered" text={textOf('---\njamat: interactive\n---\n- [ ] Test')}
      diff={null} baselines={{ error: null, loading: false, chosen: false }} onOpenSource={vi.fn()} {...overrides} />
  }

  it('waits for a pending toggle before inserting results with the newly confirmed count', async () => {
    let finish!: (value: unknown) => void
    const ports = { toggleTask: vi.fn(() => new Promise((resolve) => { finish = resolve })) } as unknown as SessionFilePorts['viewer']
    const insertPrompt = vi.fn(() => ({ ok: true as const }))
    const view = render(checklist(ports, { insertPrompt,
      text: textOf('---\njamat: interactive\n---\n# Checks\n- [x] First\n- [ ] Second\n- [ ] Third') }))
    expect(view.getByRole('button', { name: 'Send to agent 1/3' })).toBeInTheDocument()
    fireEvent.click(view.getAllByRole('checkbox')[1]!)
    fireEvent.click(view.getByRole('button', { name: /^Send to agent \d+\/\d+$/ }))
    expect(insertPrompt).not.toHaveBeenCalled()
    await act(async () => finish({ ok: true, value: { ok: true, value: { contentVersion: '100:2', line: 6, checked: true } } }))
    expect(view.getByRole('button', { name: 'Send to agent 2/3' })).toBeInTheDocument()
    expect(insertPrompt).toHaveBeenCalledExactlyOnceWith('Výsledky testu C:/work/guide.md: potvrzeno 2/3.\n'
      + 'Nepotvrzeno (neprošlo, nebo nezkoušeno):\n\n## Checks\n- L7: Third', 'submit')
  })

  it('puts the checklist button into the toolbar slot it is given, and nowhere until that slot exists', () => {
    const ports = { toggleTask: vi.fn() } as unknown as SessionFilePorts['viewer']
    const slot = document.createElement('span')
    document.body.append(slot)
    const view = render(checklist(ports, { toolbarSlot: null }))
    expect(view.queryByRole('button', { name: /^Send to agent \d+\/\d+$/ })).toBeNull()
    view.rerender(checklist(ports, { toolbarSlot: slot }))
    expect(slot.querySelector('button')?.textContent).toBe('Send to agent 0/1')
    slot.remove()
  })

  it('inserts results without sending through the Insert into terminal menu item', async () => {
    const ports = { toggleTask: vi.fn() } as unknown as SessionFilePorts['viewer']
    const insertPrompt = vi.fn(() => ({ ok: true as const }))
    const view = render(checklist(ports, { insertPrompt }))
    fireEvent.click(view.getByRole('button', { name: 'More checklist options' }))
    await act(async () => fireEvent.click(view.getByRole('menuitem', { name: 'Insert into terminal (no Enter)' })))
    expect(insertPrompt).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^Výsledky testu C:\/work\/guide\.md: potvrzeno 0\/1\./), 'insert')
    expect(view.queryByRole('menuitem', { name: 'Insert into terminal (no Enter)' })).toBeNull()
  })

  it('omits empty or ordinary checklists and disables sending without a target or current grant text', () => {
    const ports = { toggleTask: vi.fn() } as unknown as SessionFilePorts['viewer']
    const view = render(checklist(ports))
    expect(view.getByRole('button', { name: /^Send to agent \d+\/\d+$/ })).toBeDisabled()
    expect(view.getByRole('button', { name: /^Send to agent \d+\/\d+$/ })).toHaveAttribute('title', 'Session session-1 has no local terminal in this window.')
    const insertPrompt = vi.fn(() => ({ ok: true as const }))
    view.rerender(checklist(ports, { insertPrompt, textReady: false }))
    fireEvent.click(view.getByRole('button', { name: /^Send to agent \d+\/\d+$/ }))
    expect(insertPrompt).not.toHaveBeenCalled()
    view.rerender(checklist(ports, { text: textOf('---\njamat: interactive\n---\n# Empty') }))
    expect(view.queryByRole('group', { name: 'Checklist results' })).toBeNull()
    view.rerender(checklist(ports, { text: textOf('- [ ] Ordinary task') }))
    expect(view.queryByRole('group', { name: 'Checklist results' })).toBeNull()
    view.rerender(checklist(ports, { mode: 'raw' }))
    expect(view.queryByRole('group', { name: 'Checklist results' })).toBeNull()
  })

  it('drops a queued summary when navigation changes the document before the toggle answer', async () => {
    let finish!: (value: unknown) => void
    const ports = { toggleTask: vi.fn(() => new Promise((resolve) => { finish = resolve })) } as unknown as SessionFilePorts['viewer']
    const insertPrompt = vi.fn(() => ({ ok: true as const }))
    const view = render(checklist(ports, { insertPrompt }))
    fireEvent.click(view.getByRole('checkbox'))
    fireEvent.click(view.getByRole('button', { name: /^Send to agent \d+\/\d+$/ }))
    view.rerender(checklist(ports, { insertPrompt, document: { ...documentOf({ kind: 'markdown', flavor: 'markdown' }), documentId: 'next' } }))
    await act(async () => finish({ ok: true, value: { ok: true, value: { contentVersion: '100:2' } } }))
    expect(insertPrompt).not.toHaveBeenCalled()
  })

  it.each(['waiting', 'removed'] as const)('uses the current prompt target when it becomes %s during a toggle', async (change) => {
    let finish!: (value: unknown) => void
    const ports = { toggleTask: vi.fn(() => new Promise((resolve) => { finish = resolve })) } as unknown as SessionFilePorts['viewer']
    const original = vi.fn(() => ({ ok: true as const }))
    const waiting = vi.fn(() => ({ ok: false as const, reason: 'agent-waiting' as const }))
    const text = textOf('---\njamat: interactive\n---\n- [ ] Test')
    const view = render(checklist(ports, { insertPrompt: original, text }))
    fireEvent.click(view.getByRole('checkbox'))
    fireEvent.click(view.getByRole('button', { name: /^Send to agent \d+\/\d+$/ }))
    switch (change) {
      case 'waiting': view.rerender(checklist(ports, { insertPrompt: waiting, text })); break
      case 'removed': view.rerender(checklist(ports, { text })); break
      default: throw new Error(`Unknown target change: ${change satisfies never}`)
    }
    await act(async () => finish({ ok: true, value: { ok: true, value: { contentVersion: '100:2', line: 4, checked: true } } }))
    expect(original).not.toHaveBeenCalled()
    switch (change) {
      case 'waiting':
        expect(waiting).toHaveBeenCalledExactlyOnceWith('Výsledky testu C:/work/guide.md: potvrzeno 1/1.', 'submit')
        expect(view.getByRole('alert')).toHaveTextContent('agent is waiting')
        break
      case 'removed': expect(waiting).not.toHaveBeenCalled(); break
      default: throw new Error(`Unknown target change: ${change satisfies never}`)
    }
  })

  it('drops results after a stale toggle and reports a waiting-agent refusal through the shared gate', async () => {
    const ports = { toggleTask: vi.fn().mockResolvedValue({ ok: true, value: { ok: false, code: 'document-changed', detail: 'stale' } }) } as unknown as SessionFilePorts['viewer']
    const insertPrompt = vi.fn(() => ({ ok: false as const, reason: 'agent-waiting' as const }))
    const onReload = vi.fn()
    const view = render(checklist(ports, { insertPrompt, onReload }))
    fireEvent.click(view.getByRole('checkbox'))
    fireEvent.click(view.getByRole('button', { name: /^Send to agent \d+\/\d+$/ }))
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce())
    expect(insertPrompt).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(view.getByRole('button', { name: /^Send to agent \d+\/\d+$/ })))
    expect(view.getByRole('alert')).toHaveTextContent('session session-1: the agent is waiting for a choice or permission')
  })

  it('offers selection Ask only in Rendered Markdown and maps code selections to the fence start', async () => {
    const insertPrompt = vi.fn(() => ({ ok: true as const }))
    const ports = {} as SessionFilePorts['viewer']
    const text = textOf('# Plan\n\nA selected sentence.\n\n```text\ninside code\n```')
    const view = render(checklist(ports, { text, insertPrompt }))
    const select = (element: Element): void => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      fireEvent.contextMenu(element)
    }
    fireEvent.contextMenu(view.getByText('A selected sentence.'))
    expect(view.queryByRole('menuitem', { name: 'Ask' })).toBeNull()
    select(view.getByText('A selected sentence.'))
    fireEvent.click(view.getByRole('menuitem', { name: 'Ask' }))
    expect(insertPrompt).toHaveBeenLastCalledWith('Mám dotaz k C:/work/guide.md:3, kapitola „Plan“, text „A selected sentence.“: ', 'insert')
    const code = view.container.querySelector('pre')!
    select(code)
    fireEvent.click(view.getByRole('menuitem', { name: 'Ask' }))
    expect(insertPrompt).toHaveBeenLastCalledWith('Mám dotaz k C:/work/guide.md:5, kapitola „Plan“, text „inside code“: ', 'insert')
    view.rerender(checklist(ports, { text, insertPrompt, mode: 'raw' }))
    select(view.container.querySelector('pre')!)
    expect(view.queryByRole('menuitem', { name: 'Ask' })).toBeNull()
  })

  it('keeps the image context menu ahead of selection Ask', async () => {
    const insertPrompt = vi.fn(() => ({ ok: true as const }))
    const ports = { relativeResource: vi.fn(async () => ({ ok: true, value: { ok: true, value: { resourceId: 'image' } } })) } as unknown as SessionFilePorts['viewer']
    const view = render(checklist(ports, { text: textOf('Selected sentence\n\n![Picture](image.png)'), insertPrompt }))
    const range = document.createRange()
    range.selectNodeContents(view.getByText('Selected sentence'))
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const image = await view.findByRole('img')
    fireEvent.contextMenu(image)
    expect(view.getByRole('menuitem', { name: 'Open image full screen' })).toBeInTheDocument()
    expect(view.queryByRole('menuitem', { name: 'Ask' })).toBeNull()
    expect(insertPrompt).not.toHaveBeenCalled()
  })

  it('serializes toggles and adopts confirmed text and version without remounting', async () => {
    const toggleTask = vi.fn<NonNullable<SessionFilePorts['viewer']['toggleTask']>>()
    let finish!: (value: Awaited<ReturnType<NonNullable<SessionFilePorts['viewer']['toggleTask']>>>) => void
    toggleTask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValue({ ok: true, value: { ok: true, value: { contentVersion: '100:3', line: 6, checked: false } } })
    const ports = { toggleTask } as unknown as SessionFilePorts['viewer']
    const onReload = vi.fn()
    const source = textOf('---\njamat: interactive\n---\n<details><summary>Details</summary>\n\n- [ ] Test\n\n</details>')
    const props = { text: source, onReload, onOpenSource: vi.fn() }
    const view = render(checklist(ports, props))
    const details = view.container.querySelector('details')!
    details.open = true
    const checkbox = view.getByRole('checkbox')
    checkbox.focus()
    fireEvent.click(checkbox)
    expect(checkbox).toBeDisabled()
    fireEvent.click(checkbox)
    expect(toggleTask).toHaveBeenCalledExactlyOnceWith({ documentId: 'document-1', line: 6, checked: true, contentVersion: '100:1' })
    await act(async () => finish({ ok: true, value: { ok: true, value: { contentVersion: '100:2', line: 6, checked: true } } }))
    expect(view.getByRole('checkbox')).toBe(checkbox)
    expect(checkbox).toBeChecked()
    expect(details.open).toBe(true)
    expect(onReload).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(checkbox))
    expect(toggleTask).toHaveBeenLastCalledWith({ documentId: 'document-1', line: 6, checked: false, contentVersion: '100:2' })
    expect(checkbox).not.toBeChecked()
    view.rerender(checklist(ports, { ...props, mode: 'raw' }))
    expect(view.container.querySelector('pre')).toHaveTextContent('- [ ] Test')
  })

  it('reloads a stale document and reports other refusals without applying a toggle', async () => {
    const toggleTask = vi.fn().mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'document-changed', detail: 'stale' } })
      .mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'io-error', detail: 'Read-only file' } })
    const onReload = vi.fn()
    const view = render(checklist({ toggleTask } as unknown as SessionFilePorts['viewer'], { onReload }))
    await act(async () => fireEvent.click(view.getByRole('checkbox')))
    expect(onReload).toHaveBeenCalledOnce()
    expect(view.getByRole('checkbox')).not.toBeChecked()
    await act(async () => fireEvent.click(view.getByRole('checkbox')))
    expect(view.getByRole('alert')).toHaveTextContent('Read-only file')
    expect(view.getByRole('checkbox')).not.toBeChecked()
    expect(view.getByRole('checkbox')).not.toBeDisabled()
  })

  it('ignores a late toggle answer after the displayed document changes', async () => {
    let finish!: (value: unknown) => void
    const ports = { toggleTask: vi.fn(() => new Promise((resolve) => { finish = resolve })) } as unknown as SessionFilePorts['viewer']
    const view = render(checklist(ports))
    fireEvent.click(view.getByRole('checkbox'))
    view.rerender(checklist(ports, { document: { ...documentOf({ kind: 'markdown', flavor: 'markdown' }), documentId: 'document-2' } }))
    await act(async () => finish({ ok: true, value: { ok: true, value: { contentVersion: '100:2' } } }))
    expect(view.getByRole('checkbox')).not.toBeChecked()
    expect(view.getByRole('checkbox')).not.toBeDisabled()
  })

  it('keeps retained text read-only until the current grant text arrives', async () => {
    const toggleTask = vi.fn().mockResolvedValue({ ok: true, value: { ok: true, value: { contentVersion: '100:2', line: 4, checked: true } } })
    const ports = { toggleTask } as unknown as SessionFilePorts['viewer']
    const source = textOf('---\njamat: interactive\n---\n- [ ] Test')
    const view = render(checklist(ports, { text: source, textReady: false }))
    expect(view.getByRole('checkbox')).toBeDisabled()
    fireEvent.click(view.getByRole('checkbox'))
    expect(toggleTask).not.toHaveBeenCalled()
    view.rerender(checklist(ports, { text: { ...source }, textReady: true }))
    await act(async () => fireEvent.click(view.getByRole('checkbox')))
    expect(view.getByRole('checkbox')).toBeChecked()
  })

  it('requires a local capability, opt-in and eligible source', async () => {
    const toggleTask = vi.fn()
    const ports = { toggleTask } as unknown as SessionFilePorts['viewer']
    const view = render(checklist({} as SessionFilePorts['viewer']))
    expect(view.getByRole('checkbox')).toBeDisabled()
    view.rerender(checklist(ports, { text: textOf('- [ ] Test') }))
    expect(view.getByRole('checkbox')).toBeDisabled()
    const document = documentOf({ kind: 'markdown', flavor: 'markdown' })
    view.rerender(checklist(ports, { document: { ...document, source: { kind: 'scriptLog', sessionId: 'session-1', runId: 'run-1', path: document.path } } }))
    expect(view.getByRole('checkbox')).toBeDisabled()
    view.rerender(checklist(ports, { mode: 'raw' }))
    expect(view.queryByRole('checkbox')).toBeNull()
    view.rerender(checklist(ports, { text: { ok: true, kind: 'too-large', detail: 'Too large', size: 3000000, limit: 2000000 } }))
    await waitFor(() => expect(view.queryByRole('checkbox')).toBeNull())
    expect(toggleTask).not.toHaveBeenCalled()
  })

  function content(
    document: FileViewerDocument,
    text: string,
    line: number,
    mode: 'rendered' | 'raw' | 'preview',
  ): React.JSX.Element {
    return (
      <FileViewerContent ports={window.appClient?.fileViewer ?? {} as SessionFilePorts['viewer']}
        document={document}
        mode={mode}
        text={textOf(text)}
        diff={null}
        baselines={{ error: null, loading: false, chosen: false }}
        location={{ line }}
        onOpenSource={() => undefined}
      />
    )
  }

  it('renders a granted remote GIF and exports only after an explicit click', async () => {
    const exportFile = vi.fn(async () => ({ ok: true as const, value: true }))
    const ports = { mediaResource: async () => ({ ok: true, value: { ok: true, value: { resourceId: 'controller-token', mimeType: 'image/gif', size: 10, contentVersion: 'v' } } }),
      exportFile, startImageDrag: vi.fn() } as unknown as SessionFilePorts['viewer']
    const view = render(<FileViewerContent ports={ports} document={documentOf({ kind: 'image', mimeType: 'image/gif', animated: true }, 'remote.gif')}
      mode="preview" text={null} diff={null} baselines={{ error: null, loading: false, chosen: false }} onOpenSource={vi.fn()} />)
    await act(async () => {})
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('jamat-v3-file://resource/controller-token')
    expect(exportFile).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Save copy…' }))
    expect(exportFile).toHaveBeenCalledWith('document-1', 'remote.gif')
  })

  it('hides a UTF-8 BOM only from rendered content', () => {
    expect(FileViewerText.withoutBom('\uFEFF# Title')).toBe('# Title')
    expect(FileViewerText.value({
      ok: true,
      kind: 'text',
      text: '\uFEFF# Title',
      contentVersion: '1',
    })).toEqual({ ok: true, value: '\uFEFF# Title' })
  })

  /*
   * The kinds that are not code, markdown or svg were whatever was left, so a kind added later
   * would have been highlighted as plain text rather than saying nobody had decided for it.
   */
  it('names the highlighting language of every document kind it knows', () => {
    const documentForKind = (kind: unknown): FileViewerDocument =>
      ({ kind } as unknown as FileViewerDocument)

    expect(FileViewerText.language(documentForKind({ kind: 'code', language: 'rust' }))).toBe('rust')
    expect(FileViewerText.language(documentForKind({ kind: 'markdown', flavor: 'mdext' })))
      .toBe('markdown')
    expect(FileViewerText.language(documentForKind({ kind: 'svg', mimeType: 'image/svg+xml' })))
      .toBe('xml')
    for (const kind of ['text', 'hex', 'image', 'video', 'missing'])
      expect(FileViewerText.language(documentForKind({ kind })), kind).toBe('text')
    expect(() => FileViewerText.language(documentForKind({ kind: 'pdf' })))
      .toThrow(/Unknown file viewer document kind/)
  })

  it('scrolls a raw file to the requested line and removes its highlight again', () => {
    vi.useFakeTimers()
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const view = render(content(
      documentOf({ kind: 'text' }, 'C:/work/a.txt'),
      'first\nsecond\nthird',
      2,
      'raw',
    ))

    const target = view.container.querySelector<HTMLElement>('[data-file-line="2"]')
    expect(target).not.toBeNull()
    expect(target).toHaveClass('file-viewer-line-target')
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' })

    act(() => vi.advanceTimersByTime(1_800))

    expect(target).not.toHaveClass('file-viewer-line-target')
  })

  it('maps a Markdown source line after frontmatter to its rendered block', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const view = render(content(
      documentOf({ kind: 'markdown', flavor: 'markdown' }, 'C:/work/readme.md'),
      '---\ntitle: Demo\n---\n# Heading\n\nTarget paragraph',
      6,
      'rendered',
    ))

    const target = view.container.querySelector<HTMLElement>('.file-viewer-line-target')
    expect(target?.textContent).toBe('Target paragraph')
    expect(target).toHaveAttribute('data-file-line-start', '6')
    expect(scroll).toHaveBeenCalled()
  })

  it.each(['png', 'svg'] as const)('drags a %s preview by document ID and cancels the browser URL drag', async (format) => {
    const startImageDrag = vi.fn(async () => ({ ok: true, value: true }))
    vi.stubGlobal('appClient', {
      fileViewer: {
        startImageDrag,
        mediaResource: async () => ({
          ok: true,
          value: { ok: true, value: { resourceId: 'image-token' } },
        }),
      },
    })
    const imageDocument = documentOf(
      format === 'png'
        ? { kind: 'image', mimeType: 'image/png', animated: false }
        : { kind: 'svg', mimeType: 'image/svg+xml' },
      `C:/work/picture.${format}`,
    )
    const view = render(content(imageDocument, '<svg xmlns="http://www.w3.org/2000/svg"/>', 1,
      format === 'png' ? 'preview' : 'rendered'))
    const image = await view.findByRole('img')
    expect(image).toHaveAttribute('draggable', 'true')
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    await act(async () => { fireEvent(image, event) })
    expect(event.defaultPrevented).toBe(true)
    expect(startImageDrag).toHaveBeenCalledExactlyOnceWith('document-1')
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('keeps the image available for another drag after a refusal', async () => {
    const startImageDrag = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: false })
      .mockResolvedValueOnce({ ok: true, value: true })
    vi.stubGlobal('appClient', { fileViewer: { startImageDrag } })
    const view = render(content(documentOf({ kind: 'svg', mimeType: 'image/svg+xml' }),
      '<svg xmlns="http://www.w3.org/2000/svg"/>', 1, 'rendered'))
    const image = view.getByRole('img')
    await act(async () => { fireEvent.dragStart(image) })
    expect(view.getByRole('alert')).toHaveTextContent('Reload it and try again')
    expect(view.getByRole('img')).toBe(image)
    await act(async () => { fireEvent.dragStart(image) })
    expect(view.queryByRole('alert')).toBeNull()
  })
})
