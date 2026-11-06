import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'

import { MdExtBudget } from './mdExtBudget'
import { MdExtDirectives } from './mdExtDirectives'
import { MdExtFrontmatter } from './mdExtFrontmatter'
import { MdExtSecurity } from './mdExtSecurity'
import { MdExtDiagramEngine } from './renderers/mdExtDiagramEngine'

/**
 * A Markdown document as HTML for a mail editor's paste, and as a page saved beside its source. Mail clients drop `<style>` and class
 * rules (Gmail) or render with Word (Outlook), so every look is an inline style on light colours,
 * independent of the viewer's theme. It is the viewer's parse and sanitize without its components:
 * diagrams are drawn by the viewer's engine on paper colours and inlined as SVG, images become their
 * alt text because their files do not travel, and frontmatter is left out.
 */
export class MdExtClipboardHtml {
  static readonly monospaceConst = "Consolas, 'Courier New', monospace"

  private static readonly stylesConst: readonly (readonly [string, string])[] = [
    ['table', 'border-collapse: collapse; margin: 8px 0'],
    ['th, td', 'border: 1px solid #c8c8c8; padding: 4px 8px; text-align: left; vertical-align: top'],
    ['th', 'background: #f0f0f0; font-weight: bold'],
    ['pre', `background: #f6f8fa; border: 1px solid #e1e4e8; padding: 8px; font-family: ${MdExtClipboardHtml.monospaceConst}; font-size: 10pt; white-space: pre-wrap`],
    ['code', `font-family: ${MdExtClipboardHtml.monospaceConst}; font-size: 10pt`],
    [':not(pre) > code', 'background: #f0f0f0; padding: 0 3px'],
    ['blockquote', 'border-left: 3px solid #c8c8c8; margin: 8px 0; padding: 0 12px; color: #555555'],
    ['.mdext-callout', 'border-left: 3px solid #0969da; background: #f0f6ff; margin: 8px 0; padding: 6px 12px'],
    ['.mdext-callout-warning, .mdext-callout-important', 'border-left-color: #bf8700; background: #fff8e1'],
    ['.mdext-callout-danger', 'border-left-color: #cf222e; background: #ffebe9'],
    ['.mdext-callout-tip', 'border-left-color: #1a7f37; background: #eefbf1'],
    ['.mdext-callout-title', 'font-weight: bold'],
    ['.mdext-chip', 'border-radius: 3px; padding: 0 6px; margin-right: 4px; background: #eaeef2; color: #57606a'],
    ['.mdext-chip-good', 'background: #dafbe1; color: #1a7f37'],
    ['.mdext-chip-warn', 'background: #fff8c5; color: #9a6700'],
    ['.mdext-chip-bad', 'background: #ffebe9; color: #cf222e'],
    ['.contains-task-list', 'list-style: none; padding-left: 4px'],
  ]

  static async of(source: string): Promise<string> {
    const markup = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkDirective, MdExtDirectives.plugin],
      rehypePlugins: [[rehypeSanitize, MdExtSecurity.sanitizeSchema]],
    }, MdExtFrontmatter.split(source).body))
    const document = new DOMParser().parseFromString(`<div>${markup}</div>`, 'text/html')
    const root = document.body.firstElementChild!
    await MdExtClipboardHtml.drawDiagrams(root)
    for (const [selector, style] of MdExtClipboardHtml.stylesConst)
      for (const element of root.querySelectorAll<HTMLElement>(selector))
        element.setAttribute('style', [element.getAttribute('style'), style].filter(Boolean).join('; '))
    // A mail editor drops form controls, and a closed `<details>` hides what was meant to be read.
    for (const box of root.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))
      box.replaceWith(document.createTextNode(box.checked ? '☑' : '☐'))
    for (const image of root.querySelectorAll('img'))
      image.replaceWith(document.createTextNode(image.getAttribute('alt') ? `[${image.getAttribute('alt')}]` : ''))
    for (const summary of root.querySelectorAll('summary'))
      MdExtClipboardHtml.rename(summary, 'p').setAttribute('style', 'font-weight: bold')
    for (const details of root.querySelectorAll('details'))
      MdExtClipboardHtml.rename(details, 'div')
    // Not inside a diagram: mermaid styles its SVG through classes in its own `<style>`.
    for (const element of root.querySelectorAll('[class]'))
      if (!element.closest('svg')) element.removeAttribute('class')
    return MdExtClipboardHtml.wrap(root.innerHTML)
  }

  /** Each diagram fence as its SVG; one that fails, or is past the viewer's budget, stays its source. */
  private static async drawDiagrams(root: Element): Promise<void> {
    const budget = new MdExtBudget()
    const fences = [...root.querySelectorAll('pre > code')].flatMap((code, index) => {
      const language = /language-([\w-]+)/.exec(code.className)?.[1]
      const source = (code.textContent ?? '').replace(/\n$/, '')
      return language && MdExtDiagramEngine.supports(language) && source.trim()
        && source.length <= MdExtDiagramEngine.maxSourceCharacters && budget.allowsDiagram(index)
        ? [{ pre: code.parentElement!, language, source }]
        : []
    })
    for (const fence of fences) {
      let svg: string
      try { svg = MdExtSecurity.svg(await MdExtDiagramEngine.render(fence.language, fence.source, undefined, 'paper')) }
      catch { continue }
      if (!svg) continue
      // The colour is what `currentColor` in a hand-written SVG resolves to.
      const figure = root.ownerDocument.createElement('div')
      figure.setAttribute('style', 'margin: 8px 0; color: #1f2328')
      figure.innerHTML = svg
      const drawn = figure.firstElementChild
      drawn?.setAttribute('style', [drawn.getAttribute('style'), 'max-width: 100%; height: auto'].filter(Boolean).join('; '))
      fence.pre.replaceWith(figure)
    }
  }

  /** Plain text or source code: one preformatted block, so its lines and indentation survive. */
  static preformatted(text: string): string {
    const pre = new DOMParser().parseFromString('<pre></pre>', 'text/html').querySelector('pre')!
    pre.textContent = text
    pre.setAttribute('style', `font-family: ${MdExtClipboardHtml.monospaceConst}; font-size: 10pt; white-space: pre-wrap; margin: 0`)
    return MdExtClipboardHtml.wrap(pre.outerHTML)
  }

  /** A standalone page around `of` or `preformatted`, for a file saved beside the source. */
  static page(body: string, title: string): string {
    const document = new DOMParser().parseFromString('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title></title></head><body></body></html>', 'text/html')
    document.title = title
    document.body.setAttribute('style', 'margin: 24px auto; max-width: 860px; padding: 0 16px; background: #ffffff')
    document.body.innerHTML = body
    return `<!doctype html>\n${document.documentElement.outerHTML}\n`
  }

  private static wrap(body: string): string {
    return `<div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1f2328">${body}</div>`
  }

  private static rename(element: Element, tagName: string): Element {
    const renamed = element.ownerDocument.createElement(tagName)
    renamed.append(...element.childNodes)
    element.replaceWith(renamed)
    return renamed
  }
}
