import { describe, expect, it } from 'vitest'

import { MarkdownTaskLines } from './markdownTaskLines'

describe('MarkdownTaskLines', () => {
  it('finds ordered, nested and quoted tasks with absolute lines and columns', () => {
    const source = '---\njamat: interactive\n---\n# Checks\n- [ ] First\n  * [x] Second\n1. [ ] Third\n> - [X] Fourth'
    expect(MarkdownTaskLines.parse(source)).toEqual([
      { line: 5, markerColumn: 3, checked: false, text: 'First', heading: 'Checks' },
      { line: 6, markerColumn: 5, checked: true, text: 'Second', heading: 'Checks' },
      { line: 7, markerColumn: 4, checked: false, text: 'Third', heading: 'Checks' },
      { line: 8, markerColumn: 5, checked: true, text: 'Fourth', heading: 'Checks' },
    ])
  })

  it('skips frontmatter and fences including shorter delimiters and quoted fences', () => {
    const source = '---\n- [ ] metadata\n---\n````md\n```\n- [ ] code\n````\n> ~~~~\n> - [ ] code\n> ~~~~\n- [ ] real'
    expect(MarkdownTaskLines.parse(source).map((item) => item.text)).toEqual(['real'])
    expect(MarkdownTaskLines.parse('```\n# Not a heading\n- [ ] code')).toEqual([])
  })

  it('requires the exact opt-in in leading complete frontmatter', () => {
    expect(MarkdownTaskLines.interactive('\uFEFF---\r\njamat: interactive\r\n---\r\n')).toBe(true)
    for (const source of ['jamat: interactive', '# Body\n---\njamat: interactive\n---',
      '---\njamat: interactive', '---\njamat: false\n---', '---\n  jamat: interactive\n---'])
      expect(MarkdownTaskLines.interactive(source)).toBe(false)
  })

  it.each([
    '- ```sh\n  npm test\n  ```\n\n- [ ] Real item',
    '- ~~~\n  - [ ] Code\n  ~~~\n\n- [ ] Real item',
    '- Example\n  ```sh\n  - [ ] Code\n  ```\n\n- [ ] Real item',
    '> ```\n> - [ ] Code\n\n- [ ] Real item',
    '- ```\n  - [ ] Code\n\n- [ ] Real item',
    '    ```\n    - [ ] Indented code\n\n- [ ] Real item',
  ])('keeps fence containers from swallowing following tasks: %s', (source) => {
    const tasks = MarkdownTaskLines.parse(source)
    expect(tasks.map((task) => task.text)).toEqual(['Real item'])
    expect(MarkdownTaskLines.flip(source, tasks[0]!.line, true)).toBe(source.replace('- [ ] Real item', '- [x] Real item'))
  })

  it('scans long blockquote prefixes without backtracking', () => {
    const source = '- [ ] Real item\n' + '> '.repeat(10_000) + 'ordinary text'
    expect(MarkdownTaskLines.parse(source).map((task) => task.text)).toEqual(['Real item'])
  })

  it('keeps nested tasks after a lazy list paragraph continuation', () => {
    const source = '- Parent\nlazy continuation\n    - [ ] Child'
    expect(MarkdownTaskLines.parse(source)).toEqual([
      { line: 3, markerColumn: 7, checked: false, text: 'Child', heading: null },
    ])
  })

  it('changes only the marker, preserving BOM, Unicode and every line ending', () => {
    const source = '\uFEFF---\r\njamat: interactive\r\n---\r\n# Žluťoučký\n> 1) [ ] Příliš\r'
    expect(MarkdownTaskLines.flip(source, 5, true)).toBe(source.replace('[ ]', '[x]'))
    expect(MarkdownTaskLines.flip(source, 4, true)).toBeNull()
    expect(MarkdownTaskLines.headingAt(source, 5)).toBe('Žluťoučký')
    expect(MarkdownTaskLines.headingAt('- [ ] First', 1)).toBeNull()
  })
})
