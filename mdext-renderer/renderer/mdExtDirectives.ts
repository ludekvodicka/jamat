import { MdExtNames, type MdExtTone } from './mdExtNames'

interface MdExtNode {
  type: string
  name?: string
  attributes?: Record<string, string | null | undefined> | null
  value?: string
  data?: {
    directiveLabel?: boolean
    hName?: string
    hProperties?: Record<string, unknown>
    hChildren?: unknown[]
  }
  children?: MdExtNode[]
  position?: { start: { offset?: number }, end: { offset?: number } }
}

export class MdExtDirectives {
  private static readonly calloutsConst: ReadonlySet<string> = new Set(MdExtNames.calloutsConst)

  /**
   * The body as the directive parser should read it.
   *
   * A directive attribute name cannot be quoted or hold a space, so `::status{"PDF po stránkách"=ok}`
   * failed as a whole and the line showed as text. Authors write it that way anyway, so a quoted key
   * on a `::status` line outside a code fence becomes one word, `_` for each space, which the chip
   * draws as a space again. Every line keeps its place, so line numbers stay true.
   */
  static source(body: string): string {
    let fence: string | null = null
    return body.split('\n').map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (marker !== undefined) {
        if (fence === null) fence = marker
        else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null
        return line
      }
      if (fence !== null) return line
      const status = /^( {0,3}::status\{)(.*)(\}\s*)$/.exec(line)
      if (status === null) return line
      const attributes = status[2]!.replace(/(^|\s)(["'])([^"'\n]*)\2(?==)/g, (whole, space: string, _quote, key: string) => {
        const word = key.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '')
        return word ? `${space}${word}` : whole
      })
      return `${status[1]}${attributes}${status[3]}`
    }).join('\n')
  }

  static plugin(): (tree: unknown, file: { value: unknown }) => void {
    return (tree, file) => MdExtDirectives.walk(tree as MdExtNode, String(file.value))
  }

  private static walk(node: MdExtNode, source: string): void {
    if (node.type === 'containerDirective') MdExtDirectives.container(node)
    else if (node.type === 'leafDirective') MdExtDirectives.leaf(node)
    // mdext defines no text directive, and remark-directive reads any `:` before a letter or digit
    // as one (`07:09`, `/pp:work`), so each goes back to the text it was parsed from.
    if (node.children)
      node.children = node.children.map((child) => child.type === 'textDirective' ? MdExtDirectives.literal(child, source) : child)
    for (const child of node.children ?? []) MdExtDirectives.walk(child, source)
  }

  private static literal(node: MdExtNode, source: string): MdExtNode {
    const start = node.position?.start.offset, end = node.position?.end.offset
    if (start === undefined || end === undefined) throw new Error(`text directive :${node.name ?? ''} has no source position`)
    return { type: 'text', value: source.slice(start, end) }
  }

  private static container(node: MdExtNode): void {
    const name = node.name ?? ''
    if (MdExtDirectives.calloutsConst.has(name)) {
      const title: MdExtNode = {
        type: 'paragraph',
        data: { hName: 'div', hProperties: { className: ['mdext-callout-title'] } },
        children: MdExtDirectives.label(node)
          ?? [{ type: 'text', value: MdExtDirectives.capitalize(name) }],
      }
      node.children = [title, ...(node.children ?? [])]
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: { className: ['mdext-callout', `mdext-callout-${name}`], role: 'note' },
      }
    }
    else if (name === 'details') {
      const summary: MdExtNode = {
        type: 'paragraph',
        data: { hName: 'summary' },
        children: MdExtDirectives.label(node) ?? [{ type: 'text', value: 'Details' }],
      }
      node.children = [summary, ...(node.children ?? [])]
      node.data = {
        ...node.data,
        hName: 'details',
        hProperties: { className: ['mdext-details'] },
      }
    }
    else node.data = { ...node.data, hName: 'div' }
  }

  private static leaf(node: MdExtNode): void {
    if (node.name !== 'status') {
      node.data = { ...node.data, hName: 'span' }
      return
    }
    const children = Object.entries(node.attributes ?? {})
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => ({
        type: 'element',
        tagName: 'span',
        properties: { className: ['mdext-chip', `mdext-chip-${MdExtDirectives.tone(String(value))}`] },
        // A directive key cannot hold a space, so `_` stands for one.
        children: [{ type: 'text', value: `${key.replaceAll('_', ' ')}: ${value}` }],
      }))
    node.data = {
      ...node.data,
      hName: 'div',
      hProperties: { className: ['mdext-status'] },
      hChildren: children,
    }
  }

  private static label(node: MdExtNode): MdExtNode[] | null {
    const children = node.children ?? []
    const index = children.findIndex((child) => child.data?.directiveLabel)
    if (index < 0) return null
    const [label] = children.splice(index, 1)
    return label?.children ?? []
  }

  private static tone(value: string): MdExtTone {
    const normalized = value.trim().toLowerCase()
    if (/^(pass(ed|ing)?|ok|done|success|green|complete[d]?|active|yes|up|healthy)$/.test(normalized))
      return 'good'
    else if (/^(warn(ing)?|partial|medium|pending|wip|in[- ]?progress|degraded|review)$/.test(normalized))
      return 'warn'
    else if (/^(fail(ed|ing)?|error|danger|high|critical|blocked|red|down|no|stale)$/.test(normalized))
      return 'bad'
    else return 'neutral'
  }

  private static capitalize(value: string): string {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
  }
}
