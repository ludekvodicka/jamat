import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

  function content(
    document: FileViewerDocument,
    text: string,
    line: number,
    mode: 'rendered' | 'raw',
  ): React.JSX.Element {
    return (
      <FileViewerContent
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
})
