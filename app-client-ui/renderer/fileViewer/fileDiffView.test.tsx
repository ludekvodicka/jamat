import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  FileDiffData,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import {
  FileDiffHighlighting,
  FileDiffView,
  FileDiffVisual,
  type FileDiffVisualLine,
} from './fileDiffView'

describe('app-client-ui/renderer/fileViewer/fileDiffView', () => {
  afterEach(cleanup)

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
    const data: FileDiffData = {
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

  it('turns structured hunks into both changes-only and full-file lines', () => {
    const data: FileDiffData = {
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
          { kind: 'context', text: 'one', beforeLine: 1, afterLine: 1 },
          { kind: 'remove', text: 'old', beforeLine: 2, afterLine: null },
          { kind: 'add', text: 'new', beforeLine: null, afterLine: 2 },
        ],
      }],
      detail: null,
    }
    expect(FileDiffVisual.changes(data).map((line) => line.kind))
      .toEqual(['context', 'remove', 'add'])
    expect(FileDiffVisual.full(data, 'one\nnew\nthree\n').map((line) => [line.kind, line.text]))
      .toEqual([
        ['context', 'one'], ['remove', 'old'], ['add', 'new'], ['context', 'three'],
      ])
    expect(FileDiffVisual.matchesCurrent(data, 'one\nstale\n')).toBe(false)
    expect(() => FileDiffVisual.full({ ...data, completeness: 'region' }, 'one\nnew\n'))
      .toThrow(/region diff/)
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
