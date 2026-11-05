import { describe, expect, it } from 'vitest'
import { FileViewerPrompts } from './fileViewerPrompts'
import type { MarkdownTaskLine } from '../../../lib-orchestrator/fileViewer/markdownTaskLines'

describe('FileViewerPrompts', () => {
  const item = { line: 9, markerColumn: 3, checked: false, heading: 'Navigation', text: 'Open the page' }

  it('builds the exact item prefix with path, line, nearest heading and text', () => {
    expect(FileViewerPrompts.askItem('C:/work/guide.md', item))
      .toBe('Mám dotaz k C:/work/guide.md:9, kapitola „Navigation“, bod „Open the page“: ')
  })

  it('omits the chapter before the first heading', () => {
    expect(FileViewerPrompts.askItem('C:/work/guide.md', { ...item, heading: null }))
      .toBe('Mám dotaz k C:/work/guide.md:9, bod „Open the page“: ')
  })

  it('normalizes newlines and removes terminal controls from every payload field', () => {
    const hostile = 'a\x1b[201~\x07\x7f\x85\x9f\r\nb\rc\td'
    expect(FileViewerPrompts.clean(hostile)).toBe('a[201~\nb\nc\td')
    const prompt = FileViewerPrompts.askSelection(hostile, 7, hostile, hostile)
    expect(prompt).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
    expect(prompt).toContain('text „a[201~ b c d“: ')
  })

  it('collapses selection whitespace and caps quoted text at 300 characters plus ellipsis', () => {
    expect(FileViewerPrompts.askSelection('C:/work/plan.md', 4, null, `  ${'x'.repeat(1000)}\r\n `))
      .toBe(`Mám dotaz k C:/work/plan.md:4, text „${'x'.repeat(300)}…“: `)
    expect(FileViewerPrompts.askSelection('C:/work/plan.md', 4, 'Title', 'one\n\ttwo'))
      .toBe('Mám dotaz k C:/work/plan.md:4, kapitola „Title“, text „one two“: ')
  })

  it('summarizes 12 of 14 confirmed and groups the two open items by heading with line numbers', () => {
    const items = Array.from({ length: 14 }, (_, index) => ({ ...item, line: index + 5, checked: index < 12,
      heading: index === 12 ? 'Search' : 'Review', text: index === 12 ? 'Find file' : 'Open result' }))
    expect(FileViewerPrompts.results('C:/work/guide.md', items)).toBe('Výsledky testu C:/work/guide.md: potvrzeno 12/14.\n'
      + 'Nepotvrzeno (neprošlo, nebo nezkoušeno):\n\n## Search\n- L17: Find file\n\n## Review\n- L18: Open result')
  })

  it('returns only the header when everything is confirmed', () => {
    expect(FileViewerPrompts.results('C:/work/guide.md', [{ ...item, checked: true }]))
      .toBe('Výsledky testu C:/work/guide.md: potvrzeno 1/1.')
  })

  it('caps 80 open items at 50 and points to the remaining 30 in the file', () => {
    const items = Array.from({ length: 80 }, (_, index) => ({ ...item, line: index + 1 }))
    const result = FileViewerPrompts.results('C:/work/guide.md', items)
    expect(result.match(/^- L/gm)).toHaveLength(50)
    expect(result).toContain('- L50: Open the page')
    expect(result).not.toContain('- L51:')
    expect(result).toMatch(/… a dalších 30, viz soubor$/)
  })

  it('groups items before the first heading and caps the summary at 4000 characters', () => {
    expect(FileViewerPrompts.results('C:/work/guide.md', [{ ...item, heading: null }]))
      .toContain('## (před první kapitolou)\n- L9: Open the page')
    const items: MarkdownTaskLine[] = Array.from({ length: 80 }, (_, index) => ({ ...item,
      line: index + 1, text: `Line ${index + 1} ${'x'.repeat(500)}` }))
    const result = FileViewerPrompts.results('C:/work/guide.md', items)
    const included = result.match(/^- L/gm)!.length
    expect(result.length).toBeLessThanOrEqual(4000)
    expect(included).toBeGreaterThan(0)
    expect(included).toBeLessThan(50)
    expect(result).toMatch(new RegExp(`… a dalších ${80 - included}, viz soubor$`))
  })
})
