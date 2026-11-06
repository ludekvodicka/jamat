import { describe, expect, it } from 'vitest'
import { MdExtClipboardHtml } from './mdExtClipboardHtml'

const parse = (html: string): HTMLElement => new DOMParser().parseFromString(html, 'text/html').body.firstElementChild as HTMLElement

describe('MdExtClipboardHtml', () => {
  it('turns Markdown into plain HTML with inline styles and no classes', async () => {
    const root = parse(await MdExtClipboardHtml.of('---\ntitle: Hidden\n---\n# Title\n\nSome **bold** and `code`.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'))
    expect(root.getAttribute('style')).toContain('font-family')
    expect(root.textContent).not.toContain('Hidden')
    expect(root.querySelector('h1')?.textContent).toBe('Title')
    expect(root.querySelector('strong')?.textContent).toBe('bold')
    expect(root.querySelector('p > code')?.getAttribute('style')).toContain('background')
    expect(root.querySelector('td')?.getAttribute('style')).toContain('border: 1px solid')
    expect(root.querySelector('th')?.getAttribute('style')).toContain('font-weight: bold')
    expect(root.querySelector('[class]')).toBeNull()
  })

  it('writes task boxes, images and callouts the way a mail editor keeps them', async () => {
    const root = parse(await MdExtClipboardHtml.of('- [x] done\n- [ ] open\n\n![diagram](a.png)\n\n:::warning\nCareful\n:::\n'))
    expect(root.querySelector('input')).toBeNull()
    expect(root.querySelector('ul')?.textContent).toMatch(/☑ done[\s\S]*☐ open/)
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('[diagram]')
    const callout = [...root.querySelectorAll('div')].find(div => div.textContent?.includes('Careful') && div.getAttribute('style')?.includes('border-left'))
    expect(callout?.textContent).toContain('Warning')
  })

  it('keeps raw HTML in the source as text', async () => {
    const root = parse(await MdExtClipboardHtml.of('<script>alert(1)</script>\n\nText'))
    expect(root.querySelector('script')).toBeNull()
  })

  it('makes a standalone page with an escaped title', async () => {
    const page = MdExtClipboardHtml.page(await MdExtClipboardHtml.of('# Title'), 'a <b>.md')
    expect(page.startsWith('<!doctype html>\n<html>')).toBe(true)
    expect(page).toContain('<meta charset="utf-8">')
    expect(page).toContain('<title>a &lt;b&gt;.md</title>')
    expect(page).toContain('<h1>Title</h1>')
  })

  it('draws an SVG fence as the SVG itself, scaled to the page, and keeps a broken one as code', async () => {
    const root = parse(await MdExtClipboardHtml.of('```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="760" height="180" class="kept"><rect width="10" height="10" fill="currentColor"/><script>alert(1)</script></svg>\n```\n\n```svg\nnot an svg\n```\n'))
    const svg = root.querySelector('svg')
    expect(svg?.getAttribute('style')).toContain('max-width: 100%')
    expect(svg?.getAttribute('class')).toBe('kept')
    expect(svg?.querySelector('rect')).not.toBeNull()
    expect(svg?.querySelector('script')).toBeNull()
    expect(svg?.parentElement?.getAttribute('style')).toContain('color: #1f2328')
    expect(root.querySelector('pre')?.textContent).toBe('not an svg\n')
  })

  it('keeps plain text as one preformatted block, escaped', () => {
    const root = parse(MdExtClipboardHtml.preformatted('  a < b\n\tend'))
    expect(root.querySelector('pre')?.textContent).toBe('  a < b\n\tend')
    expect(root.querySelector('pre')?.getAttribute('style')).toContain('monospace')
  })
})
