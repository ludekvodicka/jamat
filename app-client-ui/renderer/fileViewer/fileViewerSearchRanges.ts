export class FileViewerSearchRanges {
  static readonly limitConst = 10_000
  private static readonly excludedConst = 'script, style, button, input, select, textarea, '
    + '[hidden], [aria-hidden="true"], .file-viewer-note, .file-viewer-error, '
    + '.file-diff-toolbar, .file-diff-detail, .file-diff-gutter, .file-diff-marker, .file-diff-hunk, '
    + '.file-hex-summary, .file-hex-offset'
  private static readonly blockConst = 'address, article, aside, blockquote, br, dd, details, div, dl, dt, '
    + 'figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, '
    + 'section, summary, table, td, th, tr, ul, .line, [data-file-line]'

  static find(root: HTMLElement, query: string): Range[] {
    if (query === '') return []
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    const ranges: Range[] = []
    let nodes: Text[] = []
    const flush = (): void => {
      if (nodes.length === 0) return
      const text = nodes.map((node) => node.data).join('')
      let nodeIndex = 0
      let nodeOffset = 0
      const point = (offset: number): { node: Text; offset: number } => {
        while (nodeIndex < nodes.length - 1 && nodeOffset + nodes[nodeIndex].length <= offset) {
          nodeOffset += nodes[nodeIndex].length
          nodeIndex++
        }
        return { node: nodes[nodeIndex], offset: offset - nodeOffset }
      }
      for (const match of text.matchAll(pattern)) {
        if (ranges.length > FileViewerSearchRanges.limitConst) break
        const start = point(match.index)
        const end = point(match.index + match[0].length)
        const range = root.ownerDocument.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        ranges.push(range)
      }
      nodes = []
    }
    const visit = (node: Node): void => {
      if (ranges.length > FileViewerSearchRanges.limitConst) return
      if (node instanceof Text) {
        if (node.length > 0) nodes.push(node)
        return
      }
      if (!(node instanceof Element)) return
      if (node.matches(FileViewerSearchRanges.excludedConst)) {
        flush()
        return
      }
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') {
        flush()
        return
      }
      const block = node.matches(FileViewerSearchRanges.blockConst)
      if (block) flush()
      for (const child of node.childNodes) visit(child)
      if (block) flush()
    }
    visit(root)
    flush()
    return ranges
  }

  static reveal(root: HTMLElement, range: Range): void {
    for (let element = range.startContainer.parentElement; element && root.contains(element);
      element = element.parentElement)
      if (element instanceof HTMLDetailsElement) element.open = true

    // A raw file can be one large text node. Scroll to the range, not the enclosing pre's top.
    for (let element = range.startContainer.parentElement; element && root.contains(element);
      element = element.parentElement) {
      const style = getComputedStyle(element)
      const vertical = /auto|scroll/.test(style.overflowY || style.overflow)
      const horizontal = /auto|scroll/.test(style.overflowX || style.overflow)
      if (!vertical && !horizontal) continue
      const match = range.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      if (vertical && element.scrollHeight > element.clientHeight)
        element.scrollTop += match.top - box.top - element.clientTop
          - (element.clientHeight - match.height) / 2
      if (horizontal && element.scrollWidth > element.clientWidth)
        element.scrollLeft += match.left - box.left - element.clientLeft
          - (element.clientWidth - match.width) / 2
    }
  }
}
