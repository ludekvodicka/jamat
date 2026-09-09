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
}

export class MdExtDirectives {
  private static readonly calloutsConst: ReadonlySet<string> = new Set(MdExtNames.calloutsConst)

  static plugin(): (tree: unknown) => void {
    return (tree) => MdExtDirectives.walk(tree as unknown as MdExtNode)
  }

  private static walk(node: MdExtNode): void {
    if (node.type === 'containerDirective') MdExtDirectives.container(node)
    else if (node.type === 'leafDirective') MdExtDirectives.leaf(node)
    else if (node.type === 'textDirective') node.data = { ...node.data, hName: 'span' }
    for (const child of node.children ?? []) MdExtDirectives.walk(child)
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
        children: [{ type: 'text', value: `${key}: ${value}` }],
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
