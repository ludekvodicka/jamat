import { useEffect, useState } from 'react'

import type {
  FileViewerDocument,
  FileViewerDocumentKind,
  FileViewerExportFormat,
  FileViewerTextResult,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { ContextMenu, type ContextMenuEntry, type ContextMenuPosition } from '../widgets/contextMenu'
import { FileViewerIcon } from './fileViewerIcons'
import './fileViewerPane.css'

export type FileViewerCopyFormat = 'text' | 'rich'
export type GetDocumentAction = { kind: 'copy'; format: FileViewerCopyFormat } | { kind: 'export'; format: FileViewerExportFormat } | { kind: 'path' }

/**
 * Get document: the file's path for every document; for a text document also the clipboard
 * (formatted for a mail, or the text itself) and a PDF or HTML file written beside the document,
 * whose path then lands on the clipboard.
 */
export function FileViewerGetDocumentControl(props: { document: FileViewerDocument; text: FileViewerTextResult | null }): React.JSX.Element {
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null)
  useEffect(() => {
    if (outcome === null) return
    const timer = setTimeout(() => setOutcome(null), outcome.failed ? 8000 : 4000)
    return () => clearTimeout(timer)
  }, [outcome])
  const { kind } = props.document
  const text = props.text?.ok && props.text.kind === 'text' ? props.text.text : null
  const run = async (action: GetDocumentAction): Promise<void> => {
    if (action.kind !== 'path' && text === null) return
    setBusy(true)
    setOutcome(null)
    try {
      setOutcome(await FileViewerGetDocument.perform(action, props.document, text ?? ''))
    } catch (error) {
      setOutcome({ text: `Failed: ${String(error)}`, failed: true })
    } finally {
      setBusy(false)
    }
  }
  return <span className="file-viewer-get-document">
    <button type="button" className="file-viewer-get-document__button" disabled={busy} aria-haspopup="menu" aria-expanded={menu !== null}
      title="Copy the document or its path, or save it as PDF or HTML beside the file"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        setMenu({ x: box.left, y: box.bottom })
      }}><FileViewerIcon kind="document" />{busy ? 'Working…' : 'Get document ▾'}</button>
    {outcome && <span role="status" className={outcome.failed ? 'file-viewer-get-document__failed' : 'file-viewer-get-document__done'}
      title={outcome.text}>{outcome.text}</span>}
    {menu && <ContextMenu ariaLabel="Get document" position={menu} onClose={() => setMenu(null)}
      items={FileViewerGetDocument.items(FileViewerGetDocument.textual(kind), text !== null, run)} />}
  </span>
}

export class FileViewerGetDocument {
  /** Copy path always; the text actions for a text document, disabled until its text is loaded. */
  static items(textual: boolean, loaded: boolean, run: (action: GetDocumentAction) => Promise<void>): ContextMenuEntry[] {
    const path: ContextMenuEntry = { key: 'path', label: 'Copy path', onSelect: () => void run({ kind: 'path' }) }
    if (!textual) return [path]
    const waiting = loaded ? {} : { disabled: true, title: 'The text is not loaded' }
    return [
      { key: 'rich', label: 'Copy rich (with formatting)', ...waiting, onSelect: () => void run({ kind: 'copy', format: 'rich' }) },
      { key: 'text', label: 'Copy as text', ...waiting, onSelect: () => void run({ kind: 'copy', format: 'text' }) },
      path,
      { kind: 'separator', key: 'files' },
      { key: 'pdf', label: 'Generate PDF beside the file', ...waiting, onSelect: () => void run({ kind: 'export', format: 'pdf' }) },
      { key: 'html', label: 'Generate HTML beside the file', ...waiting, onSelect: () => void run({ kind: 'export', format: 'html' }) },
    ]
  }

  static perform(action: GetDocumentAction, document: FileViewerDocument, text: string): Promise<{ text: string; failed: boolean }> {
    if (action.kind === 'path') return FileViewerGetDocument.copyPath(document.documentId)
    else if (action.kind === 'copy') return FileViewerGetDocument.copy(document.kind, text, action.format)
    else if (action.kind === 'export') return FileViewerGetDocument.export(document.documentId, document.name, document.kind, text, action.format)
    else throw new Error(`Unknown document action: ${JSON.stringify(action)}`)
  }

  static async copyPath(documentId: string): Promise<{ text: string; failed: boolean }> {
    const answer = await window.appClient.fileViewer.copyPath(documentId)
    if (!answer.ok) return FileViewerGetDocument.failure(`Copying the path failed: ${answer.error}`)
    if (!answer.value) return FileViewerGetDocument.failure('Copying the path failed: the document is gone or another program held the clipboard')
    return { text: 'Path copied', failed: false }
  }

  static textual(kind: FileViewerDocumentKind): boolean {
    if (kind.kind === 'markdown' || kind.kind === 'text' || kind.kind === 'code') return true
    else if (kind.kind === 'html' || kind.kind === 'image' || kind.kind === 'svg' || kind.kind === 'video'
      || kind.kind === 'hex' || kind.kind === 'missing') return false
    else throw new Error(`Unknown file kind: ${JSON.stringify(kind)}`)
  }

  /** Formatted Markdown, or the text in one preformatted block. */
  static async html(kind: FileViewerDocumentKind, text: string): Promise<string> {
    // Loaded on first use: it brings React's server renderer, which nothing else draws with.
    const { MdExtClipboardHtml } = await import('../../../mdext-renderer/renderer/mdExtClipboardHtml')
    return kind.kind === 'markdown' ? MdExtClipboardHtml.of(text) : MdExtClipboardHtml.preformatted(text)
  }

  static async copy(kind: FileViewerDocumentKind, text: string, format: FileViewerCopyFormat): Promise<{ text: string; failed: boolean }> {
    let answer
    if (format === 'text') answer = await window.appClient.clipboard.writeText(text)
    else if (format === 'rich') answer = await window.appClient.clipboard.writeRich(text, await FileViewerGetDocument.html(kind, text))
    else throw new Error(`Unknown copy format: ${JSON.stringify(format)}`)
    if (!answer.ok) return FileViewerGetDocument.failure(`Copy failed: ${answer.error}`)
    if (answer.value === false) return FileViewerGetDocument.failure('Copy failed: another program held the clipboard')
    return { text: 'Copied', failed: false }
  }

  static async export(documentId: string, name: string, kind: FileViewerDocumentKind, text: string,
    format: FileViewerExportFormat): Promise<{ text: string; failed: boolean }> {
    const { MdExtClipboardHtml } = await import('../../../mdext-renderer/renderer/mdExtClipboardHtml')
    const page = MdExtClipboardHtml.page(await FileViewerGetDocument.html(kind, text), name)
    const answer = await window.appClient.fileViewer.exportDocument(documentId, format, page)
    if (!answer.ok) return FileViewerGetDocument.failure(`Generating failed: ${answer.error}`)
    if (!answer.value.ok) return FileViewerGetDocument.failure(`Generating failed: ${answer.value.detail}`)
    return { text: answer.value.pathCopied ? `Saved, path copied: ${answer.value.path}` : `Saved ${answer.value.path}; copying its path failed`,
      failed: !answer.value.pathCopied }
  }

  private static failure(text: string): { text: string; failed: boolean } {
    AppClientUiReport.error(text)
    return { text, failed: true }
  }
}
