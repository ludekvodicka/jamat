export interface MarkdownTaskLine {
  line: number
  markerColumn: number
  checked: boolean
  text: string
  heading: string | null
}

export class MarkdownTaskLines {
  static interactive(source: string): boolean {
    const lines = source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
    const end = MarkdownTaskLines.frontmatterEnd(lines)
    return end > 0 && lines.slice(1, end).some((line) => /^jamat: *interactive *$/.test(line))
  }

  static parse(source: string): MarkdownTaskLine[] {
    return MarkdownTaskLines.scan(source).items
  }

  static headingAt(source: string, line: number): string | null {
    return MarkdownTaskLines.scan(source, line).heading
  }

  static flip(source: string, line: number, checked: boolean): string | null {
    const item = MarkdownTaskLines.parse(source).find((candidate) => candidate.line === line)
    if (!item) return null
    const lines = source.split(/(\r\n|\n|\r)/)
    const index = (line - 1) * 2
    lines[index] = lines[index]!.slice(0, item.markerColumn)
      + (checked ? 'x' : ' ') + lines[index]!.slice(item.markerColumn + 1)
    return lines.join('')
  }

  private static frontmatterEnd(lines: string[]): number {
    if (lines[0]?.replace(/^\uFEFF/, '') !== '---') return -1
    return lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
  }

  private static scan(source: string, throughLine = Infinity): { items: MarkdownTaskLine[]; heading: string | null } {
    const lines = source.split(/\r\n|\n|\r/)
    const items: MarkdownTaskLine[] = []
    const frontmatterEnd = MarkdownTaskLines.frontmatterEnd(lines)
    let heading: string | null = null
    let fence: { marker: string; length: number; quotes: number; indent: number } | null = null
    let listIndents: number[] = []
    let quoteDepth = 0
    let afterBlank = false
    for (let index = frontmatterEnd + 1; index < Math.min(lines.length, throughLine); index++) {
      const original = lines[index]!
      const prefix = MarkdownTaskLines.quotePrefix(original)
      const body = original.slice(prefix.offset)
      const indent = /^[ \t]*/.exec(body)![0].replace(/\t/g, '    ').length
      if (fence && (prefix.depth < fence.quotes || (body.trim() !== '' && indent < fence.indent)))
        fence = null
      if (fence) {
        const delimiter = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(body)
        if (delimiter && delimiter[1]![0] === fence.marker
          && delimiter[1]!.length >= fence.length && delimiter[2]!.trim() === '' && indent - fence.indent < 4)
          fence = null
        continue
      }
      if (prefix.depth !== quoteDepth) listIndents = []
      quoteDepth = prefix.depth
      const list = /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)(.*)$/.exec(body)
      const blockStart = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,})/.test(body)
      if (body.trim() !== '' && (afterBlank || list || blockStart))
        while (listIndents.length > 0 && indent < listIndents[listIndents.length - 1]!) listIndents.pop()
      afterBlank = body.trim() === ''
      const containerIndent = listIndents[listIndents.length - 1] ?? 0
      if (indent - containerIndent >= 4) continue
      if (list) listIndents.push(list[1]!.replace(/\t/g, '    ').length)
      const delimiter = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(list ? list[2]! : body)
      if (delimiter && (delimiter[1]![0] === '~' || !delimiter[2]!.includes('`'))) {
        fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length,
          quotes: prefix.depth, indent: listIndents[listIndents.length - 1] ?? 0 }
        continue
      }
      const title = /^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/.exec(body)
      if (title) heading = (title[1] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
      const task = /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[)([ xX])\](?:[ \t]+(.*)|$)/.exec(body)
      if (task)
        items.push({ line: index + 1, markerColumn: prefix.offset + task[1]!.length,
          checked: task[2]!.toLowerCase() === 'x', text: (task[3] ?? '').trim(), heading })
    }
    return { items, heading }
  }

  private static quotePrefix(line: string): { offset: number; depth: number } {
    let offset = line.startsWith('\uFEFF') ? 1 : 0
    let depth = 0
    while (offset < line.length) {
      let next = offset
      while (line[next] === ' ' || line[next] === '\t') next++
      if (line[next] !== '>') break
      offset = next + 1
      if (line[offset] === ' ' || line[offset] === '\t') offset++
      depth++
    }
    return { offset, depth }
  }
}
