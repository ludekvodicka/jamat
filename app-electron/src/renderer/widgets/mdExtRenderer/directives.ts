// Typed-block infrastructure (plan v2 / Unit 10) — a remark transform that converts
// `remark-directive` nodes into sanitizer-allowed hast elements with marker classes.
//
// Supported blocks (Unit 11):
//   :::note | :::tip | :::warning | :::danger | :::important   → callout box (optional [title])
//   :::details[Title]                                          → collapsible <details>
//   ::status{key=value …}                                      → colored status chips
//
// Anything else (unknown directive name) degrades gracefully to a plain element rendering its
// children, so no content is ever lost and an unrecognized block never crashes the render.
//
// SECURITY: this transform OWNS the className/role it emits — author-supplied directive attributes
// (e.g. `:::warning{.evil onclick=…}`) are NOT copied through, and `MDEXT_SANITIZE` independently
// restricts these elements to the exact `mdext-*` classes below. The marker classes here MUST stay
// in sync with the allow-list in security.ts.

import type { Node } from 'unist'

/** Minimal structural view of the mdast/directive nodes this transform touches. */
interface MdNode {
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
  children?: MdNode[]
}

const CALLOUT_TYPES = new Set(['note', 'tip', 'warning', 'danger', 'important'])

/** Classify a status value into a visual tone. Unknown values render neutral. */
function statusTone(value: string): 'good' | 'warn' | 'bad' | 'neutral' {
  const v = value.trim().toLowerCase()
  if (/^(pass(ed|ing)?|ok|done|success|green|complete[d]?|active|yes|up|healthy)$/.test(v)) return 'good'
  if (/^(warn(ing)?|partial|medium|pending|wip|in[- ]?progress|degraded|review)$/.test(v)) return 'warn'
  if (/^(fail(ed|ing)?|error|danger|high|critical|blocked|red|down|no|stale)$/.test(v)) return 'bad'
  return 'neutral'
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** Pull the `[label]` child (if any) off a container directive and return its inline children. */
function extractLabel(node: MdNode): MdNode[] | null {
  const kids = node.children ?? []
  const idx = kids.findIndex((c) => c.data?.directiveLabel)
  if (idx < 0) return null
  const [label] = kids.splice(idx, 1)
  return label.children ?? []
}

function transformContainer(node: MdNode): void {
  const name = node.name ?? ''

  if (CALLOUT_TYPES.has(name)) {
    const titleChildren = extractLabel(node) ?? [{ type: 'text', value: capitalize(name) }]
    const titleNode: MdNode = {
      type: 'paragraph',
      data: { hName: 'div', hProperties: { className: ['mdext-callout-title'] } },
      children: titleChildren,
    }
    node.children = [titleNode, ...(node.children ?? [])]
    node.data = {
      ...node.data,
      hName: 'div',
      hProperties: { className: ['mdext-callout', `mdext-callout-${name}`], role: 'note' },
    }
    return
  }

  if (name === 'details') {
    const titleChildren = extractLabel(node) ?? [{ type: 'text', value: 'Details' }]
    const summaryNode: MdNode = {
      type: 'paragraph',
      data: { hName: 'summary' },
      children: titleChildren,
    }
    node.children = [summaryNode, ...(node.children ?? [])]
    node.data = { ...node.data, hName: 'details', hProperties: { className: ['mdext-details'] } }
    return
  }

  // Unknown container → render its children as a plain block (no content loss, no crash).
  node.data = { ...node.data, hName: 'div' }
}

function transformLeaf(node: MdNode): void {
  if (node.name === 'status') {
    const attrs = node.attributes ?? {}
    const chips = Object.entries(attrs)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => ({
        type: 'element',
        tagName: 'span',
        properties: { className: ['mdext-chip', `mdext-chip-${statusTone(String(v))}`] },
        children: [{ type: 'text', value: `${k}: ${v}` }],
      }))
    node.data = {
      ...node.data,
      hName: 'div',
      hProperties: { className: ['mdext-status'] },
      hChildren: chips,
    }
    return
  }
  // Unknown leaf → render its inline children plainly.
  node.data = { ...node.data, hName: 'span' }
}

/** Depth-first walk (no external dep; the directive trees we touch are shallow). */
function walk(node: MdNode): void {
  if (node.type === 'containerDirective') transformContainer(node)
  else if (node.type === 'leafDirective') transformLeaf(node)
  else if (node.type === 'textDirective') node.data = { ...node.data, hName: 'span' }
  for (const child of node.children ?? []) walk(child)
}

/** remark plugin: rewrite directive nodes into renderable, sanitizer-allowed elements. */
export function remarkMdextDirectives() {
  return (tree: Node): void => walk(tree as unknown as MdNode)
}
