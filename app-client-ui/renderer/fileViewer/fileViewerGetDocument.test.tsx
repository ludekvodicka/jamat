import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileViewerDocument, FileViewerDocumentKind } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { FileViewerGetDocument, FileViewerGetDocumentControl } from './fileViewerGetDocument'

const writeText = vi.fn(), writeRich = vi.fn(), exportDocument = vi.fn(), copyPath = vi.fn()
const text = (value: string) => ({ ok: true as const, kind: 'text' as const, text: value, contentVersion: '1' })
const document = (kind: FileViewerDocumentKind): FileViewerDocument => ({ documentId: 'doc-1', documentKey: 'key', name: 'notes.md',
  path: 'C:/work/notes.md', size: 7, contentVersion: '1', kind, modes: ['rendered', 'raw'],
  source: { kind: 'workspace', sessionId: 's', path: 'notes.md' } as unknown as FileViewerDocument['source'] })
const markdown = document({ kind: 'markdown', flavor: 'markdown' })
const choose = (label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Get document ▾' }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

describe('FileViewerGetDocument', () => {
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue({ ok: true, value: undefined })
    writeRich.mockReset().mockResolvedValue({ ok: true, value: true })
    copyPath.mockReset().mockResolvedValue({ ok: true, value: true })
    exportDocument.mockReset().mockResolvedValue({ ok: true, value: { ok: true, path: 'C:/work/notes.pdf', pathCopied: true } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    Object.defineProperty(window, 'appClient', { configurable: true,
      value: { clipboard: { writeText, writeRich }, fileViewer: { exportDocument, copyPath } } })
  })
  afterEach(cleanup)

  it('offers the text actions for Markdown, text and code only', () => {
    expect(FileViewerGetDocument.textual({ kind: 'markdown', flavor: 'mdext' })).toBe(true)
    expect(FileViewerGetDocument.textual({ kind: 'code', language: 'ts' })).toBe(true)
    expect(FileViewerGetDocument.textual({ kind: 'text' })).toBe(true)
    expect(FileViewerGetDocument.textual({ kind: 'image', mimeType: 'image/png', animated: false })).toBe(false)
    expect(FileViewerGetDocument.textual({ kind: 'html' })).toBe(false)
  })

  it('copies Markdown formatted, with its source as the text', async () => {
    render(<FileViewerGetDocumentControl document={markdown} text={text('# Title')} />)
    choose('Copy rich (with formatting)')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'))
    expect(writeRich).toHaveBeenCalledWith('# Title', expect.stringContaining('<h1>Title</h1>'))
  })

  it('copies the text alone', async () => {
    render(<FileViewerGetDocumentControl document={markdown} text={text('# Title')} />)
    choose('Copy as text')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Title'))
    expect(writeRich).not.toHaveBeenCalled()
  })

  it('generates a PDF from a whole page and shows the copied path', async () => {
    render(<FileViewerGetDocumentControl document={markdown} text={text('# Title')} />)
    choose('Generate PDF beside the file')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved, path copied: C:/work/notes.pdf'))
    const [documentId, format, page] = exportDocument.mock.calls[0]
    expect([documentId, format]).toEqual(['doc-1', 'pdf'])
    expect(page).toMatch(/^<!doctype html>/)
    expect(page).toContain('<title>notes.md</title>')
    expect(page).toContain('<h1>Title</h1>')
  })

  it('shows why generating failed', async () => {
    exportDocument.mockResolvedValue({ ok: true, value: { ok: false, detail: 'access denied' } })
    render(<FileViewerGetDocumentControl document={markdown} text={text('# Title')} />)
    choose('Generate HTML beside the file')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Generating failed: access denied'))
    expect(exportDocument.mock.calls[0][1]).toBe('html')
  })

  it('copies the path of any document, and offers only that for an image', async () => {
    render(<FileViewerGetDocumentControl document={document({ kind: 'image', mimeType: 'image/png', animated: false })} text={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Get document ▾' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Copy path'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Path copied'))
    expect(copyPath).toHaveBeenCalledWith('doc-1')
  })

  it('keeps the text actions disabled until the text is loaded', () => {
    render(<FileViewerGetDocumentControl document={document({ kind: 'text' })} text={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Get document ▾' }))
    expect(screen.getByRole('menuitem', { name: 'Copy as text' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeEnabled()
  })
})
