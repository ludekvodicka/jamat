import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  FileDiffData,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import {
  FileDiffHighlighting,
  FileDiffLayoutPreference,
  FileDiffView,
  FileDiffVisual,
  type FileDiffVisualLine,
} from './fileDiffView'

describe('app-client-ui/renderer/fileViewer/fileDiffView', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  function sampleDiff(): FileDiffData {
    return {
      status: 'modified',
      completeness: 'full',
      current: { label: 'Working tree', path: 'a.ts', exists: true, eol: 'lf', finalNewline: true },
      baseline: { label: 'HEAD', path: 'a.ts', exists: true, eol: 'lf', finalNewline: true },
      hunks: [{
        beforeStart: 1,
        beforeLines: 2,
        afterStart: 1,
        afterLines: 2,
        lines: [
          { kind: 'context', text: 'const one = 1', beforeLine: 1, afterLine: 1 },
          { kind: 'remove', text: 'const old = 2', beforeLine: 2, afterLine: null },
          { kind: 'add', text: 'const fresh = 2', beforeLine: null, afterLine: 2 },
        ],
      }],
      detail: null,
    }
  }

  /*
   * The highlighting was indexed by line POSITION and kept across the change: the render in which
   * the rows change drew the NEW rows with the PREVIOUS rows' HTML, row by row. Switching a diff to
   * "Full file" drew the first lines of the file with the changed rows' text under the new numbers.
   */
  /*
   * The frame this guards is one React flushes past: the click that changes the rows renders once
   * with the NEW rows and the OLD html before the effect clears it. Held apart and indexed by
   * position, that frame drew the first lines of the file with the changed rows' text under the new
   * line numbers.
   */
  it('hands back no highlighting at all for rows it was not produced for', () => {
    const rows = (texts: string[]): FileDiffVisualLine[] =>
      texts.map((text) => ({
        key: text,
        kind: 'context',
        text,
        beforeLine: null,
        afterLine: null,
        header: null,
      }))
    const changes = rows(['const old = 2'])
    const full = rows(['const one = 1', 'const third = 3'])
    const held = { for: changes, html: ['<span>const old = 2</span>'] }

    expect(FileDiffHighlighting.forLines(held, changes)).toEqual(held.html)
    expect(FileDiffHighlighting.forLines(held, full)).toBeNull()
    expect(FileDiffHighlighting.forLines(null, changes)).toBeNull()
    // Same texts, different array: the rows were rebuilt, so the HTML is not theirs.
    expect(FileDiffHighlighting.forLines(held, rows(['const old = 2']))).toBeNull()
  })

  it('never draws one set of rows under another set\'s highlighting', async () => {
    const data = sampleDiff()
    const currentText = 'const one = 1\nconst fresh = 2\nconst third = 3\n'
    const view = render(
      <FileDiffView data={data} currentText={currentText} language="typescript" />,
    )
    // Wait for the changes view to be highlighted, which is the state that used to survive.
    await waitFor(() => expect(view.container.querySelector('.shiki, [style]')).not.toBeNull())

    fireEvent.click(view.getByRole('button', { name: 'Full file' }))

    // Immediately, before the new highlight comes back: every row draws its OWN text.
    const rows = [...view.container.querySelectorAll('.file-diff-text')]
      .map((node) => node.textContent ?? '')
    expect(rows.at(-1)).toContain('const third = 3')
    expect(rows.join('|')).not.toContain('const third = 3|')
    await waitFor(() => expect(
      [...view.container.querySelectorAll('.file-diff-text')].at(-1)?.textContent,
    ).toContain('const third = 3'))
  })

  it('turns structured hunks into both changes-only and full-file lines with before-side numbers', () => {
    const data: FileDiffData = {
      status: 'modified',
      completeness: 'full',
      current: { label: 'Working tree', path: 'a.ts', exists: true, eol: 'lf', finalNewline: true },
      baseline: { label: 'HEAD', path: 'a.ts', exists: true, eol: 'lf', finalNewline: true },
      hunks: [{
        beforeStart: 1,
        beforeLines: 2,
        afterStart: 1,
        afterLines: 3,
        lines: [
          { kind: 'context', text: 'one', beforeLine: 1, afterLine: 1 },
          { kind: 'remove', text: 'old', beforeLine: 2, afterLine: null },
          { kind: 'add', text: 'new-a', beforeLine: null, afterLine: 2 },
          { kind: 'add', text: 'new-b', beforeLine: null, afterLine: 3 },
        ],
      }],
      detail: null,
    }
    expect(FileDiffVisual.changes(data).map((line) => line.kind))
      .toEqual(['context', 'remove', 'add', 'add'])
    expect(FileDiffVisual.full(data, 'one\nnew-a\nnew-b\nfour\n')
      .map((line) => [line.kind, line.beforeLine, line.afterLine, line.text]))
      .toEqual([
        ['context', 1, 1, 'one'],
        ['remove', 2, null, 'old'],
        ['add', null, 2, 'new-a'],
        ['add', null, 3, 'new-b'],
        ['context', 3, 4, 'four'],
      ])
    expect(FileDiffVisual.matchesCurrent(data, 'one\nstale\n')).toBe(false)
    expect(() => FileDiffVisual.full({ ...data, completeness: 'region' }, 'one\nnew-a\n'))
      .toThrow(/region diff/)
  })

  it('pairs removals with additions side by side, pads uneven blocks and never crosses hunk boundaries', () => {
    const data: FileDiffData = {
      status: 'modified',
      completeness: 'full',
      current: { label: 'Working tree', path: 'a.ts', exists: true, eol: 'lf', finalNewline: true },
      baseline: { label: 'HEAD', path: 'a.ts', exists: true, eol: 'lf', finalNewline: true },
      hunks: [
        {
          beforeStart: 1,
          beforeLines: 2,
          afterStart: 1,
          afterLines: 3,
          lines: [
            { kind: 'context', text: 'keep', beforeLine: 1, afterLine: 1 },
            { kind: 'remove', text: 'old-1', beforeLine: 2, afterLine: null },
            { kind: 'add', text: 'new-1', beforeLine: null, afterLine: 2 },
            { kind: 'add', text: 'new-2', beforeLine: null, afterLine: 3 },
          ],
        },
        {
          beforeStart: 10,
          beforeLines: 1,
          afterStart: 11,
          afterLines: 0,
          lines: [
            { kind: 'remove', text: 'dropped', beforeLine: 10, afterLine: null },
          ],
        },
        {
          beforeStart: 20,
          beforeLines: 0,
          afterStart: 20,
          afterLines: 1,
          lines: [
            { kind: 'add', text: 'inserted', beforeLine: null, afterLine: 20 },
          ],
        },
      ],
      detail: null,
    }
    const lines = FileDiffVisual.changes(data)
    const rows = FileDiffVisual.split(lines)
    expect(rows.map((row) => ({
      header: row.header,
      left: row.left ? `${row.left.line.kind}:${row.left.line.beforeLine}:${row.left.line.text}` : null,
      right: row.right ? `${row.right.line.kind}:${row.right.line.afterLine}:${row.right.line.text}` : null,
    }))).toEqual([
      { header: '@@ -1,2 +1,3 @@', left: 'context:1:keep', right: 'context:1:keep' },
      { header: null, left: 'remove:2:old-1', right: 'add:2:new-1' },
      { header: null, left: null, right: 'add:3:new-2' },
      { header: '@@ -10,1 +11,0 @@', left: 'remove:10:dropped', right: null },
      { header: '@@ -20,0 +20,1 @@', left: null, right: 'add:20:inserted' },
    ])
    expect(FileDiffVisual.minimapMarks('split', lines, rows))
      .toEqual(['context', 'change', 'add', 'remove', 'add'])
  })

  it('switches between Unified and Side by side, remembers the preference and marks right-side lines', async () => {
    const data = sampleDiff()
    const currentText = 'const one = 1\nconst fresh = 2\nconst third = 3\n'
    const first = render(<FileDiffView data={data} currentText={currentText} language="typescript" />)

    expect(first.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true')
    expect(first.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(first.getByRole('button', { name: 'Side by side' }))

    expect(first.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem(FileDiffLayoutPreference.storageKeyConst)).toBe('split')
    expect([...first.container.querySelectorAll('.file-diff-split-header')].map((node) => node.textContent))
      .toEqual(['HEAD', 'Working tree'])

    const beforeTexts = [...first.container.querySelectorAll('.file-diff-split-pane--before .file-diff-text')]
      .map((node) => node.textContent)
    const afterTexts = [...first.container.querySelectorAll('.file-diff-split-pane--after .file-diff-text')]
      .map((node) => node.textContent)
    expect(beforeTexts).toEqual(['const one = 1', 'const old = 2'])
    expect(afterTexts).toEqual(['const one = 1', 'const fresh = 2'])
    expect(first.container.querySelector('[data-file-line="2"]')?.textContent).toContain('const fresh = 2')

    // Full file mode in Side by side shows both baseline and current line numbers on unchanged lines.
    fireEvent.click(first.getByRole('button', { name: 'Full file' }))
    await waitFor(() => expect(
      [...first.container.querySelectorAll('.file-diff-split-pane--before .file-diff-gutter')]
        .map((node) => node.textContent),
    ).toEqual(['1', '2', '3']))
    expect([...first.container.querySelectorAll('.file-diff-split-pane--after .file-diff-gutter')]
      .map((node) => node.textContent)).toEqual(['1', '2', '3'])

    // A freshly mounted diff view restores the chosen Side by side layout.
    first.unmount()
    const second = render(<FileDiffView data={data} currentText={currentText} language="typescript" />)
    expect(second.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true')
    expect(second.container.querySelector('.file-diff-split-panes')).not.toBeNull()
  })

  it('uses a two-column grid when wrapLines is enabled and synchronizes dual-pane scroll without snap-back', () => {
    localStorage.setItem(FileDiffLayoutPreference.storageKeyConst, 'split')
    const data = sampleDiff()
    const currentText = 'const one = 1\nconst fresh = 2\n'
    const view = render(
      <FileDiffView data={data} currentText={currentText} language="typescript" wrapLines={false} />,
    )
    const left = view.container.querySelector<HTMLDivElement>('.file-diff-split-pane--before')!
    const right = view.container.querySelector<HTMLDivElement>('.file-diff-split-pane--after')!
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()

    // Simulate right pane clamping scrollLeft at 100 while left scrolls to 250.
    let rightLeftValue = 0
    Object.defineProperty(right, 'scrollLeft', {
      configurable: true,
      get: () => rightLeftValue,
      set: (next: number) => { rightLeftValue = Math.min(100, next) },
    })
    left.scrollTop = 120
    left.scrollLeft = 250
    fireEvent.scroll(left)
    expect(right.scrollTop).toBe(120)
    expect(right.scrollLeft).toBe(100)

    // The clamped echo scroll event on right must not pull left back from 250 to 100.
    fireEvent.scroll(right)
    expect(left.scrollLeft).toBe(250)

    // Switching to wrapLines renders the shared row grid instead of separate horizontal panes.
    view.rerender(
      <FileDiffView data={data} currentText={currentText} language="typescript" wrapLines />,
    )
    expect(view.container.querySelector('.file-diff-split-grid')).not.toBeNull()
    expect(view.container.querySelector('.file-diff-split-panes')).toBeNull()
  })

  it('shows a property-only change with both values instead of only saying there are no text changes', () => {
    const data: FileDiffData = {
      status: 'modified',
      completeness: 'full',
      current: { label: 'Working tree', path: 'limit.txt', exists: true, eol: 'lf', finalNewline: true },
      baseline: { label: 'SVN BASE', path: 'limit.txt', exists: true, eol: 'lf', finalNewline: true },
      hunks: [],
      detail: null,
      properties: { changes: [
        { name: 'jamat:test', before: 'base', after: 'w1-prop-only' },
        { name: 'svn:keywords', before: null, after: 'Id' },
      ], detail: 'Values longer than 4000 characters are cut.' },
    }
    const view = render(<FileDiffView data={data} currentText={'20\n'} language="text" />)

    expect(view.getByText('No text changes.')).toBeInTheDocument()
    const panel = view.getByRole('region', { name: 'Property changes' })
    expect([...panel.querySelectorAll('tr')].map((row) => row.textContent)).toEqual([
      'PropertyChangeBASEWorking copy',
      'jamat:testchangedbasew1-prop-only',
      'svn:keywordsadded(none)Id',
    ])
    expect(panel).toHaveTextContent('Values longer than 4000 characters are cut.')
  })
})
